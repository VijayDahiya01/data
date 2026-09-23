// Package controlsync pulls signed configuration from Oolix -- spec v5 §8,
// §45, §52.4, §75, §92.3.
//
// The Agent's connection to Oolix is OUTBOUND ONLY (§2.2: "Normally
// communicates outbound to Oolix"). Oolix cannot reach into the Partner
// network, which is what lets a Partner run the Agent behind its own firewall
// with an egress allow-list (§8.1).
//
// Every manifest is verified BEFORE it enters the snapshot the decision engine
// reads (§11.2). An unverifiable manifest is dropped, never quarantined for
// later use.
package controlsync

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/oolix/partner-agent/internal/addecision"
	"github.com/oolix/partner-agent/internal/manifest"
)

// Options configures the sync loop.
type Options struct {
	APIBaseURL       string
	AgentID          string
	ClientID         string
	PartnerOrgID     string
	PrivateKey       *ecdsa.PrivateKey
	TokenAudience    string
	ManifestIssuer   string
	ManifestAudience string
	Interval         time.Duration
	StaleGrace       time.Duration
	HTTPClient       *http.Client
	Logger           *slog.Logger
}

// Syncer maintains the Agent's verified view of what it may serve.
type Syncer struct {
	opts     Options
	client   *http.Client
	log      *slog.Logger
	tokens   *tokenSource
	snapshot atomic.Pointer[addecision.ConfigSnapshot]

	jwksMu  sync.RWMutex
	jwks    *jose.JSONWebKeySet
	jwksAt  time.Time
	lastVer int
	lastErr atomic.Pointer[string]

	// Set once at start-up, before Run, so no lock is needed on the hot path.
	onSyncResult func(ok bool)

	// materialized tracks what the audience worker has already compiled, so a
	// rebuild happens when the approved rules change or the build goes stale
	// rather than on every tick (§11).
	materializedMu sync.Mutex
	materialized   map[string]materializedState
}

// New creates a Syncer. It does not start polling.
func New(opts Options) *Syncer {
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	if opts.Interval == 0 {
		opts.Interval = 30 * time.Second
	}

	s := &Syncer{opts: opts, client: client, log: log}
	s.tokens = &tokenSource{
		client:   client,
		baseURL:  opts.APIBaseURL,
		clientID: opts.ClientID,
		key:      opts.PrivateKey,
		audience: opts.TokenAudience,
	}
	// Start empty rather than nil so a decision arriving before the first sync
	// gets a clean NO_AD rather than a nil dereference.
	s.snapshot.Store(&addecision.ConfigSnapshot{
		KilledPlacementKeys:  map[string]bool{},
		KilledActivationIDs:  map[string]bool{},
		RevokedActivationIDs: map[string]bool{},
	})
	return s
}

// Snapshot returns the current verified configuration.
func (s *Syncer) Snapshot() *addecision.ConfigSnapshot { return s.snapshot.Load() }

// LastError returns the most recent sync failure, for /readyz and §58.
func (s *Syncer) LastError() string {
	if p := s.lastErr.Load(); p != nil {
		return *p
	}
	return ""
}

// ConfigAge reports how long since a successful sync, for the §78.2 alert.
func (s *Syncer) ConfigAge() time.Duration {
	snap := s.snapshot.Load()
	if snap == nil || snap.FetchedAt.IsZero() {
		return time.Duration(1<<62 - 1)
	}
	return time.Since(snap.FetchedAt)
}

// OnSyncResult, if set, is called after every check-in attempt.
//
// A callback rather than an import of the metrics package: how the Agent
// reports itself is not this file's concern, and a Partner embedding the
// syncer elsewhere should not inherit an exposition format along with it.
func (s *Syncer) OnSyncResult(fn func(ok bool)) {
	s.onSyncResult = fn
}

func (s *Syncer) recordSync(ok bool) {
	if s.onSyncResult != nil {
		s.onSyncResult(ok)
	}
}

