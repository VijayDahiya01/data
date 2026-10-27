package source

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// googleAuth signs in to a Google API as a service account: a JWT signed with
// the account's key is exchanged for a short-lived access token, read-only
// scope, kept until a minute before it expires. Cloud Storage, BigQuery and
// Sheets all use it.
type googleAuth struct {
	sa    serviceAccount
	scope string
	http  *http.Client

	mu      sync.Mutex
	cached  string
	expires time.Time
}

func newGoogleAuth(sa serviceAccount, scope string, client *http.Client) *googleAuth {
	return &googleAuth{sa: sa, scope: scope, http: client}
}

func (g *googleAuth) token(ctx context.Context) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.cached != "" && time.Now().Before(g.expires.Add(-time.Minute)) {
		return g.cached, nil
	}
	now := time.Now()
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{
		"iss": g.sa.ClientEmail, "scope": g.scope, "aud": g.sa.TokenURI,
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	unsigned := header + "." + enc.EncodeToString(claims)
	sum := sha256.Sum256([]byte(unsigned))
	sig, err := rsa.SignPKCS1v15(rand.Reader, g.sa.rsa, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion": {unsigned + "." + enc.EncodeToString(sig)}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.sa.TokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := g.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error_description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&tok); err != nil || tok.AccessToken == "" {
		return "", fmt.Errorf("Google refused the service account (%d): %s", res.StatusCode, tok.Error)
	}
	g.cached, g.expires = tok.AccessToken, now.Add(time.Duration(tok.ExpiresIn)*time.Second)
	return g.cached, nil
}
