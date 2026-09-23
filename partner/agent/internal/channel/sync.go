package channel

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Driving an external activation from the signed manifest -- §47.7-§47.11,
// §48.6-§48.9.
//
// Oolix signs a manifest only after eligibility passes, so the presence of an
// external manifest in the snapshot IS the authority to upload. This file
// turns that authority into an upload, and -- just as importantly -- turns its
// withdrawal into a removal.
//
// # The kill switch has to reach outside
//
// §24 lets a Partner stop serving immediately, enforced locally so it works
// even when Oolix is unreachable. For owned media that means the Agent stops
// answering. For an external channel it has to mean more: the audience is
// already sitting inside Meta or Google, and a campaign that keeps running
// there is not stopped by anything the Agent declines to do. So a killed or
// revoked activation triggers a REMOVAL, not merely a skip. Treating it as a
// skip is the difference between "we stopped" and "we stopped trying".

// ActivationView is the subset of a manifest this package needs.
//
// A narrow struct rather than the manifest itself, so the sync loop cannot
// accidentally depend on fields that have nothing to do with uploading.
type ActivationView struct {
	ActivationID string
	Channel      string
	AudienceName string
	StartAt      time.Time
	EndAt        time.Time
	// Killed or revoked: both mean the audience must come back out.
	Stopped bool
}

// Reporter sends the outcome back to Oolix (§47.11, §48.9).
//
// Only the resource id, status and counts travel: §47.11 is explicit that the
// raw matching payload is not stored centrally.
type Reporter interface {
	ReportSync(ctx context.Context, activationID, provider, resourceID, status string, accepted, skipped int) error
}

// MemberSource reads the matching identifiers for one activation.
type MemberSource interface {
	Members(ctx context.Context, activationID string) ([]Member, error)
}

// Syncer keeps external audiences in step with the manifests on offer.
type Syncer struct {
	adapters map[string]Adapter
	source   MemberSource
	reporter Reporter
	log      *slog.Logger
	consent  ConsentState

	mu sync.Mutex
	// state remembers what has already been uploaded, so a snapshot refresh
	// every thirty seconds does not re-upload the whole audience every time.
	state map[string]*syncState
}

type syncState struct {
	resourceID string
	lastSynced time.Time
	removed    bool
}

// SyncerOptions configures the loop.
type SyncerOptions struct {
	Adapters map[string]Adapter
	Source   MemberSource
	Reporter Reporter
	Logger   *slog.Logger
	// Consent is the audience-level lawful basis established by the
	// eligibility gate before any manifest was signed (§47.5, §48.4). It is
	// passed through rather than assumed, so that the thing asserting consent
	// to a platform is the thing that actually checked it.
	Consent ConsentState
}

func NewSyncer(o SyncerOptions) *Syncer {
	return &Syncer{
		adapters: o.Adapters,
		source:   o.Source,
		reporter: o.Reporter,
		log:      o.Logger,
		consent:  o.Consent,
		state:    make(map[string]*syncState),
	}
}

// RefreshInterval is how often an external audience is rebuilt.
//
// Far slower than the control sync. Membership changes on the order of a day,
// platform ingestion is rate-limited, and re-uploading a large audience every
// thirty seconds would achieve nothing except exhausting a Partner's quota.
const RefreshInterval = 6 * time.Hour

// Reconcile brings every external activation in the snapshot into the state
// its manifest calls for.
//
// Errors are collected rather than returned on the first failure: one Partner
// having a bad Meta token must not stop a different activation on Google from
// syncing.
func (s *Syncer) Reconcile(ctx context.Context, views []ActivationView) []error {
	var errs []error

	for _, v := range views {
		adapter, ok := s.adapters[v.Channel]
		if !ok {
			// Owned media, or a channel this Agent was not configured for.
			continue
		}

		if err := s.reconcileOne(ctx, adapter, v); err != nil {
			errs = append(errs, fmt.Errorf("activation %s: %w", v.ActivationID, err))
		}
	}
	return errs
}

func (s *Syncer) reconcileOne(ctx context.Context, adapter Adapter, v ActivationView) error {
	now := time.Now()

	// Stopped, or past its end date. Either way the audience must come out of
	// the platform -- the campaign is running there, not here.
	if v.Stopped || (!v.EndAt.IsZero() && now.After(v.EndAt)) {
		return s.remove(ctx, adapter, v)
	}

	// Not started yet. Uploading early would let a campaign deliver before the
	// date the Partner approved.
	if !v.StartAt.IsZero() && now.Before(v.StartAt) {
		return nil
	}

	st := s.stateFor(v.ActivationID)
	if !st.removed && !st.lastSynced.IsZero() && now.Sub(st.lastSynced) < RefreshInterval {
		return nil
	}

	members, err := s.source.Members(ctx, v.ActivationID)
	if err != nil {
		return fmt.Errorf("read segment: %w", err)
	}

	res, syncErr := adapter.Sync(ctx, SyncRequest{
		ActivationID:       v.ActivationID,
		AudienceName:       v.AudienceName,
		Members:            members,
		ExistingResourceID: st.resourceID,
		Consent:            s.consent,
	})

	status := "READY"
	if syncErr != nil {
		status = "FAILED"
	}

	// Reported either way. A failure Oolix never hears about looks exactly
	// like an upload that was never attempted, and §47.11 is how the control
	// plane knows an activation is actually delivering.
	if s.reporter != nil {
		if err := s.reporter.ReportSync(ctx, v.ActivationID, string(adapter.Provider()),
			res.ResourceID, status, res.Accepted, res.Skipped); err != nil {
			s.log.Warn("could not report sync status to Oolix",
				"activation_id", v.ActivationID, "error", err.Error())
		}
	}

	if syncErr != nil {
		return syncErr
	}

	s.mu.Lock()
	st.resourceID = res.ResourceID
	st.lastSynced = now
	st.removed = false
	s.mu.Unlock()

	return nil
}

func (s *Syncer) remove(ctx context.Context, adapter Adapter, v ActivationView) error {
	st := s.stateFor(v.ActivationID)
	if st.removed || st.resourceID == "" {
		// Nothing was ever uploaded, or it has already been withdrawn.
		return nil
	}

	if err := adapter.Remove(ctx, st.resourceID); err != nil {
		return fmt.Errorf("remove audience: %w", err)
	}

	s.mu.Lock()
	st.removed = true
	s.mu.Unlock()

	if s.reporter != nil {
		if err := s.reporter.ReportSync(ctx, v.ActivationID, string(adapter.Provider()),
			st.resourceID, "REMOVED", 0, 0); err != nil {
			s.log.Warn("could not report removal to Oolix",
				"activation_id", v.ActivationID, "error", err.Error())
		}
	}

	s.log.Info("external audience removed",
		"activation_id", v.ActivationID, "provider", adapter.Provider())
	return nil
}

func (s *Syncer) stateFor(activationID string) *syncState {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.state[activationID]
	if !ok {
		st = &syncState{}
		s.state[activationID] = st
	}
	return st
}