// Run polls until the context is cancelled (§75: every 30 seconds).
func (s *Syncer) Run(ctx context.Context) {
	// Sync immediately so a restarted Agent does not serve NO_AD for a whole
	// interval before it has any config.
	if err := s.Sync(ctx); err != nil {
		s.recordSync(false)
		s.log.Warn("initial control sync failed", "error", err.Error())
	} else {
		s.recordSync(true)
	}

	ticker := time.NewTicker(s.opts.Interval)
	defer ticker.Stop()

	heartbeat := time.NewTicker(60 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.Sync(ctx); err != nil {
				s.recordSync(false)
				// A failed sync is NOT fatal: §75 lets the Agent keep serving
				// its cached manifests until the stale grace elapses, which is
				// the whole point of the offline cache.
				s.log.Warn("control sync failed; serving from cache",
					"error", err.Error(),
					"config_age_seconds", int(s.ConfigAge().Seconds()))
			} else {
				s.recordSync(true)
			}
		case <-heartbeat.C:
			if err := s.sendHeartbeat(ctx); err != nil {
				s.log.Warn("heartbeat failed", "error", err.Error())
			}
		}
	}
}

// Sync fetches, verifies and installs a new configuration snapshot.
func (s *Syncer) Sync(ctx context.Context) error {
	if err := s.refreshJWKS(ctx); err != nil {
		return fmt.Errorf("refresh jwks: %w", err)
	}

	bundle, err := s.pull(ctx)
	if err != nil {
		msg := err.Error()
		s.lastErr.Store(&msg)
		return err
	}

	now := time.Now().UTC()
	s.jwksMu.RLock()
	jwks := s.jwks
	s.jwksMu.RUnlock()

	creatives := make(map[string]addecision.Creative, len(bundle.Creatives))
	for _, c := range bundle.Creatives {
		creatives[c.CreativeVersionID] = addecision.Creative{
			CreativeVersionID: c.CreativeVersionID,
			Format:            c.Type,
			Headline:          c.Headline,
			Body:              c.Body,
			CTA:               c.CTA,
			AssetURL:          c.AssetURL,
			Width:             c.Width,
			Height:            c.Height,
			LegalDisclaimer:   c.LegalDisclaimer,
			DestinationURL:    c.DestinationURL,
		}
	}

	candidates := make([]addecision.Candidate, 0, len(bundle.Manifests))
	rejected := 0
	for _, compact := range bundle.Manifests {
		payload, err := manifest.Verify(compact, jwks, manifest.VerifyOptions{
			Issuer:       s.opts.ManifestIssuer,
			Audience:     s.opts.ManifestAudience,
			PartnerOrgID: s.opts.PartnerOrgID,
			Now:          now,
		})
		if err != nil {
			// §11.2: an unverifiable manifest is DROPPED. It is never cached
			// "just in case", and the Agent does not fall back to a previous
			// version of it.
			rejected++
			s.log.Error("rejected manifest during control sync", "error", err.Error())
			continue
		}

		own := make(map[string]addecision.Creative, len(payload.CreativeVersionIDs))
		for _, id := range payload.CreativeVersionIDs {
			if c, ok := creatives[id]; ok {
				own[id] = c
			}
		}

		candidates = append(candidates, addecision.Candidate{
			Manifest:  payload,
			Creatives: own,
			Priority:  0,
		})
	}

	killAll := false
	killedPlacements := map[string]bool{}
	killedActivations := map[string]bool{}
	for _, k := range bundle.KillSwitches {
		switch k.Scope {
		case "PARTNER_ALL", "AGENT":
			killAll = true
		case "PLACEMENT":
			if k.TargetID != nil {
				killedPlacements[*k.TargetID] = true
			}
		case "ACTIVATION":
			if k.TargetID != nil {
				killedActivations[*k.TargetID] = true
			}
		}
	}

	revoked := map[string]bool{}
	for _, id := range bundle.RevokedActivationIDs {
		revoked[id] = true
	}

	s.snapshot.Store(&addecision.ConfigSnapshot{
		Candidates:           candidates,
		FetchedAt:            now,
		KillSwitchAll:        killAll,
		KilledPlacementKeys:  killedPlacements,
		KilledActivationIDs:  killedActivations,
		RevokedActivationIDs: revoked,
	})

	empty := ""
	s.lastErr.Store(&empty)

	if bundle.ConfigVersion != s.lastVer {
		s.log.Info("control config updated",
			"config_version", bundle.ConfigVersion,
			"manifests_accepted", len(candidates),
			"manifests_rejected", rejected,
			"kill_switch_all", killAll)
		s.lastVer = bundle.ConfigVersion
		if err := s.ack(ctx, bundle.ConfigVersion); err != nil {
			s.log.Warn("config ack failed", "error", err.Error())
		}
	}

	return nil
}

