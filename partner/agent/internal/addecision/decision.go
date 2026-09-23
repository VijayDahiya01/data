// Package addecision chooses which approved campaign, if any, to serve --
// spec v5 §12, §44, §45, §76, §77.1.
//
// This is the runtime path §44 specifies step by step. Two properties matter
// more than anything else here:
//
//	PRIVACY   The partner_user_id arrives from the Partner's own backend,
//	          is used only for a local membership and consent lookup, and is
//	          never returned, logged or forwarded. §12: Oolix never receives it.
//
//	SAFETY    §43: "Ad placement failure cannot block checkout/booking/login."
//	          Every failure mode returns NO_AD with a reason. Nothing in this
//	          package panics, retries slowly, or returns an error to the
//	          Partner's page.
package addecision

import (
	"context"
	"errors"
	"math/big"
	"sort"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/connector"
	"github.com/oolix/partner-agent/internal/manifest"
	"github.com/oolix/partner-agent/internal/state"
)

// NoAdReason is the §77.1 enum. These describe a DECISION, never a person.
type NoAdReason string

const (
	ReasonNoEligibleCampaign  NoAdReason = "NO_ELIGIBLE_CAMPAIGN"
	ReasonUserNotInSegment    NoAdReason = "USER_NOT_IN_SEGMENT"
	ReasonConsentNotEligible  NoAdReason = "CONSENT_NOT_ELIGIBLE"
	ReasonFrequencyCapped     NoAdReason = "FREQUENCY_CAPPED"
	ReasonBudgetExhausted     NoAdReason = "BUDGET_EXHAUSTED"
	ReasonCampaignNotActive   NoAdReason = "CAMPAIGN_NOT_ACTIVE"
	ReasonPlacementDisabled   NoAdReason = "PLACEMENT_DISABLED"
	ReasonCategoryBlocked     NoAdReason = "CATEGORY_BLOCKED"
	ReasonCreativeUnavailable NoAdReason = "CREATIVE_UNAVAILABLE"
	ReasonControlSyncStale    NoAdReason = "CONTROL_SYNC_STALE"
	ReasonSegmentSourceError  NoAdReason = "SEGMENT_SOURCE_ERROR"
	ReasonKillSwitchActive    NoAdReason = "KILL_SWITCH_ACTIVE"
)

// Creative is the render payload the Agent hands back (§44 step 10).
type Creative struct {
	CreativeVersionID string `json:"creative_version_id"`
	Format            string `json:"format"`
	Headline          string `json:"headline,omitempty"`
	Body              string `json:"body,omitempty"`
	CTA               string `json:"cta,omitempty"`
	AssetURL          string `json:"asset_url,omitempty"`
	Width             int    `json:"width,omitempty"`
	Height            int    `json:"height,omitempty"`
	LegalDisclaimer   string `json:"legal_disclaimer,omitempty"`
	// DestinationURL already carries the opaque attribution token (§90).
	DestinationURL string `json:"destination_url"`
}

// Request is what the Partner backend asks for (§12.1, §44).
type Request struct {
	// PartnerUserID never leaves this process. It is not stored, not logged
	// and not present in the Decision returned to the caller.
	PartnerUserID string
	PlacementKey  string
	Context       map[string]string
}

// Decision is the answer. Note there is no field carrying the user id back.
type Decision struct {
	Decision     string     `json:"decision"` // SHOW | NO_AD
	Reason       NoAdReason `json:"reason,omitempty"`
	ActivationID string     `json:"activation_id,omitempty"`
	// AudienceMaterializationVersion is §12's response field: WHICH locally
	// compiled audience selected this person. It is a version number, not a
	// count and not an identifier -- safe to hand back to the Partner's own
	// backend, which is the only thing that ever sees it.
	AudienceMaterializationVersion int       `json:"audience_materialization_version,omitempty"`
	Creative                       *Creative `json:"creative,omitempty"`
	ClickToken                     string    `json:"click_token,omitempty"`
	CacheTTLMs                     int       `json:"cache_ttl_ms,omitempty"`
	RetryAfterMs                   int       `json:"retry_after_ms,omitempty"`
}

// Candidate pairs a verified manifest with its creative bundle.
type Candidate struct {
	Manifest  *manifest.Payload
	Creatives map[string]Creative
	// Priority is the Partner's own ordering. §76.1 ranks by Partner priority
	// first; the MVP has no auction.
	Priority int
}

