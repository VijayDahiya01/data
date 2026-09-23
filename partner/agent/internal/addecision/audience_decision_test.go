package addecision

import (
	"context"
	"errors"
	"testing"

	"github.com/oolix/partner-agent/internal/manifest"
)

// fakeAudienceIndex stands in for the local materialization table (v6 §12).
type fakeAudienceIndex struct {
	members  map[string]bool // "user|activation"
	version  int
	failWith error
	calls    int
}

func (f *fakeAudienceIndex) IsMaterializedMember(
	_ context.Context,
	user, activation string,
) (bool, int, error) {
	f.calls++
	if f.failWith != nil {
		return false, 0, f.failWith
	}
	if !f.members[user+"|"+activation] {
		return false, 0, nil
	}
	version := f.version
	if version == 0 {
		version = 1
	}
	return true, version, nil
}

// audienceManifest is the v6 shape: an audience block and NO segment key.
func audienceManifest() *manifest.Payload {
	return testManifest(func(m *manifest.Payload) {
		m.SegmentID = ""
		m.SegmentKey = ""
		m.Audience = &manifest.AudienceBlock{
			AudienceGroupID: "aud_100",
			AudienceVersion: 3,
			RuleHash:        "50424f8680a98cac3b8e854ab0f8c0d0d1463d15452678977d2034a74e578d73",
			Rules: []manifest.AudienceRule{
				{Attribute: "online_shopper", Operator: "EQ", Value: true, Required: true, Weight: 5},
			},
			MappingVersion: 8,
		}
	})
}

func TestAudienceTargetedManifestUsesTheMaterializedIndex(t *testing.T) {
	m := audienceManifest()
	conn := &fakeConnector{}
	engine, _ := testEngine(conn)
	index := &fakeAudienceIndex{
		members: map[string]bool{userEligible + "|" + activationID: true},
		version: 7,
	}
	engine.Audience = index

	d := engine.Decide(context.Background(), testSnapshot(m),
		Request{PartnerUserID: userEligible, PlacementKey: placementKey})

	if d.Decision != "SHOW" {
		t.Fatalf("expected SHOW, got %s (%s)", d.Decision, d.Reason)
	}
	// §12's response field: WHICH compiled audience selected this person. Read
	// from the member row, so it describes the build that actually matched
	// rather than whatever build happens to be current.
	if d.AudienceMaterializationVersion != 7 {
		t.Errorf("expected the materialization version to be reported, got %d",
			d.AudienceMaterializationVersion)
	}
	// §12: the runtime is a membership lookup against the compiled audience,
	// not a rule evaluation and not a segment query. If the segment connector
	// were consulted here, the Partner would be answering about a segment that
	// this campaign never targeted.
	if index.calls == 0 {
		t.Error("the materialized audience index was never consulted")
	}
	if conn.calls != 0 {
		t.Errorf("the legacy segment path ran for an audience-targeted manifest (%d calls)", conn.calls)
	}
}

func TestNonMemberOfMaterializedAudienceGetsNoAd(t *testing.T) {
	m := audienceManifest()
	engine, _ := testEngine(&fakeConnector{})
	engine.Audience = &fakeAudienceIndex{members: map[string]bool{}}

	d := engine.Decide(context.Background(), testSnapshot(m),
		Request{PartnerUserID: userNotMember, PlacementKey: placementKey})

	if d.Decision != "NO_AD" || d.Reason != ReasonUserNotInSegment {
		t.Errorf("expected NO_AD/USER_NOT_IN_SEGMENT, got %s/%s", d.Decision, d.Reason)
	}
}

func TestAudienceManifestWithNoLocalEvaluatorFailsClosed(t *testing.T) {
	m := audienceManifest()
	engine, _ := testEngine(&fakeConnector{})
	// No Audience index configured: the Partner has published no attribute
	// mapping, so this Agent cannot know who is in the audience.
	engine.Audience = nil

	d := engine.Decide(context.Background(), testSnapshot(m),
		Request{PartnerUserID: userEligible, PlacementKey: placementKey})

	// §57: an unavailable source is never read as "probably yes". Serving here
	// would show the campaign to every user who hits the placement, which is
	// precisely the audience nobody approved.
	if d.Decision != "NO_AD" {
		t.Fatalf("expected NO_AD when the audience cannot be evaluated, got %s", d.Decision)
	}
	if d.Reason != ReasonSegmentSourceError {
		t.Errorf("expected SEGMENT_SOURCE_ERROR, got %s", d.Reason)
	}
}

func TestAudienceIndexErrorFailsClosed(t *testing.T) {
	m := audienceManifest()
	engine, _ := testEngine(&fakeConnector{})
	engine.Audience = &fakeAudienceIndex{failWith: errors.New("materialization table unreachable")}

	d := engine.Decide(context.Background(), testSnapshot(m),
		Request{PartnerUserID: userEligible, PlacementKey: placementKey})

	if d.Decision != "NO_AD" {
		t.Errorf("expected NO_AD when the local index errors, got %s", d.Decision)
	}
}

func TestLegacySegmentManifestStillUsesTheConnector(t *testing.T) {
	// §19 / §80: a v5 manifest must keep working while v6 rolls out. An Agent
	// upgraded ahead of the control plane still sees segment-targeted
	// manifests in the field.
	m := testManifest(nil)
	conn := &fakeConnector{members: map[string]bool{userEligible + "|" + segmentKey: true}}
	engine, _ := testEngine(conn)
	index := &fakeAudienceIndex{}
	engine.Audience = index

	d := engine.Decide(context.Background(), testSnapshot(m),
		Request{PartnerUserID: userEligible, PlacementKey: placementKey})

	if d.Decision != "SHOW" {
		t.Fatalf("a legacy segment manifest should still serve, got %s (%s)", d.Decision, d.Reason)
	}
	if index.calls != 0 {
		t.Error("the audience index was consulted for a segment-targeted manifest")
	}
	// No audience was compiled on the §19 path, so there is no version to
	// report and the field is omitted rather than reported as a misleading 0.
	if d.AudienceMaterializationVersion != 0 {
		t.Errorf("a segment manifest reported a materialization version: %d",
			d.AudienceMaterializationVersion)
	}
}