// --- wire types -----------------------------------------------------------

type creativeDTO struct {
	CreativeVersionID string `json:"creative_version_id"`
	Type              string `json:"type"`
	AssetURL          string `json:"asset_url"`
	ContentSHA256     string `json:"content_sha256"`
	Width             int    `json:"width"`
	Height            int    `json:"height"`
	Headline          string `json:"headline"`
	Body              string `json:"body"`
	CTA               string `json:"cta"`
	DestinationURL    string `json:"destination_url"`
	LegalDisclaimer   string `json:"legal_disclaimer"`
}

type killSwitchDTO struct {
	Scope    string  `json:"scope"`
	TargetID *string `json:"target_id"`
}

type bundleDTO struct {
	ConfigVersion        int             `json:"config_version"`
	IssuedAt             string          `json:"issued_at"`
	PartnerOrgID         string          `json:"partner_org_id"`
	Manifests            []string        `json:"manifests"`
	Creatives            []creativeDTO   `json:"creatives"`
	RevokedActivationIDs []string        `json:"revoked_activation_ids"`
	KillSwitches         []killSwitchDTO `json:"kill_switches"`
	StaleGraceSeconds    int             `json:"stale_grace_seconds"`
}

func (s *Syncer) pull(ctx context.Context) (*bundleDTO, error) {
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return nil, fmt.Errorf("agent token: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		s.opts.APIBaseURL+"/agent/v1/config/pull", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Agent-Id", s.opts.AgentID)

	res, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return nil, fmt.Errorf("config pull returned %d: %s", res.StatusCode, string(body))
	}

	var bundle bundleDTO
	if err := json.NewDecoder(res.Body).Decode(&bundle); err != nil {
		return nil, fmt.Errorf("decode config bundle: %w", err)
	}
	return &bundle, nil
}

func (s *Syncer) ack(ctx context.Context, version int) error {
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]int{"config_version": version})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.opts.APIBaseURL+"/agent/v1/config/ack", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Agent-Id", s.opts.AgentID)
	req.Header.Set("Content-Type", "application/json")

	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	io.Copy(io.Discard, res.Body)
	return nil
}

func (s *Syncer) sendHeartbeat(ctx context.Context) error {
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]any{
		"agent_version":      Version,
		"config_age_seconds": int(s.ConfigAge().Seconds()),
		"status":             "HEALTHY",
		"sent_at":            time.Now().UTC().Format(time.RFC3339),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.opts.APIBaseURL+"/agent/v1/heartbeat", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Agent-Id", s.opts.AgentID)
	req.Header.Set("Content-Type", "application/json")

	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	io.Copy(io.Discard, res.Body)
	return nil
}

// refreshJWKS fetches the manifest verification keys.
//
// Cached for five minutes: §75 requires the Agent to cache them, and a
// rotation publishes the new key BEFORE the signer switches, so a five-minute
// window cannot miss a correctly-sequenced rotation.
func (s *Syncer) refreshJWKS(ctx context.Context) error {
	s.jwksMu.RLock()
	fresh := s.jwks != nil && time.Since(s.jwksAt) < 5*time.Minute
	s.jwksMu.RUnlock()
	if fresh {
		return nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		s.opts.APIBaseURL+"/.well-known/oolix-manifest-jwks.json", nil)
	if err != nil {
		return err
	}
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("jwks returned %d", res.StatusCode)
	}

	var set jose.JSONWebKeySet
	if err := json.NewDecoder(res.Body).Decode(&set); err != nil {
		return err
	}
	if len(set.Keys) == 0 {
		return fmt.Errorf("jwks contained no keys")
	}

	s.jwksMu.Lock()
	s.jwks = &set
	s.jwksAt = time.Now()
	s.jwksMu.Unlock()
	return nil
}

// Version is the Agent build version reported to Oolix (§80).
var Version = "0.1.0"
