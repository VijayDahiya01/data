// Package attribution issues opaque click tokens -- spec v5 §14.1, §71, §90.
//
// §90 is unambiguous about what a token is and is not:
//
//	"The click token is opaque. It does not contain activation_id,
//	 partner_id, placement_id, creative_id, timestamps or a nonce."
//
// So this package generates 32 cryptographically random bytes and nothing
// else. The meaning lives server-side in Oolix, keyed by SHA-256(token).
//
// The consequence for the Partner is the point: a token appearing in a Buyer's
// landing-page URL, in a referrer header or in a browser history reveals
// nothing about which Partner, segment, campaign or person produced it.
package attribution

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// TokenSize is §90's 32 random bytes.
const TokenSize = 32

// Issuer mints tokens and registers their server-side meaning with Oolix.
type Issuer struct {
	client    *http.Client
	baseURL   string
	agentID   string
	tokenFunc func(context.Context) (string, error)

	// Registration is batched: minting is on the ad-decision hot path and
	// §103 budgets p95 < 100ms for the whole decision, which a synchronous
	// round trip to Oolix would blow on its own.
	mu      sync.Mutex
	pending []pendingToken
}

type pendingToken struct {
	TokenHash         string    `json:"token_hash"`
	ActivationID      string    `json:"activation_id"`
	CreativeVersionID string    `json:"creative_version_id"`
	PlacementKey      string    `json:"placement_key"`
	IssuedAt          time.Time `json:"issued_at"`
}

// NewIssuer builds an Issuer. tokenFunc supplies the Agent access token.
func NewIssuer(client *http.Client, baseURL, agentID string, tokenFunc func(context.Context) (string, error)) *Issuer {
	return &Issuer{client: client, baseURL: baseURL, agentID: agentID, tokenFunc: tokenFunc}
}

// Issue returns a fresh opaque token and queues its metadata for upload.
//
// The RAW token is returned to the caller (and thence to the browser) exactly
// once. Only its hash is ever transmitted or stored (§71, §90).
func (i *Issuer) Issue(ctx context.Context, activationID, creativeVersionID, placementKey string) (string, error) {
	raw := make([]byte, TokenSize)
	if _, err := rand.Read(raw); err != nil {
		// Without a usable CSPRNG a token could be predictable, which would
		// let anyone forge attributable clicks. Refuse rather than degrade.
		return "", fmt.Errorf("generate click token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	i.mu.Lock()
	i.pending = append(i.pending, pendingToken{
		TokenHash:         hashToken(token),
		ActivationID:      activationID,
		CreativeVersionID: creativeVersionID,
		PlacementKey:      placementKey,
		IssuedAt:          time.Now().UTC(),
	})
	i.mu.Unlock()

	return token, nil
}

// Flush uploads queued token metadata to Oolix.
//
// On failure the batch is put BACK on the queue: a token whose metadata never
// reached Oolix is unattributable, so the Partner would deliver inventory it
// could never be paid for (§14, §19).
func (i *Issuer) Flush(ctx context.Context) error {
	i.mu.Lock()
	batch := i.pending
	i.pending = nil
	i.mu.Unlock()

	if len(batch) == 0 {
		return nil
	}

	if err := i.upload(ctx, batch); err != nil {
		i.mu.Lock()
		i.pending = append(batch, i.pending...)
		i.mu.Unlock()
		return err
	}
	return nil
}

// Pending reports the queue depth, for /readyz and §58 monitoring.
func (i *Issuer) Pending() int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return len(i.pending)
}

func (i *Issuer) upload(ctx context.Context, batch []pendingToken) error {
	access, err := i.tokenFunc(ctx)
	if err != nil {
		return err
	}

	body, err := json.Marshal(map[string]any{"tokens": batch})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		i.baseURL+"/agent/v1/attribution/tokens", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("X-Agent-Id", i.agentID)
	req.Header.Set("Content-Type", "application/json")

	res, err := i.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	io.Copy(io.Discard, res.Body)

	if res.StatusCode >= 300 {
		return fmt.Errorf("attribution token upload returned %d", res.StatusCode)
	}
	return nil
}
