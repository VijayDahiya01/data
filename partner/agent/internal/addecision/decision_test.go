package addecision

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/connector"
	"github.com/oolix/partner-agent/internal/manifest"
	"github.com/oolix/partner-agent/internal/state"
)

// --- test doubles ---------------------------------------------------------

type fakeConnector struct {
	members  map[string]bool // "user|segment"
	consent  map[string]bool // "user|purpose"
	failWith error
	calls    int
}

func (f *fakeConnector) IsMember(_ context.Context, user, segment string) (bool, error) {
	f.calls++
	if f.failWith != nil {
		return false, f.failWith
	}
	return f.members[user+"|"+segment], nil
}

func (f *fakeConnector) IsAdvertisingEligible(_ context.Context, user, purpose string) (bool, error) {
	if f.failWith != nil {
		return false, f.failWith
	}
	v, ok := f.consent[user+"|"+purpose]
	if !ok {
		return true, nil
	}
	return v, nil
}

func (f *fakeConnector) Health(context.Context) error { return nil }
func (f *fakeConnector) Close()                       {}

type fakeTokens struct {
	issued int
	fail   bool
}

func (f *fakeTokens) Issue(context.Context, string, string, string) (string, error) {
	if f.fail {
		return "", errors.New("token service down")
	}
	f.issued++
	return "opaque-token-value", nil
}

// --- fixtures -------------------------------------------------------------

const (
	userEligible  = "U123" // §91: member of RECENT_TRAVELLER_60D
	userNotMember = "U456" // §91: member of nothing
	segmentKey    = "RECENT_TRAVELLER_60D"
	purposeID     = "travel_insurance_offer"
	placementKey  = "booking_success_offer"
	activationID  = "act_a_web"
	partnerOrgID  = "org_partner_a"
	creativeID    = "crv_10"
)

func testManifest(mutate func(*manifest.Payload)) *manifest.Payload {
	now := time.Now().UTC()
	m := &manifest.Payload{
		ManifestVersion:    1,
		ActivationID:       activationID,
		PartnerOrgID:       partnerOrgID,
		SegmentID:          "seg_1",
		SegmentKey:         segmentKey,
		Channel:            "PARTNER_WEB",
		PlacementIDs:       []string{"pl_1"},
		PlacementKeys:      []string{placementKey},
		CreativeVersionIDs: []string{creativeID},
		Budget: manifest.Budget{
			AllocationMinor:   "30000000",
			Currency:          "INR",
			LocalStopFraction: 0.98,
		},
		FrequencyCap:      manifest.FrequencyCap{MaxImpressions: 2, Window: "P1D"},
		PurposeID:         purposeID,
		PolicyVersion:     "P-21",
		AllowedCategories: []string{"insurance"},
		CampaignCategory:  "insurance",
		IssuedAt:          now.Add(-time.Minute),
		ConfigExpiresAt:   now.Add(15 * time.Minute),
		StartAt:           now.Add(-time.Hour),
		EndAt:             now.Add(30 * 24 * time.Hour),
		ApprovalReference: "apr_1",
	}
	if mutate != nil {
		mutate(m)
	}
	return m
}

func testSnapshot(m *manifest.Payload) *ConfigSnapshot {
	return &ConfigSnapshot{
		Candidates: []Candidate{{
			Manifest: m,
			Creatives: map[string]Creative{
				creativeID: {
					CreativeVersionID: creativeID,
					Format:            "NATIVE_CARD",
					Headline:          "Protect your trip",
					DestinationURL:    "https://insurance.example/quote",
				},
			},
		}},
		FetchedAt:            time.Now().UTC(),
		KilledPlacementKeys:  map[string]bool{},
		KilledActivationIDs:  map[string]bool{},
		RevokedActivationIDs: map[string]bool{},
	}
}

func testEngine(c *fakeConnector) (*Engine, *fakeTokens) {
	tokens := &fakeTokens{}
	return &Engine{
		Connector:  c,
		State:      state.NewEmbedded(),
		Tokens:     tokens,
		StaleGrace: 15 * time.Minute,
		CacheTTLMs: 30000,
	}, tokens
}

