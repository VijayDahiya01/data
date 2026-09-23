package controlsync

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"

	"github.com/oolix/partner-agent/internal/manifest"
)

// Control sync is the Agent's ONLY source of authority -- §11.2, §24, §75.
//
// Everything the Agent is allowed to do arrives here, signed. So the failures
// that matter are the ones where it accepts something it should not, or throws
// away something it should have kept:
//
//   - A forged or expired manifest that is accepted becomes an advert served
//     for a campaign nobody approved.
//   - A manifest belonging to a DIFFERENT Partner that is accepted means one
//     Partner serving another's campaign.
//   - A kill switch that is not applied means serving continues after somebody
//     pressed stop.
//   - And in the other direction: a failed pull that WIPES the snapshot takes a
//     healthy Partner off the air because Oolix had a bad minute. §75 wants the
//     last good config kept until the stale grace runs out, not discarded.

const (
	testIssuer   = "https://api.oolix.test"
	testAudience = "oolix-partner-agent"
	testPartner  = "22222222-2222-4222-8222-222222222222"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// --- signing ---------------------------------------------------------------

type signingKey struct {
	priv *ecdsa.PrivateKey
	jwks *jose.JSONWebKeySet
}

func newSigningKey(t *testing.T, kid string) signingKey {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return signingKey{
		priv: priv,
		jwks: &jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
			{Key: priv.Public(), KeyID: kid, Algorithm: string(jose.ES256), Use: "sig"},
		}},
	}
}

func validPayload() manifest.Payload {
	now := time.Now().UTC()
	return manifest.Payload{
		ManifestVersion:    1,
		ActivationID:       "act_1",
		PartnerOrgID:       testPartner,
		SegmentID:          "seg_1",
		SegmentKey:         "RECENT_TRAVELLER_60D",
		Channel:            "PARTNER_WEB",
		PlacementIDs:       []string{"pl_1"},
		PlacementKeys:      []string{"booking_success_offer"},
		CreativeVersionIDs: []string{"crv_10"},
		Budget: manifest.Budget{
			AllocationMinor:   "30000000",
			Currency:          "INR",
			LocalStopFraction: 0.98,
		},
		FrequencyCap:      manifest.FrequencyCap{MaxImpressions: 2, Window: "P1D"},
		PurposeID:         "travel_insurance_offer",
		PolicyVersion:     "P-21",
		CampaignCategory:  "insurance",
		IssuedAt:          now.Add(-time.Minute),
		ConfigExpiresAt:   now.Add(15 * time.Minute),
		StartAt:           now.Add(-time.Hour),
		EndAt:             now.Add(30 * 24 * time.Hour),
		ApprovalReference: "apr_1",
	}
}

func signWith(t *testing.T, k signingKey, kid string, p manifest.Payload) string {
	t.Helper()
	opts := (&jose.SignerOptions{}).
		WithType(jose.ContentType(manifest.JWSType)).
		WithHeader("kid", kid).
		WithHeader("iss", testIssuer).
		WithHeader("aud", testAudience)

	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: k.priv}, opts)
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}
	encoded, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	jws, err := signer.Sign(encoded)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	compact, err := jws.CompactSerialize()
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	return compact
}

// --- a stand-in Oolix ------------------------------------------------------

type fakeOolix struct {
	mu sync.Mutex

	jwks   *jose.JSONWebKeySet
	bundle bundleDTO

	pullStatus int  // non-zero overrides a successful pull
	jwksFails  bool // the JWKS endpoint errors
	tokenFails bool

	pulls  int
	acks   []int
	server *httptest.Server
}

