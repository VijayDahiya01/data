package channel

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// --- doubles ---------------------------------------------------------------

type fakeAdapter struct {
	mu       sync.Mutex
	provider Provider
	syncs    []SyncRequest
	removes  []string
	syncErr  error
	resource string
}

func (a *fakeAdapter) Provider() Provider { return a.provider }

func (a *fakeAdapter) Sync(_ context.Context, req SyncRequest) (SyncResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.syncs = append(a.syncs, req)
	if a.syncErr != nil {
		return SyncResult{}, a.syncErr
	}
	id := a.resource
	if id == "" {
		id = "res-1"
	}
	return SyncResult{ResourceID: id, Accepted: len(req.Members)}, nil
}

func (a *fakeAdapter) Remove(_ context.Context, resourceID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.removes = append(a.removes, resourceID)
	return nil
}

type fakeSource struct {
	members []Member
	err     error
	calls   int
}

func (s *fakeSource) Members(context.Context, string) ([]Member, error) {
	s.calls++
	return s.members, s.err
}

type report struct {
	activationID, provider, resourceID, status string
	accepted, skipped                          int
}

type fakeReporter struct {
	reports []report
	err     error
}

func (r *fakeReporter) ReportSync(_ context.Context, a, p, res, st string, acc, sk int) error {
	r.reports = append(r.reports, report{a, p, res, st, acc, sk})
	return r.err
}

func newTestSyncer(a *fakeAdapter, src *fakeSource, rep *fakeReporter) *Syncer {
	return NewSyncer(SyncerOptions{
		Adapters: map[string]Adapter{"META": a},
		Source:   src,
		Reporter: rep,
		Logger:   quietLogger(),
		Consent:  ConsentGranted,
	})
}

func liveView() ActivationView {
	return ActivationView{
		ActivationID: "act-1",
		Channel:      "META",
		AudienceName: "Campaign 7",
		StartAt:      time.Now().Add(-time.Hour),
		EndAt:        time.Now().Add(24 * time.Hour),
	}
}

// --- tests -----------------------------------------------------------------

func TestSyncUploadsALiveActivationAndReports(t *testing.T) {
	a := &fakeAdapter{provider: ProviderMeta}
	src := &fakeSource{members: []Member{{Email: "a@example.com"}}}
	rep := &fakeReporter{}

	if errs := newTestSyncer(a, src, rep).Reconcile(context.Background(),
		[]ActivationView{liveView()}); len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}

	if len(a.syncs) != 1 {
		t.Fatalf("expected one upload, got %d", len(a.syncs))
	}
	if a.syncs[0].Consent != ConsentGranted {
		t.Error("consent was not passed through to the adapter")
	}
	if len(rep.reports) != 1 || rep.reports[0].status != "READY" {
		t.Errorf("reports = %+v", rep.reports)
	}
}

// The one that matters most.
func TestAKilledActivationIsRemovedFromThePlatformNotMerelySkipped(t *testing.T) {
	// §24: the audience is already inside Meta. A campaign running there is
	// not stopped by anything the Agent declines to do. "Stopped trying" is
	// not "stopped".
	a := &fakeAdapter{provider: ProviderMeta}
	src := &fakeSource{members: []Member{{Email: "a@example.com"}}}
	rep := &fakeReporter{}
	s := newTestSyncer(a, src, rep)

	// First it goes live and uploads.
	s.Reconcile(context.Background(), []ActivationView{liveView()})
	if len(a.syncs) != 1 {
		t.Fatalf("setup: expected an upload, got %d", len(a.syncs))
	}

	// Then the Partner hits the kill switch.
	killed := liveView()
	killed.Stopped = true
	if errs := s.Reconcile(context.Background(), []ActivationView{killed}); len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}

	if len(a.removes) != 1 {
		t.Fatalf("a killed activation was not removed from the platform (removes=%v)", a.removes)
	}
	if a.removes[0] != "res-1" {
		t.Errorf("removed the wrong resource: %q", a.removes[0])
	}
	last := rep.reports[len(rep.reports)-1]
	if last.status != "REMOVED" {
		t.Errorf("removal was not reported to Oolix: %+v", last)
	}
}

func TestAnEndedCampaignIsRemoved(t *testing.T) {
	a := &fakeAdapter{provider: ProviderMeta}
	s := newTestSyncer(a, &fakeSource{members: []Member{{Email: "a@example.com"}}}, &fakeReporter{})

	s.Reconcile(context.Background(), []ActivationView{liveView()})

	ended := liveView()
	ended.EndAt = time.Now().Add(-time.Minute)
	s.Reconcile(context.Background(), []ActivationView{ended})

	if len(a.removes) != 1 {
		t.Errorf("an ended campaign left its audience in the platform")
	}
}

func TestAnActivationThatHasNotStartedIsNotUploaded(t *testing.T) {
	// Uploading early lets a campaign deliver before the date the Partner
	// approved.
	a := &fakeAdapter{provider: ProviderMeta}
	src := &fakeSource{members: []Member{{Email: "a@example.com"}}}

	future := liveView()
	future.StartAt = time.Now().Add(time.Hour)

	newTestSyncer(a, src, &fakeReporter{}).Reconcile(context.Background(),
		[]ActivationView{future})

	if len(a.syncs) != 0 {
		t.Error("uploaded before the approved start date")
	}
	if src.calls != 0 {
		t.Error("read the segment before the approved start date")
	}
}