// ConfigSnapshot is the Agent's current view of what it may serve.
type ConfigSnapshot struct {
	Candidates []Candidate
	// FetchedAt drives the §75 staleness check.
	FetchedAt time.Time
	// KillSwitches are enforced locally so a Partner stop takes effect even if
	// Oolix is unreachable (§24, §56).
	KillSwitchAll        bool
	KilledPlacementKeys  map[string]bool
	KilledActivationIDs  map[string]bool
	RevokedActivationIDs map[string]bool
}

// TokenIssuer mints the opaque attribution token (§71, §90).
type TokenIssuer interface {
	Issue(ctx context.Context, activationID, creativeVersionID, placementKey string) (string, error)
}

// AudienceIndex is v6 §12's membership lookup.
//
// "Real-time ad decision uses fast membership lookup, not full rule
// evaluation": the rules were compiled once at materialization time (§11), so
// the runtime question is only whether this person is in the compiled set.
type AudienceIndex interface {
	// Returns membership AND the materialization version that selected this
	// person, because §12's decision response reports which compiled audience
	// served the ad.
	IsMaterializedMember(ctx context.Context, partnerUserID, activationID string) (bool, int, error)
}

// Engine performs the §44 decision.
type Engine struct {
	Connector connector.Connector
	State     state.Store
	Tokens    TokenIssuer
	// Audience answers membership for v6 audience-targeted manifests. Nil when
	// the Partner has published no attribute mapping, in which case an
	// audience-targeted manifest serves nothing -- see isTargetMember.
	Audience   AudienceIndex
	StaleGrace time.Duration
	CacheTTLMs int
	// Now is injectable for deterministic tests.
	Now func() time.Time
}

// isTargetMember answers §44 step 6 for both targeting shapes.
//
// v6 routes membership through the locally materialized audience; v5's legacy
// segment path still runs for manifests that carry a segment key (§19).
//
// Both fail CLOSED, and so does the gap between them: an audience-targeted
// manifest with no local evaluator configured returns false, not true. §57's
// rule is that an unreachable source must never be read as "probably yes", and
// a missing one is the most unreachable source there is.
//
// The second return is the local materialization version, zero on the legacy
// segment path where there is no such thing.
func (e *Engine) isTargetMember(
	ctx context.Context,
	partnerUserID string,
	m *manifest.Payload,
) (bool, int, error) {
	if m.Audience != nil {
		if e.Audience == nil {
			return false, 0, connector.ErrSourceUnavailable
		}
		return e.Audience.IsMaterializedMember(ctx, partnerUserID, m.ActivationID)
	}
	member, err := e.Connector.IsMember(ctx, partnerUserID, m.SegmentKey)
	return member, 0, err
}

func (e *Engine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now().UTC()
}

func noAd(reason NoAdReason) Decision {
	return Decision{Decision: "NO_AD", Reason: reason}
}