// --- §12 / §44 the core claim --------------------------------------------

func TestEligibleUserSeesAd(t *testing.T) {
	conn := &fakeConnector{members: map[string]bool{userEligible + "|" + segmentKey: true}}
	engine, tokens := testEngine(conn)

	d := engine.Decide(context.Background(), testSnapshot(testManifest(nil)), Request{
		PartnerUserID: userEligible,
		PlacementKey:  placementKey,
	})

	if d.Decision != "SHOW" {
		t.Fatalf("expected SHOW, got %s (%s)", d.Decision, d.Reason)
	}
	if d.ActivationID != activationID {
		t.Errorf("activation_id = %q", d.ActivationID)
	}
	if d.ClickToken == "" {
		t.Error("expected an opaque click token")
	}
	if tokens.issued != 1 {
		t.Errorf("expected one token issued, got %d", tokens.issued)
	}
	if d.Creative == nil || d.Creative.DestinationURL == "" {
		t.Fatal("expected a creative with a destination")
	}
	// §90: the token rides on the destination URL as an opaque value.
	if want := "https://insurance.example/quote?t=opaque-token-value"; d.Creative.DestinationURL != want {
		t.Errorf("destination = %q, want %q", d.Creative.DestinationURL, want)
	}
}

// The single most important test in the Agent: the decision that goes back to
// the Partner backend, and thence to the browser, must not carry the customer
// identifier that came in.
func TestDecisionNeverEchoesTheUserIdentifier(t *testing.T) {
	conn := &fakeConnector{members: map[string]bool{userEligible + "|" + segmentKey: true}}
	engine, _ := testEngine(conn)

	d := engine.Decide(context.Background(), testSnapshot(testManifest(nil)), Request{
		PartnerUserID: userEligible,
		PlacementKey:  placementKey,
	})

	blob := d.ActivationID + d.ClickToken + string(d.Reason)
	if d.Creative != nil {
		blob += d.Creative.DestinationURL + d.Creative.Headline + d.Creative.AssetURL
	}
	if contains(blob, userEligible) {
		t.Fatalf("decision leaked the partner_user_id: %q", blob)
	}
}

func TestIneligibleUserGetsNoAd(t *testing.T) {
	conn := &fakeConnector{members: map[string]bool{}}
	engine, tokens := testEngine(conn)

	d := engine.Decide(context.Background(), testSnapshot(testManifest(nil)), Request{
		PartnerUserID: userNotMember,
		PlacementKey:  placementKey,
	})

	if d.Decision != "NO_AD" || d.Reason != ReasonUserNotInSegment {
		t.Fatalf("expected NO_AD/USER_NOT_IN_SEGMENT, got %s/%s", d.Decision, d.Reason)
	}
	if tokens.issued != 0 {
		t.Error("no attribution token should be minted when nothing is served")
	}
}

// --- §77.1 NO_AD reasons --------------------------------------------------