func newFakeOolix(t *testing.T, jwks *jose.JSONWebKeySet) *fakeOolix {
	t.Helper()
	f := &fakeOolix{jwks: jwks}
	mux := http.NewServeMux()

	mux.HandleFunc("POST /agent/v1/token", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		fails := f.tokenFails
		f.mu.Unlock()
		if fails {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "test-access-token",
			"expires_in":   3600,
		})
	})

	mux.HandleFunc("GET /.well-known/oolix-manifest-jwks.json", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		fails, keys := f.jwksFails, f.jwks
		f.mu.Unlock()
		if fails {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(keys)
	})

	mux.HandleFunc("GET /agent/v1/config/pull", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.pulls++
		status, bundle := f.pullStatus, f.bundle
		f.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"unavailable"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(bundle)
	})

	mux.HandleFunc("POST /agent/v1/config/ack", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ConfigVersion int `json:"config_version"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.acks = append(f.acks, body.ConfigVersion)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("POST /agent/v1/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeOolix) setBundle(b bundleDTO) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bundle = b
}

func (f *fakeOolix) breakPull(status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pullStatus = status
}

func (f *fakeOolix) pullCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pulls
}

func (f *fakeOolix) ackedVersions() []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int(nil), f.acks...)
}

func syncerFor(t *testing.T, f *fakeOolix) *Syncer {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("agent key: %v", err)
	}
	return New(Options{
		APIBaseURL:       f.server.URL,
		AgentID:          "agent-1",
		ClientID:         "client-1",
		PartnerOrgID:     testPartner,
		PrivateKey:       priv,
		ManifestIssuer:   testIssuer,
		ManifestAudience: testAudience,
		StaleGrace:       time.Hour,
		HTTPClient:       f.server.Client(),
		Logger:           quiet(),
	})
}

// --- what must be accepted -------------------------------------------------

func TestAValidManifestBecomesServable(t *testing.T) {
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	f.setBundle(bundleDTO{
		ConfigVersion: 7,
		Manifests:     []string{signWith(t, k, "kid-1", validPayload())},
		Creatives: []creativeDTO{
			{CreativeVersionID: "crv_10", Type: "NATIVE_CARD", Headline: "Protect your trip"},
		},
	})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("sync: %v", err)
	}

	snap := s.Snapshot()
	if len(snap.Candidates) != 1 {
		t.Fatalf("candidates = %d; want 1", len(snap.Candidates))
	}
	if snap.Candidates[0].Manifest.ActivationID != "act_1" {
		t.Errorf("activation = %q", snap.Candidates[0].Manifest.ActivationID)
	}
	if _, ok := snap.Candidates[0].Creatives["crv_10"]; !ok {
		t.Error("the manifest's creative was not attached")
	}
	if s.LastError() != "" {
		t.Errorf("LastError = %q after a good sync", s.LastError())
	}
}

func TestOnlyTheManifestsOwnCreativesAreAttached(t *testing.T) {
	// A manifest names the creative versions it was approved for (§70). If the
	// bundle's creatives were attached wholesale, an activation could serve a
	// creative that a Partner approved for a DIFFERENT campaign.
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	f.setBundle(bundleDTO{
		ConfigVersion: 1,
		Manifests:     []string{signWith(t, k, "kid-1", validPayload())},
		Creatives: []creativeDTO{
			{CreativeVersionID: "crv_10", Type: "NATIVE_CARD"},
			{CreativeVersionID: "crv_99", Type: "NATIVE_CARD"}, // not in the manifest
		},
	})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("sync: %v", err)
	}

	got := s.Snapshot().Candidates[0].Creatives
	if _, leaked := got["crv_99"]; leaked {
		t.Error("a creative the manifest does not name was attached to it")
	}
	if len(got) != 1 {
		t.Errorf("attached %d creatives; want only the one named", len(got))
	}
}

// --- what must be refused --------------------------------------------------

func TestAManifestSignedByAnUnknownKeyIsDropped(t *testing.T) {
	// The forgery case. Oolix publishes the JWKS; anything signed by a key not
	// in it is an advert nobody approved.
	real := newSigningKey(t, "kid-1")
	attacker := newSigningKey(t, "kid-1") // same kid, different key
	f := newFakeOolix(t, real.jwks)
	f.setBundle(bundleDTO{
		ConfigVersion: 1,
		Manifests:     []string{signWith(t, attacker, "kid-1", validPayload())},
	})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if n := len(s.Snapshot().Candidates); n != 0 {
		t.Fatalf("%d forged manifest(s) accepted", n)
	}
}

func TestAManifestForAnotherPartnerIsDropped(t *testing.T) {
	// One Partner must never serve another's campaign, even though both
	// manifests are signed by the same genuine Oolix key.
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)

	other := validPayload()
	other.PartnerOrgID = "33333333-3333-4333-8333-333333333333"
	f.setBundle(bundleDTO{ConfigVersion: 1, Manifests: []string{signWith(t, k, "kid-1", other)}})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if n := len(s.Snapshot().Candidates); n != 0 {
		t.Fatalf("accepted %d manifest(s) belonging to another Partner", n)
	}
}

func TestAnExpiredManifestIsDropped(t *testing.T) {
	// §75: past config_expires_at the Agent must stop serving rather than
	// guess. The activation may already have been revoked upstream.
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)

	stale := validPayload()
	stale.IssuedAt = time.Now().UTC().Add(-2 * time.Hour)
	stale.ConfigExpiresAt = time.Now().UTC().Add(-time.Hour)
	f.setBundle(bundleDTO{ConfigVersion: 1, Manifests: []string{signWith(t, k, "kid-1", stale)}})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if n := len(s.Snapshot().Candidates); n != 0 {
		t.Fatalf("accepted %d expired manifest(s)", n)
	}
}

func TestOneBadManifestDoesNotDiscardTheGoodOnes(t *testing.T) {
	// A single corrupt entry must not take a Partner's whole inventory down.
	k := newSigningKey(t, "kid-1")
	other := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)

	second := validPayload()
	second.ActivationID = "act_2"

	f.setBundle(bundleDTO{
		ConfigVersion: 1,
		Manifests: []string{
			signWith(t, other, "kid-1", validPayload()), // forged
			signWith(t, k, "kid-1", second),             // genuine
			"not-a-jws-at-all",                          // garbage
		},
	})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("sync: %v", err)
	}
	snap := s.Snapshot()
	if len(snap.Candidates) != 1 {
		t.Fatalf("candidates = %d; want the one genuine manifest", len(snap.Candidates))
	}
	if snap.Candidates[0].Manifest.ActivationID != "act_2" {
		t.Errorf("kept %q; want act_2", snap.Candidates[0].Manifest.ActivationID)
	}
}

// --- kill switches ---------------------------------------------------------

func TestKillSwitchScopesLandInTheRightPlace(t *testing.T) {
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	pl, act := "booking_success_offer", "act_1"
	f.setBundle(bundleDTO{
		ConfigVersion: 1,
		Manifests:     []string{signWith(t, k, "kid-1", validPayload())},
		KillSwitches: []killSwitchDTO{
			{Scope: "PLACEMENT", TargetID: &pl},
			{Scope: "ACTIVATION", TargetID: &act},
		},
	})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("sync: %v", err)
	}
	snap := s.Snapshot()
	if snap.KillSwitchAll {
		t.Error("a scoped kill switch stopped everything")
	}
	if !snap.KilledPlacementKeys[pl] {
		t.Error("the placement kill switch was not applied")
	}
	if !snap.KilledActivationIDs[act] {
		t.Error("the activation kill switch was not applied")
	}
}

func TestAPartnerWideKillSwitchStopsEverything(t *testing.T) {
	// §24: this is the button a Partner presses when something is wrong. It
	// has to mean everything, immediately.
	for _, scope := range []string{"PARTNER_ALL", "AGENT"} {
		k := newSigningKey(t, "kid-1")
		f := newFakeOolix(t, k.jwks)
		f.setBundle(bundleDTO{
			ConfigVersion: 1,
			Manifests:     []string{signWith(t, k, "kid-1", validPayload())},
			KillSwitches:  []killSwitchDTO{{Scope: scope}},
		})

		s := syncerFor(t, f)
		if err := s.Sync(context.Background()); err != nil {
			t.Fatalf("sync: %v", err)
		}
		if !s.Snapshot().KillSwitchAll {
			t.Errorf("scope %q did not stop serving", scope)
		}
	}
}

func TestAScopedKillSwitchWithNoTargetDoesNotStopEverything(t *testing.T) {
	// A malformed row must fail in the harmless direction. Turning a
	// targetless PLACEMENT switch into a partner-wide stop would take a
	// Partner off the air over a bad database row.
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	f.setBundle(bundleDTO{
		ConfigVersion: 1,
		Manifests:     []string{signWith(t, k, "kid-1", validPayload())},
		KillSwitches:  []killSwitchDTO{{Scope: "PLACEMENT", TargetID: nil}},
	})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("sync: %v", err)
	}
	snap := s.Snapshot()
	if snap.KillSwitchAll {
		t.Error("a targetless placement switch became a partner-wide stop")
	}
	if len(snap.KilledPlacementKeys) != 0 {
		t.Errorf("killed %d placements from a targetless switch", len(snap.KilledPlacementKeys))
	}
}

func TestRevokedActivationsAreCarried(t *testing.T) {
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	f.setBundle(bundleDTO{
		ConfigVersion:        1,
		Manifests:            []string{signWith(t, k, "kid-1", validPayload())},
		RevokedActivationIDs: []string{"act_1"},
	})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if !s.Snapshot().RevokedActivationIDs["act_1"] {
		t.Error("a revoked activation was not carried into the snapshot")
	}
}

// --- failing safe ----------------------------------------------------------

func TestAFailedPullKeepsTheLastGoodConfig(t *testing.T) {
	// §75: the Agent serves the last verified config until the stale grace
	// runs out. Wiping it on a transient 503 would take a healthy Partner off
	// the air because Oolix had a bad minute -- and §12.1's whole point is that
	// the Partner keeps serving without Oolix in the request path.
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	f.setBundle(bundleDTO{ConfigVersion: 1, Manifests: []string{signWith(t, k, "kid-1", validPayload())}})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("first sync: %v", err)
	}
	before := s.Snapshot()

	f.breakPull(http.StatusServiceUnavailable)
	if err := s.Sync(context.Background()); err == nil {
		t.Fatal("expected the failed pull to surface an error")
	}

	after := s.Snapshot()
	if len(after.Candidates) != 1 {
		t.Fatalf("candidates = %d after a failed pull; the config was wiped", len(after.Candidates))
	}
	if !after.FetchedAt.Equal(before.FetchedAt) {
		t.Error("FetchedAt moved on a failed pull -- staleness would never trigger")
	}
	if s.LastError() == "" {
		t.Error("LastError is empty after a failed pull; /readyz would look healthy")
	}
}

func TestAFailedJWKSFetchDoesNotWipeTheConfigEither(t *testing.T) {
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	f.setBundle(bundleDTO{ConfigVersion: 1, Manifests: []string{signWith(t, k, "kid-1", validPayload())}})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("first sync: %v", err)
	}

	// Force a refetch by expiring the cache, then break the endpoint.
	s.jwksMu.Lock()
	s.jwksAt = time.Now().Add(-10 * time.Minute)
	s.jwksMu.Unlock()
	f.mu.Lock()
	f.jwksFails = true
	f.mu.Unlock()

	if err := s.Sync(context.Background()); err == nil {
		t.Fatal("expected a JWKS failure to surface")
	}
	if len(s.Snapshot().Candidates) != 1 {
		t.Error("a JWKS outage discarded the verified config")
	}
}

func TestATokenOutageIsSurvivedWhileTheCachedTokenIsStillValid(t *testing.T) {
	// Worth pinning because it is the resilient behaviour, and easy to lose in
	// a refactor: §92.3 tokens are cached until shortly before they expire, so
	// Oolix's token endpoint going down does NOT immediately stop a Partner
	// serving. The Agent carries on with the credential it already holds.
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	f.setBundle(bundleDTO{ConfigVersion: 1, Manifests: []string{signWith(t, k, "kid-1", validPayload())}})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("first sync: %v", err)
	}

	f.mu.Lock()
	f.tokenFails = true
	f.mu.Unlock()

	if err := s.Sync(context.Background()); err != nil {
		t.Errorf("a token endpoint outage broke a sync that had a valid cached token: %v", err)
	}
	if len(s.Snapshot().Candidates) != 1 {
		t.Error("the verified config was lost")
	}
}

func TestARefusedTokenRefreshDoesNotWipeTheConfig(t *testing.T) {
	// And the case that does bite: the cached token has aged out AND the
	// endpoint refuses to issue another. That is a real outage -- but it must
	// not take the Partner off the air any faster than the stale grace says,
	// and it must show up in /readyz rather than passing silently.
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	f.setBundle(bundleDTO{ConfigVersion: 1, Manifests: []string{signWith(t, k, "kid-1", validPayload())}})

	s := syncerFor(t, f)
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("first sync: %v", err)
	}
	pullsBefore := f.pullCount()

	// Age the cached credential out, then refuse to renew it.
	s.tokens.mu.Lock()
	s.tokens.expiresAt = time.Now().Add(-time.Minute)
	s.tokens.mu.Unlock()
	f.mu.Lock()
	f.tokenFails = true
	f.mu.Unlock()

	if err := s.Sync(context.Background()); err == nil {
		t.Fatal("expected a refused token refresh to surface")
	}
	if len(s.Snapshot().Candidates) != 1 {
		t.Error("a refused token refresh discarded the verified config")
	}
	if f.pullCount() != pullsBefore {
		t.Error("the config pull was attempted without a usable token")
	}
	if s.LastError() == "" {
		t.Error("LastError is empty; /readyz would not show the credential failure")
	}
}

func TestConfigAgeIsHugeBeforeTheFirstSync(t *testing.T) {
	// A brand new Agent must read as stale, not as fresh. Reporting age zero
	// would let it serve on an empty config during the window before its first
	// successful pull.
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	s := syncerFor(t, f)

	if s.ConfigAge() < 24*time.Hour {
		t.Errorf("ConfigAge = %v before any sync; want effectively infinite", s.ConfigAge())
	}
	if snap := s.Snapshot(); snap == nil {
		t.Fatal("Snapshot() is nil before the first sync -- a decision would panic")
	}
	if len(s.Snapshot().Candidates) != 0 {
		t.Error("a fresh Agent already has something to serve")
	}
}

// --- acking ----------------------------------------------------------------

func TestANewConfigVersionIsAckedExactlyOnce(t *testing.T) {
	// §75: the ack is how Oolix knows the Agent picked the config up. Acking
	// every poll would make the ops dashboard useless; never acking would make
	// a healthy Agent look stuck.
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	f.setBundle(bundleDTO{ConfigVersion: 5, Manifests: []string{signWith(t, k, "kid-1", validPayload())}})

	s := syncerFor(t, f)
	for i := 0; i < 3; i++ {
		if err := s.Sync(context.Background()); err != nil {
			t.Fatalf("sync %d: %v", i, err)
		}
	}
	if got := f.ackedVersions(); len(got) != 1 || got[0] != 5 {
		t.Errorf("acked %v; want exactly [5]", got)
	}

	f.setBundle(bundleDTO{ConfigVersion: 6, Manifests: []string{signWith(t, k, "kid-1", validPayload())}})
	if err := s.Sync(context.Background()); err != nil {
		t.Fatalf("sync after version bump: %v", err)
	}
	if got := f.ackedVersions(); len(got) != 2 || got[1] != 6 {
		t.Errorf("acked %v; want [5 6]", got)
	}
}

func TestTheSyncResultCallbackReportsBothOutcomes(t *testing.T) {
	// This is what feeds the §78.2 metric. A callback that only ever fires on
	// success makes an Agent that cannot reach Oolix look idle rather than
	// broken.
	k := newSigningKey(t, "kid-1")
	f := newFakeOolix(t, k.jwks)
	f.setBundle(bundleDTO{ConfigVersion: 1, Manifests: []string{signWith(t, k, "kid-1", validPayload())}})

	s := syncerFor(t, f)
	var results []bool
	s.OnSyncResult(func(ok bool) { results = append(results, ok) })

	s.recordSync(s.Sync(context.Background()) == nil)
	f.breakPull(http.StatusBadGateway)
	s.recordSync(s.Sync(context.Background()) == nil)

	if len(results) != 2 || !results[0] || results[1] {
		t.Errorf("results = %v; want [true false]", results)
	}
}
