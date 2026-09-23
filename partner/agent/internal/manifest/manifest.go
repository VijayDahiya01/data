// Package manifest verifies Oolix activation manifests inside the Partner
// Agent -- spec v5 §11.2, §75.
//
// This is the Go mirror of oolix/packages/manifest-schema. The two MUST agree: the
// control plane signs with one and the Agent verifies with the other, and a
// disagreement means either no ad serves at all or -- far worse -- a manifest
// the control plane considers invalid is honoured here.
//
// §11.2 states the consequence of failure plainly:
//
//	No valid signature + no valid approval + no current policy
//	= no ad and no external upload.
//
// So every function in this file fails CLOSED. There is no partial-trust path
// and no "warn and continue".
package manifest

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/go-jose/go-jose/v4"
)

const (
	// JWSType is the §75 protected header typ. Checking it stops any other
	// ES256 token Oolix ever signed -- an agent access token, for instance --
	// from being accepted as a manifest.
	JWSType = "OOLIX-MANIFEST+JWS"
)

// AllowedAlgorithms pins ES256 and nothing else (§75).
//
// Passing an explicit allow-list to go-jose is what prevents algorithm
// confusion: without it a token could nominate "none" or an HMAC algorithm and
// be verified against a public key as if it were a shared secret.
var AllowedAlgorithms = []jose.SignatureAlgorithm{jose.ES256}

// Budget is the §75 budget block.
type Budget struct {
	// AllocationMinor is a DECIMAL STRING. §73 stores budgets as BIGINT and a
	// JSON number would silently lose precision past 2^53.
	AllocationMinor   string  `json:"allocation_minor"`
	Currency          string  `json:"currency"`
	LocalStopFraction float64 `json:"local_stop_fraction"`
}

// FrequencyCap is the §67.2 cap shape.
type FrequencyCap struct {
	MaxImpressions int    `json:"max_impressions"`
	Window         string `json:"window"`
}

// AudienceRule is one condition of an approved Audience Group (v6 §6.3).
//
// Duplicated here rather than imported from internal/audience so the manifest
// package keeps depending on nothing: it is the trust boundary, and the fewer
// packages that can influence what "a verified manifest" means, the better.
type AudienceRule struct {
	Attribute string      `json:"attribute"`
	Operator  string      `json:"operator"`
	Value     interface{} `json:"value"`
	Required  bool        `json:"required"`
	Weight    int         `json:"weight"`
}

// AudienceBlock is v6 Appendix B's manifest addition.
//
// RuleHash is the load-bearing field. §10 binds the Partner's approval to it,
// so the Agent recomputes it from Rules before compiling anything: if the two
// disagree the audience changed after the Partner agreed to it, and nothing may
// be served.
type AudienceBlock struct {
	AudienceGroupID   string         `json:"audience_group_id"`
	AudienceVersion   int            `json:"audience_version"`
	RuleHash          string         `json:"rule_hash"`
	Rules             []AudienceRule `json:"rules"`
	ReachEstimateID   string         `json:"reach_estimate_id,omitempty"`
	CapabilityVersion int            `json:"capability_version,omitempty"`
	MappingVersion    int            `json:"mapping_version,omitempty"`
}

// Payload is the §75 required manifest payload.
type Payload struct {
	ManifestVersion int    `json:"manifest_version"`
	ActivationID    string `json:"activation_id"`
	PartnerOrgID    string `json:"partner_org_id"`
	// SegmentID and SegmentKey are v6 §19's legacy path: a Partner with an
	// existing prebuilt segment can still be activated. Empty when the campaign
	// targets an Audience Group instead, so neither may be assumed present.
	SegmentID  string `json:"segment_id"`
	SegmentKey string `json:"segment_key"`
	// Audience is the v6 primary targeting path. Nil on a legacy manifest;
	// §80's N-1 compatibility means an Agent in the field must accept both.
	Audience           *AudienceBlock `json:"audience,omitempty"`
	Channel            string         `json:"channel"`
	PlacementIDs       []string       `json:"placement_ids"`
	PlacementKeys      []string       `json:"placement_keys"`
	CreativeVersionIDs []string       `json:"creative_version_ids"`
	Budget             Budget         `json:"budget"`
	FrequencyCap       FrequencyCap   `json:"frequency_cap"`
	PurposeID          string         `json:"purpose_id"`
	PolicyVersion      string         `json:"policy_version"`
	AllowedCategories  []string       `json:"allowed_categories"`
	BlockedCategories  []string       `json:"blocked_categories"`
	CampaignCategory   string         `json:"campaign_category"`
	IssuedAt           time.Time      `json:"issued_at"`
	ConfigExpiresAt    time.Time      `json:"config_expires_at"`
	StartAt            time.Time      `json:"start_at"`
	EndAt              time.Time      `json:"end_at"`
	ApprovalReference  string         `json:"approval_reference"`
	AudienceExpansion  bool           `json:"audience_expansion_allowed"`
}

// VerifyOptions carries the pinned values a verification is checked against.
type VerifyOptions struct {
	Issuer   string
	Audience string
	// PartnerOrgID is this Agent's own partner id. A manifest bound to a
	// different Partner is rejected outright (§75 partner binding).
	PartnerOrgID string
	// Now is injectable so expiry behaviour is testable without sleeping.
	Now time.Time
}

var (
	ErrBadSignature  = errors.New("manifest signature verification failed")
	ErrWrongType     = errors.New("manifest has an unexpected token type")
	ErrWrongIssuer   = errors.New("manifest issuer mismatch")
	ErrWrongAudience = errors.New("manifest audience mismatch")
	ErrWrongPartner  = errors.New("manifest is bound to a different Partner")
	ErrNotYetValid   = errors.New("manifest is not yet valid")
	ErrConfigExpired = errors.New("manifest config has expired")
	ErrCampaignEnded = errors.New("campaign has ended")
	ErrMalformed     = errors.New("manifest payload is malformed")
)