func TestNoAdReasons(t *testing.T) {
	memberOf := map[string]bool{userEligible + "|" + segmentKey: true}

	tests := []struct {
		name     string
		snapshot func() *ConfigSnapshot
		conn     *fakeConnector
		req      Request
		want     NoAdReason
	}{
		{
			name:     "consent withdrawn",
			snapshot: func() *ConfigSnapshot { return testSnapshot(testManifest(nil)) },
			conn: &fakeConnector{
				members: memberOf,
				consent: map[string]bool{userEligible + "|" + purposeID: false},
			},
			req:  Request{PartnerUserID: userEligible, PlacementKey: placementKey},
			want: ReasonConsentNotEligible,
		},
		{
			name: "campaign ended",
			snapshot: func() *ConfigSnapshot {
				return testSnapshot(testManifest(func(m *manifest.Payload) {
					m.EndAt = time.Now().UTC().Add(-time.Hour)
				}))
			},
			conn: &fakeConnector{members: memberOf},
			req:  Request{PartnerUserID: userEligible, PlacementKey: placementKey},
			want: ReasonCampaignNotActive,
		},
		{
			name:     "placement not in manifest",
			snapshot: func() *ConfigSnapshot { return testSnapshot(testManifest(nil)) },
			conn:     &fakeConnector{members: memberOf},
			req:      Request{PartnerUserID: userEligible, PlacementKey: "some_other_slot"},
			want:     ReasonNoEligibleCampaign,
		},
		{
			name: "placement kill switch",
			snapshot: func() *ConfigSnapshot {
				s := testSnapshot(testManifest(nil))
				s.KilledPlacementKeys[placementKey] = true
				return s
			},
			conn: &fakeConnector{members: memberOf},
			req:  Request{PartnerUserID: userEligible, PlacementKey: placementKey},
			want: ReasonPlacementDisabled,
		},
		{
			name: "partner-wide kill switch",
			snapshot: func() *ConfigSnapshot {
				s := testSnapshot(testManifest(nil))
				s.KillSwitchAll = true
				return s
			},
			conn: &fakeConnector{members: memberOf},
			req:  Request{PartnerUserID: userEligible, PlacementKey: placementKey},
			want: ReasonKillSwitchActive,
		},
		{
			name: "activation revoked",
			snapshot: func() *ConfigSnapshot {
				s := testSnapshot(testManifest(nil))
				s.RevokedActivationIDs[activationID] = true
				return s
			},
			conn: &fakeConnector{members: memberOf},
			req:  Request{PartnerUserID: userEligible, PlacementKey: placementKey},
			want: ReasonNoEligibleCampaign,
		},
		{
			name: "control sync stale",
			snapshot: func() *ConfigSnapshot {
				s := testSnapshot(testManifest(nil))
				s.FetchedAt = time.Now().Add(-30 * time.Minute)
				return s
			},
			conn: &fakeConnector{members: memberOf},
			req:  Request{PartnerUserID: userEligible, PlacementKey: placementKey},
			want: ReasonControlSyncStale,
		},
		{
			name:     "segment source unavailable fails closed",
			snapshot: func() *ConfigSnapshot { return testSnapshot(testManifest(nil)) },
			conn:     &fakeConnector{failWith: connector.ErrSourceUnavailable},
			req:      Request{PartnerUserID: userEligible, PlacementKey: placementKey},
			want:     ReasonSegmentSourceError,
		},
		{
			name: "creative missing from the bundle",
			snapshot: func() *ConfigSnapshot {
				s := testSnapshot(testManifest(nil))
				s.Candidates[0].Creatives = map[string]Creative{}
				return s
			},
			conn: &fakeConnector{members: memberOf},
			req:  Request{PartnerUserID: userEligible, PlacementKey: placementKey},
			want: ReasonCreativeUnavailable,
		},
		{
			name: "category blocked by partner policy",
			snapshot: func() *ConfigSnapshot {
				return testSnapshot(testManifest(func(m *manifest.Payload) {
					m.BlockedCategories = []string{"insurance"}
				}))
			},
			conn: &fakeConnector{members: memberOf},
			req:  Request{PartnerUserID: userEligible, PlacementKey: placementKey},
			want: ReasonCategoryBlocked,
		},
		{
			name:     "anonymous visitor",
			snapshot: func() *ConfigSnapshot { return testSnapshot(testManifest(nil)) },
			conn:     &fakeConnector{members: memberOf},
			req:      Request{PartnerUserID: "", PlacementKey: placementKey},
			want:     ReasonConsentNotEligible,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			engine, tokens := testEngine(tc.conn)
			d := engine.Decide(context.Background(), tc.snapshot(), tc.req)
			if d.Decision != "NO_AD" {
				t.Fatalf("expected NO_AD, got %s", d.Decision)
			}
			if d.Reason != tc.want {
				t.Errorf("reason = %s, want %s", d.Reason, tc.want)
			}
			if tokens.issued != 0 {
				t.Error("a token was minted despite serving nothing")
			}
		})
	}
}

