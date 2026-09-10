package controlsync

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// tokenSource obtains and caches the Agent's short-lived access token
// (spec v5 §92.3).
//
// The Agent proves possession of its P-256 private key with a signed client
// assertion. That key was generated locally at registration and has never left
// Partner infrastructure (§92.2), which is precisely why Oolix cannot
// impersonate an Agent -- and therefore why a signed report batch from an
// Agent is meaningful tamper evidence.
type tokenSource struct {
	client   *http.Client
	baseURL  string
	clientID string
	key      *ecdsa.PrivateKey
	audience string

	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

// Token returns a cached token, refreshing shortly before it expires.
func (t *tokenSource) Token(ctx context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	// Refresh 60s early: a token that expires mid-flight would fail a config
	// pull and push the Agent toward its stale grace for no reason.
	if t.token != "" && time.Now().Before(t.expiresAt.Add(-60*time.Second)) {
		return t.token, nil
	}

	assertion, err := t.buildAssertion()
	if err != nil {
		return "", fmt.Errorf("build client assertion: %w", err)
	}

	body, _ := json.Marshal(map[string]string{
		"client_id":             t.clientID,
		"client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
		"client_assertion":      assertion,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.baseURL+"/agent/v1/token", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := t.client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
		return "", fmt.Errorf("token endpoint returned %d: %s", res.StatusCode, string(msg))
	}

	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.AccessToken == "" {
		return "", fmt.Errorf("token endpoint returned no access_token")
	}

	t.token = out.AccessToken
	t.expiresAt = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	return t.token, nil
}

// buildAssertion creates the RFC 7523 client assertion Oolix verifies against
// the public key recorded at registration (§92.3).
func (t *tokenSource) buildAssertion() (string, error) {
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.ES256, Key: t.key},
		(&jose.SignerOptions{}).WithType("JWT"),
	)
	if err != nil {
		return "", err
	}

	now := time.Now()
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}

	claims := jwt.Claims{
		// RFC 7523: the client is both issuer and subject of its own assertion.
		Issuer:   t.clientID,
		Subject:  t.clientID,
		Audience: jwt.Audience{t.baseURL + "/agent/v1/token"},
		IssuedAt: jwt.NewNumericDate(now),
		// Short-lived and single-use: the jti lets Oolix reject a replay, and
		// §92.3 caps the lifetime at five minutes.
		Expiry: jwt.NewNumericDate(now.Add(2 * time.Minute)),
		ID:     base64.RawURLEncoding.EncodeToString(nonce),
	}

	return jwt.Signed(signer).Claims(claims).Serialize()
}

// AccessToken exposes the cached Agent token to other components that must
// call Oolix with the same identity (the attribution uploader, §71).
func (s *Syncer) AccessToken(ctx context.Context) (string, error) {
	return s.tokens.Token(ctx)
}