// Decide runs the §44 runtime sequence.
//
// The order is deliberate and follows §44 steps 5-9: cheap local checks first,
// then the segment lookup (the only network hop), then frequency and pacing.
// Doing membership last would waste a database round trip on a request that a
// kill switch or an expired campaign already rules out.
func (e *Engine) Decide(ctx context.Context, snapshot *ConfigSnapshot, req Request) Decision {
	now := e.now()

	// §24 / §56: a Partner kill switch stops everything, immediately.
	if snapshot == nil || snapshot.KillSwitchAll {
		return noAd(ReasonKillSwitchActive)
	}
	if snapshot.KilledPlacementKeys[req.PlacementKey] {
		return noAd(ReasonPlacementDisabled)
	}

	// §75: past the stale grace the Agent must stop serving rather than guess.
	// A stale config may already have been revoked upstream.
	if !snapshot.FetchedAt.IsZero() && now.Sub(snapshot.FetchedAt) > e.StaleGrace {
		return noAd(ReasonControlSyncStale)
	}

	// §76.2: MVP segment targeting requires a Partner-resolvable first-party
	// identity. An anonymous visitor gets no segment-based ad.
	if strings.TrimSpace(req.PartnerUserID) == "" {
		return noAd(ReasonConsentNotEligible)
	}

	// --- step 5: manifests for this placement ------------------------------
	candidates := make([]Candidate, 0, len(snapshot.Candidates))
	for _, c := range snapshot.Candidates {
		if snapshot.RevokedActivationIDs[c.Manifest.ActivationID] ||
			snapshot.KilledActivationIDs[c.Manifest.ActivationID] {
			continue
		}
		if !c.Manifest.ServesPlacement(req.PlacementKey) {
			continue
		}
		candidates = append(candidates, c)
	}
	if len(candidates) == 0 {
		return noAd(ReasonNoEligibleCampaign)
	}

	// --- step 8 (cheap parts): dates, category, creative --------------------
	var (
		active      []Candidate
		sawInactive bool
		sawCategory bool
		sawCreative bool
	)
	for _, c := range candidates {
		if err := c.Manifest.ServableAt(now); err != nil {
			sawInactive = true
			continue
		}
		if !c.Manifest.AllowsCategory(c.Manifest.CampaignCategory) {
			sawCategory = true
			continue
		}
		if len(c.Creatives) == 0 {
			// §57: a missing creative degrades to NO_AD rather than rendering
			// an empty slot.
			sawCreative = true
			continue
		}
		active = append(active, c)
	}
	if len(active) == 0 {
		switch {
		case sawCategory:
			return noAd(ReasonCategoryBlocked)
		case sawCreative:
			return noAd(ReasonCreativeUnavailable)
		case sawInactive:
			return noAd(ReasonCampaignNotActive)
		default:
			return noAd(ReasonNoEligibleCampaign)
		}
	}

	// --- step 9 ordering: §76.1 deterministic ranking ----------------------
	//
	// "Candidate ranking: Partner priority DESC, then pacing deficit DESC,
	//  then stable activation_id tie-break. No auction in MVP."
	//
	// The stable tie-break matters: without it two equally-ranked campaigns
	// would alternate unpredictably and neither Partner nor Buyer could
	// reproduce a delivery pattern.
	deficits := make(map[string]float64, len(active))
	for _, c := range active {
		deficits[c.Manifest.ActivationID] = e.pacingDeficit(ctx, c, now)
	}
	sort.SliceStable(active, func(i, j int) bool {
		if active[i].Priority != active[j].Priority {
			return active[i].Priority > active[j].Priority
		}
		di, dj := deficits[active[i].Manifest.ActivationID], deficits[active[j].Manifest.ActivationID]
		if di != dj {
			return di > dj
		}
		return active[i].Manifest.ActivationID < active[j].Manifest.ActivationID
	})

	// --- steps 6-8: per-candidate eligibility ------------------------------
	//
	// Reasons are tracked so the NO_AD answer names the FIRST-ranked
	// candidate's blocker, which is what a Partner debugging an empty slot
	// actually wants to know (§77.1 reason buckets, §98.2 NO_AD mix).
	var firstReason NoAdReason
	note := func(r NoAdReason) {
		if firstReason == "" {
			firstReason = r
		}
	}

	for _, c := range active {
		m := c.Manifest

		// §76.1: hard local stop at the manifest's local_stop_fraction of the
		// allocation, reserving headroom for reporting lag.
		if e.budgetExhausted(ctx, c) {
			note(ReasonBudgetExhausted)
			continue
		}

		// §44 step 6: local membership -- v6 §12's materialized audience, or
		// the legacy segment for a §19 manifest.
		member, materializationVersion, err := e.isTargetMember(ctx, req.PartnerUserID, m)
		if err != nil {
			// §57: fail closed. Never assume membership when the source is
			// unreachable.
			if errors.Is(err, connector.ErrSourceUnavailable) {
				note(ReasonSegmentSourceError)
				continue
			}
			note(ReasonSegmentSourceError)
			continue
		}
		if !member {
			note(ReasonUserNotInSegment)
			continue
		}

		// §44 step 7: consent and purpose eligibility.
		eligible, err := e.Connector.IsAdvertisingEligible(ctx, req.PartnerUserID, m.PurposeID)
		if err != nil {
			note(ReasonSegmentSourceError)
			continue
		}
		if !eligible {
			note(ReasonConsentNotEligible)
			continue
		}

		// §44 step 8: frequency cap, enforced against Partner-local state.
		window, err := ParseISODuration(m.FrequencyCap.Window)
		if err != nil {
			// An unparseable cap cannot be enforced, and an unenforceable cap
			// is a Partner promise broken. Skip the candidate.
			note(ReasonNoEligibleCampaign)
			continue
		}
		count, err := e.State.FrequencyCount(ctx, m.ActivationID, req.PartnerUserID, window)
		if err != nil {
			note(ReasonNoEligibleCampaign)
			continue
		}
		if count >= m.FrequencyCap.MaxImpressions {
			note(ReasonFrequencyCapped)
			continue
		}

		// --- step 10: selected -----------------------------------------------
		creative := pickCreative(c)
		if creative == nil {
			note(ReasonCreativeUnavailable)
			continue
		}

		token, err := e.Tokens.Issue(ctx, m.ActivationID, creative.CreativeVersionID, req.PlacementKey)
		if err != nil {
			// §14: without a token the click cannot be attributed, so the
			// Partner would deliver unpaid inventory. Better to serve nothing.
			note(ReasonNoEligibleCampaign)
			continue
		}

		rendered := *creative
		rendered.DestinationURL = appendToken(rendered.DestinationURL, token)

		// §44 steps 12-13: local frequency and the aggregate counter. Recorded
		// on the DECISION: the Agent is the only component that can count an
		// eligible serve, and §77.3 reconciles it against central figures.
		_ = e.State.RecordImpression(ctx, m.ActivationID, req.PartnerUserID, window)

		return Decision{
			Decision:     "SHOW",
			ActivationID: m.ActivationID,
			// §12: zero on the legacy segment path, where no audience was
			// compiled, and omitted from the JSON in that case.
			AudienceMaterializationVersion: materializationVersion,
			Creative:                       &rendered,
			ClickToken:                     token,
			CacheTTLMs:                     e.CacheTTLMs,
		}
	}

	if firstReason == "" {
		firstReason = ReasonNoEligibleCampaign
	}
	return noAd(firstReason)
}