// --- §44 step 8 / §76.2 frequency ----------------------------------------

func TestFrequencyCapIsEnforcedLocally(t *testing.T) {
	conn := &fakeConnector{members: map[string]bool{userEligible + "|" + segmentKey: true}}
	engine, _ := testEngine(conn)
	snap := testSnapshot(testManifest(nil)) // cap: 2 per day
	req := Request{PartnerUserID: userEligible, PlacementKey: placementKey}

	for i := 1; i <= 2; i++ {
		if d := engine.Decide(context.Background(), snap, req); d.Decision != "SHOW" {
			t.Fatalf("impression %d: expected SHOW, got %s/%s", i, d.Decision, d.Reason)
		}
	}

	d := engine.Decide(context.Background(), snap, req)
	if d.Decision != "NO_AD" || d.Reason != ReasonFrequencyCapped {
		t.Fatalf("third impression: expected FREQUENCY_CAPPED, got %s/%s", d.Decision, d.Reason)
	}

	// The cap is per user: a different member is unaffected.
	conn.members["U789|"+segmentKey] = true
	if d := engine.Decide(context.Background(), snap, Request{PartnerUserID: "U789", PlacementKey: placementKey}); d.Decision != "SHOW" {
		t.Errorf("a different user should not inherit the cap, got %s/%s", d.Decision, d.Reason)
	}
}

// --- §76.1 budget --------------------------------------------------------

func TestLocalBudgetHardStop(t *testing.T) {
	conn := &fakeConnector{members: map[string]bool{userEligible + "|" + segmentKey: true}}
	engine, _ := testEngine(conn)
	snap := testSnapshot(testManifest(nil)) // allocation 30,000,000; stop at 98%

	// Just under the stop: still serving.
	_ = engine.State.AddSpendEstimate(context.Background(), activationID, 29_000_000)
	if d := engine.Decide(context.Background(), snap, Request{PartnerUserID: userEligible, PlacementKey: placementKey}); d.Decision != "SHOW" {
		t.Fatalf("below the stop threshold: expected SHOW, got %s/%s", d.Decision, d.Reason)
	}

	// Past 98% (29,400,000): stop.
	_ = engine.State.AddSpendEstimate(context.Background(), activationID, 1_000_000)
	d := engine.Decide(context.Background(), snap, Request{PartnerUserID: "U789", PlacementKey: placementKey})
	if d.Reason != ReasonBudgetExhausted {
		t.Fatalf("expected BUDGET_EXHAUSTED, got %s/%s", d.Decision, d.Reason)
	}
}

// --- §76.1 deterministic ranking ------------------------------------------

func TestSelectionIsDeterministic(t *testing.T) {
	conn := &fakeConnector{members: map[string]bool{
		userEligible + "|" + segmentKey: true,
	}}

	build := func() *ConfigSnapshot {
		// ONE schedule for both, so that pacing genuinely ties and the
		// activation_id tie-break is what decides -- which is the thing this
		// test exists to pin.
		//
		// testManifest stamps each call with its own time.Now(). On Windows
		// two consecutive calls usually return the same instant, so the two
		// campaigns got identical schedules, pacing tied, and this passed. On
		// Linux the clock has nanosecond resolution: act_zzz, built first,
		// started a few nanoseconds earlier, had a fractionally larger pacing
		// deficit, and won on pacing before the tie-break was ever consulted.
		// That failed CI on every run, and it was never a fault in Decide --
		// ranking by pacing before activation_id is exactly what §76.1 says.
		start := time.Now().UTC().Add(-time.Hour)
		end := start.Add(30*24*time.Hour + time.Hour)
		sameSchedule := func(m *manifest.Payload) { m.StartAt, m.EndAt = start, end }

		low := testManifest(func(m *manifest.Payload) { sameSchedule(m); m.ActivationID = "act_zzz" })
		high := testManifest(func(m *manifest.Payload) { sameSchedule(m); m.ActivationID = "act_aaa" })
		creatives := map[string]Creative{
			creativeID: {CreativeVersionID: creativeID, DestinationURL: "https://insurance.example/quote"},
		}
		return &ConfigSnapshot{
			Candidates: []Candidate{
				{Manifest: low, Creatives: creatives, Priority: 0},
				{Manifest: high, Creatives: creatives, Priority: 0},
			},
			FetchedAt:            time.Now().UTC(),
			KilledPlacementKeys:  map[string]bool{},
			KilledActivationIDs:  map[string]bool{},
			RevokedActivationIDs: map[string]bool{},
		}
	}

	// §76.1: equal priority and equal pacing tie-break on activation_id, so
	// repeated identical inputs must give an identical answer.
	for i := 0; i < 5; i++ {
		engine, _ := testEngine(conn)
		d := engine.Decide(context.Background(), build(), Request{PartnerUserID: userEligible, PlacementKey: placementKey})
		if d.ActivationID != "act_aaa" {
			t.Fatalf("run %d: selected %q, want the stable tie-break act_aaa", i, d.ActivationID)
		}
	}
}