func TestRepeatedReconcilesDoNotReUploadImmediately(t *testing.T) {
	// The control snapshot refreshes every thirty seconds. Re-uploading a
	// large audience each time would exhaust a Partner's platform quota and
	// achieve nothing.
	a := &fakeAdapter{provider: ProviderMeta}
	src := &fakeSource{members: []Member{{Email: "a@example.com"}}}
	s := newTestSyncer(a, src, &fakeReporter{})

	for i := 0; i < 5; i++ {
		s.Reconcile(context.Background(), []ActivationView{liveView()})
	}

	if len(a.syncs) != 1 {
		t.Errorf("uploaded %d times; want 1 within the refresh interval", len(a.syncs))
	}
}

func TestReuploadUsesTheExistingResourceID(t *testing.T) {
	// A refresh must target the audience the ad set already points at, or the
	// campaign is left aimed at a stale list.
	a := &fakeAdapter{provider: ProviderMeta}
	s := newTestSyncer(a, &fakeSource{members: []Member{{Email: "a@example.com"}}}, &fakeReporter{})

	s.Reconcile(context.Background(), []ActivationView{liveView()})

	// Force the refresh window open.
	st := s.stateFor("act-1")
	s.mu.Lock()
	st.lastSynced = time.Now().Add(-2 * RefreshInterval)
	s.mu.Unlock()

	s.Reconcile(context.Background(), []ActivationView{liveView()})

	if len(a.syncs) != 2 {
		t.Fatalf("expected a second upload, got %d", len(a.syncs))
	}
	if a.syncs[1].ExistingResourceID != "res-1" {
		t.Errorf("second upload did not reuse the resource id: %q", a.syncs[1].ExistingResourceID)
	}
}

func TestOneBadActivationDoesNotStopTheOthers(t *testing.T) {
	// A Partner with an expired Meta token must not prevent a different
	// activation from syncing.
	bad := &fakeAdapter{provider: ProviderMeta, syncErr: errors.New("token expired")}
	good := &fakeAdapter{provider: ProviderGoogle, resource: "g-1"}
	rep := &fakeReporter{}

	s := NewSyncer(SyncerOptions{
		Adapters: map[string]Adapter{"META": bad, "GOOGLE": good},
		Source:   &fakeSource{members: []Member{{Email: "a@example.com"}}},
		Reporter: rep,
		Logger:   quietLogger(),
		Consent:  ConsentGranted,
	})

	metaView := liveView()
	googleView := liveView()
	googleView.ActivationID = "act-2"
	googleView.Channel = "GOOGLE"

	errs := s.Reconcile(context.Background(), []ActivationView{metaView, googleView})

	if len(errs) != 1 {
		t.Errorf("expected exactly one failure, got %v", errs)
	}
	if len(good.syncs) != 1 {
		t.Error("the healthy activation did not sync")
	}
}

func TestAFailedUploadIsStillReported(t *testing.T) {
	// A failure Oolix never hears about looks exactly like an upload that was
	// never attempted.
	a := &fakeAdapter{provider: ProviderMeta, syncErr: errors.New("boom")}
	rep := &fakeReporter{}

	newTestSyncer(a, &fakeSource{members: []Member{{Email: "a@example.com"}}}, rep).
		Reconcile(context.Background(), []ActivationView{liveView()})

	if len(rep.reports) != 1 || rep.reports[0].status != "FAILED" {
		t.Errorf("failure was not reported: %+v", rep.reports)
	}
}

func TestAFailedUploadIsRetriedRatherThanMarkedDone(t *testing.T) {
	a := &fakeAdapter{provider: ProviderMeta, syncErr: errors.New("boom")}
	s := newTestSyncer(a, &fakeSource{members: []Member{{Email: "a@example.com"}}}, &fakeReporter{})

	s.Reconcile(context.Background(), []ActivationView{liveView()})
	s.Reconcile(context.Background(), []ActivationView{liveView()})

	// The refresh interval must not suppress a retry of something that never
	// succeeded.
	if len(a.syncs) != 2 {
		t.Errorf("a failed upload was treated as done; syncs=%d", len(a.syncs))
	}
}

func TestChannelsWithNoConfiguredAdapterAreIgnored(t *testing.T) {
	// Owned media reaches the same snapshot. It must pass straight through.
	a := &fakeAdapter{provider: ProviderMeta}
	s := newTestSyncer(a, &fakeSource{}, &fakeReporter{})

	owned := liveView()
	owned.Channel = "PARTNER_WEB"

	if errs := s.Reconcile(context.Background(), []ActivationView{owned}); len(errs) != 0 {
		t.Errorf("owned media produced errors: %v", errs)
	}
	if len(a.syncs) != 0 {
		t.Error("an owned-media activation was uploaded to Meta")
	}
}

func TestAReportingFailureDoesNotFailTheUpload(t *testing.T) {
	// The audience is already in the platform. Reporting that fact is
	// important, but failing the sync because the report did not land would
	// cause a re-upload of data that is already there.
	a := &fakeAdapter{provider: ProviderMeta}
	rep := &fakeReporter{err: errors.New("oolix unreachable")}

	errs := newTestSyncer(a, &fakeSource{members: []Member{{Email: "a@example.com"}}}, rep).
		Reconcile(context.Background(), []ActivationView{liveView()})

	if len(errs) != 0 {
		t.Errorf("a reporting failure failed the sync: %v", errs)
	}
}