// Verify checks a compact JWS manifest against a JWKS.
//
// The checks run in this order, and every one of them must pass:
//
//  1. alg is ES256 and typ is the Oolix manifest type   (algorithm confusion)
//  2. signature verifies against a key in the JWKS       (authenticity)
//  3. issuer and audience are pinned                     (cross-env replay)
//  4. partner binding matches this Agent                 (cross-tenant replay)
//  5. issued_at <= now < config_expires_at               (staleness, §75)
//  6. now < end_at                                       (§24 expired campaign)
func Verify(compact string, jwks *jose.JSONWebKeySet, opts VerifyOptions) (*Payload, error) {
	now := opts.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}

	sig, err := jose.ParseSigned(compact, AllowedAlgorithms)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadSignature, err)
	}
	if len(sig.Signatures) != 1 {
		// A multi-signature JWS is not something Oolix produces; accepting one
		// would mean deciding which signature "counts".
		return nil, fmt.Errorf("%w: expected exactly one signature", ErrBadSignature)
	}

	header := sig.Signatures[0].Header
	protected := sig.Signatures[0].Protected

	if typ, _ := protected.ExtraHeaders[jose.HeaderType].(string); typ != JWSType {
		return nil, fmt.Errorf("%w: %q", ErrWrongType, typ)
	}

	// Select by kid so a rotation (§75 dual-key overlap) resolves to the right
	// key rather than trying every key in the set.
	var payloadBytes []byte
	if header.KeyID != "" {
		keys := jwks.Key(header.KeyID)
		if len(keys) == 0 {
			return nil, fmt.Errorf("%w: unknown kid %q", ErrBadSignature, header.KeyID)
		}
		for _, k := range keys {
			if payloadBytes, err = sig.Verify(k); err == nil {
				break
			}
		}
	} else {
		for _, k := range jwks.Keys {
			if payloadBytes, err = sig.Verify(k); err == nil {
				break
			}
		}
	}
	if payloadBytes == nil {
		return nil, ErrBadSignature
	}

	if iss, _ := protected.ExtraHeaders["iss"].(string); iss != opts.Issuer {
		return nil, fmt.Errorf("%w: %q", ErrWrongIssuer, iss)
	}
	if aud, _ := protected.ExtraHeaders["aud"].(string); aud != opts.Audience {
		return nil, fmt.Errorf("%w: %q", ErrWrongAudience, aud)
	}

	var payload Payload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}

	if opts.PartnerOrgID != "" && payload.PartnerOrgID != opts.PartnerOrgID {
		return nil, ErrWrongPartner
	}

	// v6 §19: targeting is EITHER a legacy segment or an Audience Group. A
	// manifest carrying neither has no way to say who it is for, and the
	// decision engine's membership check would have nothing to check -- which
	// on a fail-open reading would serve the campaign to every user. Rejecting
	// it here means that reading never becomes reachable.
	if payload.SegmentKey == "" && payload.Audience == nil {
		return nil, fmt.Errorf("%w: manifest has neither a segment nor an audience to target", ErrMalformed)
	}
	if payload.Audience != nil && (payload.Audience.RuleHash == "" || len(payload.Audience.Rules) == 0) {
		// §10: an audience block without rules or without the hash they were
		// approved under cannot be checked against the Partner's approval.
		return nil, fmt.Errorf("%w: audience block is missing its rules or rule hash", ErrMalformed)
	}

	if now.Before(payload.IssuedAt) {
		return nil, ErrNotYetValid
	}
	if !now.Before(payload.ConfigExpiresAt) {
		// §75: the offline cache is bounded. A signature that is still
		// cryptographically valid is NOT sufficient once config expires.
		return nil, ErrConfigExpired
	}
	if !now.Before(payload.EndAt) {
		// §24: "Agent automatically stops serving even if Oolix is temporarily
		// unreachable" once the campaign end passes.
		return nil, ErrCampaignEnded
	}

	return &payload, nil
}

// ServableAt reports whether an already-verified manifest may still serve.
//
// Verification happens once when a manifest is pulled; this is re-checked on
// every decision, because a cached manifest expires while it sits in memory.
func (p *Payload) ServableAt(now time.Time) error {
	switch {
	case now.Before(p.StartAt):
		return ErrNotYetValid
	case !now.Before(p.EndAt):
		return ErrCampaignEnded
	case !now.Before(p.ConfigExpiresAt):
		return ErrConfigExpired
	default:
		return nil
	}
}

// ServesPlacement reports whether this manifest authorises a placement key.
//
// §76.2: "every placement must be Partner-published and explicitly approved."
// The Agent matches on the keys inside the signed manifest, so a placement the
// Partner did not approve cannot be served even if it exists locally.
func (p *Payload) ServesPlacement(placementKey string) bool {
	for _, k := range p.PlacementKeys {
		if k == placementKey {
			return true
		}
	}
	return false
}

// AllowsCategory applies the Partner's category policy carried in the manifest.
//
// Evaluated locally so the rule holds even when Oolix is unreachable (§75).
// Blocked wins over allowed: a category on both lists is refused.
func (p *Payload) AllowsCategory(category string) bool {
	for _, b := range p.BlockedCategories {
		if equalFold(b, category) {
			return false
		}
	}
	if len(p.AllowedCategories) == 0 {
		return true
	}
	for _, a := range p.AllowedCategories {
		if equalFold(a, category) {
			return true
		}
	}
	return false
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}
