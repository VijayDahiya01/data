package main

import (
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/addecision"
	"github.com/oolix/partner-agent/internal/config"
	"github.com/oolix/partner-agent/internal/manifest"
)

// externalViews decides what the external sync loop acts on, and the kill
// switch is applied here rather than in the adapter. That placement is the
// point: for an owned channel "stopped" means the Agent stops answering, but
// an audience already sitting inside Meta is not stopped by anything the Agent
// declines to do (§24). It has to come back out.

func snapshotWith(channel string, activationID string) *addecision.ConfigSnapshot {
	return &addecision.ConfigSnapshot{
		Candidates: []addecision.Candidate{{
			Manifest: &manifest.Payload{
				ActivationID: activationID,
				Channel:      channel,
				StartAt:      time.Now().Add(-time.Hour),
				EndAt:        time.Now().Add(time.Hour),
			},
		}},
		KilledActivationIDs:  map[string]bool{},
		RevokedActivationIDs: map[string]bool{},
		KilledPlacementKeys:  map[string]bool{},
	}
}

func TestOwnedMediaIsNotHandedToTheExternalSync(t *testing.T) {
	for _, ch := range []string{"PARTNER_WEB", "PARTNER_APP"} {
		if got := externalViews(snapshotWith(ch, "act-1")); len(got) != 0 {
			t.Errorf("%s produced %d external views; want 0", ch, len(got))
		}
	}
}

func TestExternalChannelsAreSelected(t *testing.T) {
	for _, ch := range []string{"META", "GOOGLE"} {
		got := externalViews(snapshotWith(ch, "act-1"))
		if len(got) != 1 {
			t.Fatalf("%s produced %d views; want 1", ch, len(got))
		}
		if got[0].Channel != ch || got[0].ActivationID != "act-1" {
			t.Errorf("view = %+v", got[0])
		}
		if got[0].Stopped {
			t.Error("a live activation was marked stopped")
		}
	}
}

func TestAKillSwitchMarksTheActivationStopped(t *testing.T) {
	// Each of the three ways an activation can be stopped has to reach the
	// external sync, because each one has to result in a removal.
	t.Run("global kill switch", func(t *testing.T) {
		snap := snapshotWith("META", "act-1")
		snap.KillSwitchAll = true
		if !externalViews(snap)[0].Stopped {
			t.Error("a global kill switch did not stop the external activation")
		}
	})

	t.Run("activation kill switch", func(t *testing.T) {
		snap := snapshotWith("META", "act-1")
		snap.KilledActivationIDs["act-1"] = true
		if !externalViews(snap)[0].Stopped {
			t.Error("an activation kill switch did not stop the external activation")
		}
	})

	t.Run("revocation", func(t *testing.T) {
		snap := snapshotWith("GOOGLE", "act-1")
		snap.RevokedActivationIDs["act-1"] = true
		if !externalViews(snap)[0].Stopped {
			t.Error("a revocation did not stop the external activation")
		}
	})
}

func TestAKillSwitchForAnotherActivationDoesNotStopThisOne(t *testing.T) {
	snap := snapshotWith("META", "act-1")
	snap.KilledActivationIDs["act-2"] = true
	if externalViews(snap)[0].Stopped {
		t.Error("an unrelated kill switch stopped this activation")
	}
}

func TestTheAudienceNameDoesNotDescribeTheSegment(t *testing.T) {
	// The name is visible to everyone with access to the ad account. An
	// audience called "high-value lapsed customers" publishes something the
	// Partner never agreed to.
	got := externalViews(snapshotWith("META", "act-1"))[0]
	if got.AudienceName == "" {
		t.Fatal("audience name is empty")
	}
	for _, leak := range []string{"segment", "rule", "lapsed", "high-value"} {
		if containsFold(got.AudienceName, leak) {
			t.Errorf("audience name %q describes the audience", got.AudienceName)
		}
	}
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func containsFold(haystack, needle string) bool {
	h, n := []rune(haystack), []rune(needle)
	if len(n) > len(h) {
		return false
	}
	lower := func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + 32
		}
		return r
	}
	for i := 0; i+len(n) <= len(h); i++ {
		match := true
		for j := range n {
			if lower(h[i+j]) != lower(n[j]) {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// buildChannelSyncer must refuse rather than skip. A Partner who switched Meta
// on and saw nothing happen would reasonably conclude it was working.

func TestNoExternalChannelEnabledBuildsNothing(t *testing.T) {
	cfg := &config.Config{}
	got, err := buildChannelSyncer(cfg, nil, nil, quietLogger())
	if err != nil {
		t.Fatalf("unexpected error with no channels enabled: %v", err)
	}
	if got != nil {
		t.Error("a syncer was built with no channel enabled")
	}
}

func TestEnabledChannelWithoutAnAudienceMappingIsRefused(t *testing.T) {
	// External activation uploads the MATERIALIZED audience, so without the
	// audience machinery there is nothing to upload.
	cfg := &config.Config{}
	cfg.Channels.Meta.Enabled = true
	cfg.Channels.Meta.AccessToken = "t"
	cfg.Channels.Meta.AdAccountID = "act-1"

	_, err := buildChannelSyncer(cfg, nil, nil, quietLogger())
	if err == nil {
		t.Fatal("expected a refusal when no audience mapping is configured")
	}
	if !containsFold(err.Error(), "connector.audience") {
		t.Errorf("the error should name what is missing; got %q", err)
	}
}

func TestEnabledChannelWithAnUnresolvableSecretIsRefused(t *testing.T) {
	cfg := &config.Config{}
	cfg.Channels.Meta.Enabled = true
	cfg.Channels.Meta.AccessTokenSecretRef = "secret://nothing-sets-this"
	cfg.Channels.Meta.AdAccountID = "act-1"

	if _, err := buildChannelSyncer(cfg, nil, nil, quietLogger()); err == nil {
		t.Error("expected a refusal when the token secret does not resolve")
	}
}