func TestPartnerPriorityWins(t *testing.T) {
	conn := &fakeConnector{members: map[string]bool{userEligible + "|" + segmentKey: true}}
	engine, _ := testEngine(conn)

	creatives := map[string]Creative{
		creativeID: {CreativeVersionID: creativeID, DestinationURL: "https://insurance.example/quote"},
	}
	snap := &ConfigSnapshot{
		Candidates: []Candidate{
			// Alphabetically first, so only priority can put the other ahead.
			{Manifest: testManifest(func(m *manifest.Payload) { m.ActivationID = "act_aaa" }), Creatives: creatives, Priority: 0},
			{Manifest: testManifest(func(m *manifest.Payload) { m.ActivationID = "act_zzz" }), Creatives: creatives, Priority: 10},
		},
		FetchedAt:            time.Now().UTC(),
		KilledPlacementKeys:  map[string]bool{},
		KilledActivationIDs:  map[string]bool{},
		RevokedActivationIDs: map[string]bool{},
	}

	if d := engine.Decide(context.Background(), snap, Request{PartnerUserID: userEligible, PlacementKey: placementKey}); d.ActivationID != "act_zzz" {
		t.Fatalf("selected %q, want the higher-priority act_zzz", d.ActivationID)
	}
}

// --- §14 attribution ------------------------------------------------------

func TestNoServeWhenTokenCannotBeIssued(t *testing.T) {
	conn := &fakeConnector{members: map[string]bool{userEligible + "|" + segmentKey: true}}
	engine, tokens := testEngine(conn)
	tokens.fail = true

	// §14: an unattributable impression is inventory the Partner can never be
	// paid for, so serving it would be worse than serving nothing.
	d := engine.Decide(context.Background(), testSnapshot(testManifest(nil)), Request{
		PartnerUserID: userEligible,
		PlacementKey:  placementKey,
	})
	if d.Decision != "NO_AD" {
		t.Fatalf("expected NO_AD when the token cannot be minted, got %s", d.Decision)
	}
}

// --- §67.2 durations ------------------------------------------------------

func TestParseISODuration(t *testing.T) {
	ok := map[string]time.Duration{
		"P1D":    24 * time.Hour,
		"P7D":    7 * 24 * time.Hour,
		"PT6H":   6 * time.Hour,
		"PT30M":  30 * time.Minute,
		"PT45S":  45 * time.Second,
		"P1DT6H": 30 * time.Hour,
	}
	for in, want := range ok {
		got, err := ParseISODuration(in)
		if err != nil {
			t.Errorf("%s: unexpected error %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("%s = %v, want %v", in, got, want)
		}
	}

	// Months and years are refused rather than approximated: a cap enforced
	// over the wrong window silently breaks a Partner's stated promise.
	for _, bad := range []string{"P1M", "P1Y", "1 day", "", "P", "P0D", "PT0S"} {
		if _, err := ParseISODuration(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func contains(haystack, needle string) bool {
	if needle == "" {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