// budgetExhausted applies the §76.1 local hard stop.
func (e *Engine) budgetExhausted(ctx context.Context, c Candidate) bool {
	allocation, ok := new(big.Int).SetString(c.Manifest.Budget.AllocationMinor, 10)
	if !ok || allocation.Sign() <= 0 {
		return false
	}
	spent, err := e.State.SpendEstimate(ctx, c.Manifest.ActivationID)
	if err != nil {
		return false
	}
	fraction := c.Manifest.Budget.LocalStopFraction
	if fraction <= 0 || fraction > 1 {
		fraction = 0.98
	}
	limit := new(big.Float).Mul(new(big.Float).SetInt(allocation), big.NewFloat(fraction))
	limitInt, _ := limit.Int(nil)
	return big.NewInt(spent).Cmp(limitInt) >= 0
}

// pacingDeficit measures how far behind an activation is against its
// time-proportional target (§76.1).
//
// "Daily planned spend = remaining budget / remaining campaign days. Intra-day
// target is time-proportional." A larger deficit ranks higher, so a campaign
// that has under-delivered catches up rather than one campaign starving
// another for the whole flight.
func (e *Engine) pacingDeficit(ctx context.Context, c Candidate, now time.Time) float64 {
	m := c.Manifest
	total := m.EndAt.Sub(m.StartAt)
	if total <= 0 {
		return 0
	}
	elapsed := now.Sub(m.StartAt)
	if elapsed < 0 {
		return 0
	}
	expectedFraction := float64(elapsed) / float64(total)
	if expectedFraction > 1 {
		expectedFraction = 1
	}

	allocation, ok := new(big.Int).SetString(m.Budget.AllocationMinor, 10)
	if !ok || allocation.Sign() <= 0 {
		return 0
	}
	spent, err := e.State.SpendEstimate(ctx, m.ActivationID)
	if err != nil {
		return 0
	}
	allocFloat, _ := new(big.Float).SetInt(allocation).Float64()
	if allocFloat == 0 {
		return 0
	}
	actualFraction := float64(spent) / allocFloat
	return expectedFraction - actualFraction
}

// pickCreative selects a creative from the approved bundle.
//
// Deterministic by id so the same decision inputs produce the same output,
// which keeps §77.3 reconciliation and any Partner-side debugging tractable.
func pickCreative(c Candidate) *Creative {
	ids := make([]string, 0, len(c.Creatives))
	for _, id := range c.Manifest.CreativeVersionIDs {
		if _, ok := c.Creatives[id]; ok {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	sort.Strings(ids)
	cr := c.Creatives[ids[0]]
	return &cr
}

// appendToken attaches the opaque attribution token to the destination URL.
//
// §90: the token is opaque and carries no readable metadata, so appending it
// reveals nothing about the Partner, segment or campaign.
func appendToken(destination, token string) string {
	if destination == "" {
		return destination
	}
	sep := "?"
	if strings.Contains(destination, "?") {
		sep = "&"
	}
	return destination + sep + "t=" + token
}
