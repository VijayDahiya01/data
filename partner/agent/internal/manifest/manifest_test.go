package manifest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
)

// Verify is the trust boundary: it decides whether a manifest may authorise
// serving at all (§11.2). These tests sign real manifests and check that every
// failure path fails CLOSED.

const (
	testIssuer   = "https://oolix.test"
	testAudience = "oolix-partner-agent"
	testPartner  = "org_partner_a"
)

func testKey(t *testing.T) (*ecdsa.PrivateKey, *jose.JSONWebKeySet) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	return key, &jose.JSONWebKeySet{
		Keys: []jose.JSONWebKey{
			{Key: key.Public(), KeyID: "test-kid", Algorithm: string(jose.ES256), Use: "sig"},
		},
	}
}

func sign(t *testing.T, key *ecdsa.PrivateKey, payload Payload, mutate func(map[string]interface{})) string {
	t.Helper()

	opts := (&jose.SignerOptions{}).
		WithType(jose.ContentType(JWSType)).
		WithHeader("kid", "test-kid").
		WithHeader("iss", testIssuer).
		WithHeader("aud", testAudience)

	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, opts)
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	if mutate != nil {
		var asMap map[string]interface{}
		if err := json.Unmarshal(encoded, &asMap); err != nil {
			t.Fatalf("remarshal: %v", err)
		}
		mutate(asMap)
		if encoded, err = json.Marshal(asMap); err != nil {
			t.Fatalf("marshal mutated: %v", err)
		}
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

func validPayload() Payload {
	now := time.Now().UTC()
	return Payload{
		ManifestVersion:    1,
		ActivationID:       "act_1",
		PartnerOrgID:       testPartner,
		SegmentID:          "seg_1",
		SegmentKey:         "RECENT_TRAVELLER_60D",
		Channel:            "PARTNER_WEB",
		PlacementIDs:       []string{"pl_1"},
		PlacementKeys:      []string{"booking_success_offer"},
		CreativeVersionIDs: []string{"crv_10"},
		Budget: Budget{
			AllocationMinor:   "30000000",
			Currency:          "INR",
			LocalStopFraction: 0.98,
		},
		FrequencyCap:      FrequencyCap{MaxImpressions: 2, Window: "P1D"},
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

func audiencePayload() Payload {
	p := validPayload()
	// v6: the audience path carries no segment at all.
	p.SegmentID = ""
	p.SegmentKey = ""
	p.Audience = &AudienceBlock{
		AudienceGroupID: "aud_100",
		AudienceVersion: 3,
		RuleHash:        "50424f8680a98cac3b8e854ab0f8c0d0d1463d15452678977d2034a74e578d73",
		Rules: []AudienceRule{
			{Attribute: "online_shopper", Operator: "EQ", Value: true, Required: true, Weight: 5},
		},
		MappingVersion: 8,
	}
	return p
}

func verify(t *testing.T, compact string, jwks *jose.JSONWebKeySet) (*Payload, error) {
	t.Helper()
	return Verify(compact, jwks, VerifyOptions{
		Issuer:       testIssuer,
		Audience:     testAudience,
		PartnerOrgID: testPartner,
	})
}

func TestVerifyAcceptsALegacySegmentManifest(t *testing.T) {
	key, jwks := testKey(t)

	payload, err := verify(t, sign(t, key, validPayload(), nil), jwks)
	if err != nil {
		t.Fatalf("a valid v5 manifest should verify: %v", err)
	}
	if payload.SegmentKey != "RECENT_TRAVELLER_60D" {
		t.Errorf("segment key did not survive: %q", payload.SegmentKey)
	}
	if payload.Audience != nil {
		t.Error("a segment manifest should carry no audience block")
	}
}

func TestVerifyAcceptsAV6AudienceManifest(t *testing.T) {
	key, jwks := testKey(t)

	payload, err := verify(t, sign(t, key, audiencePayload(), nil), jwks)
	if err != nil {
		// §80's N-1 compatibility runs both ways: an Agent must accept the new
		// shape as readily as the old one.
		t.Fatalf("a valid v6 manifest should verify: %v", err)
	}
	if payload.Audience == nil {
		t.Fatal("the audience block did not survive verification")
	}
	if payload.Audience.AudienceVersion != 3 || len(payload.Audience.Rules) != 1 {
		t.Errorf("audience block was not decoded intact: %+v", payload.Audience)
	}
}

func TestVerifyRejectsAManifestWithNothingToTargetOn(t *testing.T) {
	key, jwks := testKey(t)

	untargetable := validPayload()
	untargetable.SegmentID = ""
	untargetable.SegmentKey = ""

	_, err := verify(t, sign(t, key, untargetable, nil), jwks)

	// A manifest with neither a segment nor an audience has no way to say who
	// it is for. The decision engine's membership check would have nothing to
	// check, and on any fail-open reading that serves the campaign to everyone.
	if !errors.Is(err, ErrMalformed) {
		t.Errorf("expected ErrMalformed for an untargetable manifest, got %v", err)
	}
}

func TestVerifyRejectsAnAudienceBlockWithNoRuleHash(t *testing.T) {
	key, jwks := testKey(t)

	compact := sign(t, key, audiencePayload(), func(m map[string]interface{}) {
		audience, _ := m["audience"].(map[string]interface{})
		delete(audience, "rule_hash")
	})

	_, err := verify(t, compact, jwks)

	// §10: the Partner's approval binds to a hash. Without one there is nothing
	// to check the compiled rules against.
	if !errors.Is(err, ErrMalformed) {
		t.Errorf("expected ErrMalformed without a rule hash, got %v", err)
	}
}

func TestVerifyRejectsAnAudienceBlockWithNoRules(t *testing.T) {
	key, jwks := testKey(t)

	compact := sign(t, key, audiencePayload(), func(m map[string]interface{}) {
		audience, _ := m["audience"].(map[string]interface{})
		audience["rules"] = []interface{}{}
	})

	if _, err := verify(t, compact, jwks); !errors.Is(err, ErrMalformed) {
		t.Errorf("expected ErrMalformed with an empty rule set, got %v", err)
	}
}

func TestVerifyRejectsAManifestBoundToAnotherPartner(t *testing.T) {
	key, jwks := testKey(t)

	other := audiencePayload()
	other.PartnerOrgID = "org_partner_b"

	if _, err := verify(t, sign(t, key, other, nil), jwks); !errors.Is(err, ErrWrongPartner) {
		// Cross-tenant replay: without this check, one Partner's Agent could be
		// handed another Partner's approved audience.
		t.Errorf("expected ErrWrongPartner, got %v", err)
	}
}

func TestVerifyRejectsAnExpiredConfig(t *testing.T) {
	key, jwks := testKey(t)

	stale := audiencePayload()
	stale.IssuedAt = time.Now().UTC().Add(-2 * time.Hour)
	stale.ConfigExpiresAt = time.Now().UTC().Add(-time.Hour)

	// §75: a signature that is still cryptographically valid is NOT sufficient
	// once config expires. That is what bounds the offline cache.
	if _, err := verify(t, sign(t, key, stale, nil), jwks); !errors.Is(err, ErrConfigExpired) {
		t.Errorf("expected ErrConfigExpired, got %v", err)
	}
}

func TestVerifyRejectsAnEndedCampaign(t *testing.T) {
	key, jwks := testKey(t)

	ended := audiencePayload()
	ended.EndAt = time.Now().UTC().Add(-time.Minute)

	// §24: the Agent stops serving at the campaign end even when Oolix is
	// unreachable, so this cannot depend on a control-plane update arriving.
	if _, err := verify(t, sign(t, key, ended, nil), jwks); !errors.Is(err, ErrCampaignEnded) {
		t.Errorf("expected ErrCampaignEnded, got %v", err)
	}
}

func TestVerifyRejectsAManifestSignedByAnotherKey(t *testing.T) {
	attacker, _ := testKey(t)
	_, jwks := testKey(t)

	if _, err := verify(t, sign(t, attacker, audiencePayload(), nil), jwks); !errors.Is(err, ErrBadSignature) {
		t.Errorf("expected ErrBadSignature, got %v", err)
	}
}

func TestVerifyRejectsATamperedAudienceRule(t *testing.T) {
	key, jwks := testKey(t)

	// Sign a real manifest, then flip a rule value in the compact form. The
	// signature covers the payload, so this must not verify -- if it did, an
	// intermediary could widen an audience after the Partner approved it.
	compact := sign(t, key, audiencePayload(), nil)
	tampered := compact[:len(compact)/2] + "X" + compact[len(compact)/2+1:]

	if _, err := verify(t, tampered, jwks); err == nil {
		t.Error("a tampered manifest verified; the audience could be edited after approval")
	}
}

func TestVerifyPinsIssuerAndAudience(t *testing.T) {
	key, jwks := testKey(t)
	compact := sign(t, key, audiencePayload(), nil)

	// Cross-environment replay: a staging manifest must not verify against a
	// production Agent's pinned issuer.
	_, err := Verify(compact, jwks, VerifyOptions{
		Issuer:       "https://other.test",
		Audience:     testAudience,
		PartnerOrgID: testPartner,
	})
	if !errors.Is(err, ErrWrongIssuer) {
		t.Errorf("expected ErrWrongIssuer, got %v", err)
	}

	_, err = Verify(compact, jwks, VerifyOptions{
		Issuer:       testIssuer,
		Audience:     "some-other-audience",
		PartnerOrgID: testPartner,
	})
	if !errors.Is(err, ErrWrongAudience) {
		t.Errorf("expected ErrWrongAudience, got %v", err)
	}
}
