package managed

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/source"
)

// Publisher tells Oolix what this Agent can answer.
type Publisher func(ctx context.Context, caps Capabilities) error

// QualityReporter tells Oolix how complete the copy is.
type QualityReporter func(ctx context.Context, q Quality) error

// FullSyncEvery is how often a Partner with an updated-at column still gets a
// full sync -- the only kind that notices customers deleted from their table.
const FullSyncEvery = 7 * 24 * time.Hour

// ErrNotSetUp means the setup page has not been completed yet.
var ErrNotSetUp = errors.New("choose a database and a customer table first")

// Runner keeps the local copy fresh: every night at the Partner's chosen hour,
// once soon after start-up if the copy is more than a day old, and whenever
// the setup page asks.
type Runner struct {
	Store  *localstore.Store
	Logger *slog.Logger
	// Open connects to the Partner's database.
	Open func(ctx context.Context, cfg source.Config) (source.Source, error)
	// Now is injectable for tests.
	Now func() time.Time

	trigger   chan struct{}
	wake      chan struct{}
	publisher atomic.Pointer[Publisher]
	quality   atomic.Pointer[QualityReporter]
	running   atomic.Pointer[time.Time]

	mu     sync.Mutex // one sync, publish or delete at a time
	cancel sync.Mutex // guards stop
	stop   context.CancelFunc
}

func NewRunner(store *localstore.Store, logger *slog.Logger) *Runner {
	return &Runner{
		Store: store, Logger: logger, Open: source.Open, Now: time.Now,
		trigger: make(chan struct{}, 1), wake: make(chan struct{}, 1),
	}
}

// SetPublisher is called once the Agent is registered with Oolix. Anything
// that could not be published before then is published now.
func (r *Runner) SetPublisher(ctx context.Context, p Publisher) {
	r.publisher.Store(&p)
	r.mu.Lock()
	defer r.mu.Unlock()
	s := Settings{r.Store}
	m, err := s.Mapping(ctx)
	if err != nil || m == nil || m.PublishedAt == nil {
		return
	}
	if last, err := s.LastGoodSync(ctx); err == nil && last != nil {
		r.publish(ctx, *m, last)
	}
}

// SetQualityReporter is called once the Agent is registered with Oolix.
func (r *Runner) SetQualityReporter(q QualityReporter) { r.quality.Store(&q) }

// SyncNow asks for a sync as soon as possible. It returns false when one is
// already waiting to start.
func (r *Runner) SyncNow() bool {
	select {
	case r.trigger <- struct{}{}:
		return true
	default:
		return false
	}
}

// Reschedule makes the runner re-read the sync hour.
func (r *Runner) Reschedule() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// RunningSince is when the sync in progress started, or nil.
func (r *Runner) RunningSince() *time.Time { return r.running.Load() }

// NextRun is when the nightly sync will next run, or nil when syncing is off.
func (r *Runner) NextRun(ctx context.Context) *time.Time {
	m, err := Settings{r.Store}.Mapping(ctx)
	if err != nil || m == nil || m.PublishedAt == nil {
		return nil
	}
	next := nextRun(r.Now(), m.SyncHour, location(m.Location))
	return &next
}

// Run schedules syncs until ctx ends.
func (r *Runner) Run(ctx context.Context) {
	catchUp := true
	for {
		wait, due := r.plan(ctx, catchUp)
		catchUp = false
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-r.wake:
			timer.Stop()
			continue
		case <-r.trigger:
			timer.Stop()
			// Asked for from the setup page: always in full.
			if _, err := r.SyncOnce(ctx); err != nil && !errors.Is(err, ErrNotSetUp) && ctx.Err() == nil {
				r.Logger.Warn("sync failed; the previous copy is still being served", "error", err.Error())
			}
			continue
		case <-timer.C:
			if !due {
				continue
			}
		}
		if _, err := r.syncWith(ctx, false); err != nil && !errors.Is(err, ErrNotSetUp) && ctx.Err() == nil {
			r.Logger.Warn("sync failed; the previous copy is still being served", "error", err.Error())
		}
	}
}

// plan says how long to wait and whether a sync is due when the wait ends.
func (r *Runner) plan(ctx context.Context, catchUp bool) (time.Duration, bool) {
	s := Settings{r.Store}
	m, err := s.Mapping(ctx)
	if err != nil || m == nil || m.PublishedAt == nil {
		return time.Hour, false
	}
	now := r.Now()
	if catchUp {
		// The Agent was stopped over a scheduled sync, or has never synced.
		if last, _ := s.LastGoodSync(ctx); last == nil || now.Sub(last.FinishedAt) > 24*time.Hour {
			return time.Minute, true
		}
	}
	return nextRun(now, m.SyncHour, location(m.Location)).Sub(now), true
}

func nextRun(after time.Time, hour int, loc *time.Location) time.Time {
	t := after.In(loc)
	next := time.Date(t.Year(), t.Month(), t.Day(), hour, 0, 0, 0, loc)
	if !next.After(t) {
		next = next.AddDate(0, 0, 1)
	}
	return next
}

func location(name string) *time.Location {
	if name != "" && name != "Asia/Kolkata" {
		if l, err := time.LoadLocation(name); err == nil {
			return l
		}
	}
	return clean.India
}

// SyncOnce copies the customer table now, in full, then publishes if
// anything Oolix should know about changed.
func (r *Runner) SyncOnce(ctx context.Context) (*Report, error) {
	return r.syncWith(ctx, true)
}

// incrementalSince says whether a scheduled sync may read only the customers
// changed since the last one, and from when: never without an updated-at
// column, a full sync in the last week made with the same choices, and a
// watermark to start from.
func (r *Runner) incrementalSince(ctx context.Context, m Mapping) (time.Time, bool) {
	if m.UpdatedColumn == "" {
		return time.Time{}, false
	}
	s := Settings{r.Store}
	full, err := s.LastFullSync(ctx)
	if err != nil || full == nil || r.Now().Sub(full.FinishedAt) >= FullSyncEvery ||
		full.Fingerprint != m.Fingerprint() {
		return time.Time{}, false
	}
	mark, err := s.Watermark(ctx)
	if err != nil || mark == nil {
		return time.Time{}, false
	}
	// A little overlap: a row committed late with an earlier time is still
	// read. Applying a change twice is harmless.
	return mark.Add(-10 * time.Minute), true
}

func (r *Runner) syncWith(ctx context.Context, full bool) (*Report, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	s := Settings{r.Store}
	cfg, err := s.Source(ctx)
	if err != nil {
		return nil, err
	}
	m, err := s.Mapping(ctx)
	if err != nil {
		return nil, err
	}
	if cfg == nil || m == nil || m.Table == "" {
		return nil, ErrNotSetUp
	}
	m.Location = cfg.Location

	ctx, stop := context.WithCancel(ctx)
	r.cancel.Lock()
	r.stop = stop
	r.cancel.Unlock()
	defer func() {
		r.cancel.Lock()
		r.stop = nil
		r.cancel.Unlock()
		stop()
	}()

	started := r.Now().UTC()
	r.running.Store(&started)
	defer r.running.Store(nil)

	var runID int64
	if err := r.Store.Pool.QueryRow(ctx,
		`INSERT INTO oolix_sync_runs (started_at, status) VALUES ($1, 'RUNNING') RETURNING id`,
		started).Scan(&runID); err != nil {
		return nil, err
	}

	since, incremental := r.incrementalSince(ctx, *m)
	if full {
		incremental = false
	}
	rep, err := r.copy(ctx, *cfg, *m, incremental, since)
	rep.FinishedAt = r.Now().UTC()
	status := "SUCCEEDED"
	if err != nil {
		status, rep.Error = "FAILED", err.Error()
	}
	// Recorded even when ctx was cancelled, so the history shows why.
	done := context.WithoutCancel(ctx)
	report, _ := json.Marshal(rep)
	if _, dbErr := r.Store.Pool.Exec(done,
		`UPDATE oolix_sync_runs SET finished_at = $2, status = $3, report = $4, error = NULLIF($5, '')
		 WHERE id = $1`, runID, rep.FinishedAt, status, report, rep.Error); dbErr != nil {
		r.Logger.Warn("could not record the sync in its history", "error", dbErr.Error())
	}
	if putErr := r.Store.Put(done, keyLastSync, rep); putErr != nil {
		r.Logger.Warn("could not record the sync", "error", putErr.Error())
	}
	if err != nil {
		return &rep, err
	}
	if err := r.Store.Put(done, keyLastGood, rep); err != nil {
		return &rep, err
	}
	if rep.Watermark != nil {
		if err := r.Store.Put(done, keyMark, *rep.Watermark); err != nil {
			return &rep, err
		}
	}
	if rep.Mode == ModeFull {
		rep.Fingerprint = m.Fingerprint()
		if err := r.Store.Put(done, keyLastFull, rep); err != nil {
			return &rep, err
		}
	}
	r.Logger.Info("sync finished", "mode", rep.Mode,
		"customers", rep.Customers, "not_consented", rep.NotConsented,
		"rows_read", rep.RowsRead, "took", rep.FinishedAt.Sub(rep.StartedAt).Round(time.Second).String())

	if m.PublishedAt != nil {
		r.publish(done, *m, &rep)
		if rep.Mode == ModeFull {
			r.reportQuality(done, *m, &rep)
		}
	}
	return &rep, nil
}

// reportQuality tells Oolix how complete the copy is, after a full sync. A
// failure is logged and left for the next one: nothing depends on it.
func (r *Runner) reportQuality(ctx context.Context, m Mapping, rep *Report) {
	q := r.quality.Load()
	if q == nil {
		return
	}
	caps, err := BuildCapabilities(m, rep)
	if err != nil {
		return
	}
	if err := (*q)(ctx, BuildQuality(caps, rep)); err != nil {
		r.Logger.Warn("reporting data quality to Oolix failed", "error", err.Error())
	}
}

func (r *Runner) copy(ctx context.Context, cfg source.Config, m Mapping, incremental bool,
	since time.Time) (Report, error) {
	src, err := r.Open(ctx, cfg)
	if err != nil {
		return Report{StartedAt: r.Now().UTC(), Mode: ModeFull}, fmt.Errorf("connecting to your database: %w", err)
	}
	defer src.Close()
	if _, ok := src.(source.SinceStreamer); incremental && ok {
		return SyncChanges(ctx, src, r.Store, m, since, r.Now())
	}
	return Sync(ctx, src, r.Store, m, r.Now())
}

// publish sends the capability list when it differs from what Oolix already
// has, or when the last attempt failed. Publishing the same list every night
// would only add versions nobody needs.
func (r *Runner) publish(ctx context.Context, m Mapping, last *Report) {
	p := r.publisher.Load()
	if p == nil {
		return // not registered yet: SetPublisher publishes once it is
	}
	s := Settings{r.Store}
	caps, err := BuildCapabilities(m, last)
	if err == nil {
		if prev, _ := s.Published(ctx); prev != nil && prev.Error == "" && !prev.Withdrawn &&
			sameCapabilities(prev.Capabilities, caps) {
			return
		}
		err = (*p)(ctx, caps)
	}
	rec := PublishRecord{At: r.Now().UTC(), Capabilities: caps}
	if err != nil {
		rec.Error = err.Error()
		r.Logger.Warn("publishing to Oolix failed; will retry after the next sync", "error", rec.Error)
	} else {
		r.Logger.Info("published to Oolix", "attributes", len(caps.Attributes))
	}
	if putErr := s.Store.Put(ctx, keyPublish, rec); putErr != nil {
		r.Logger.Warn("could not record the publish", "error", putErr.Error())
	}
}

func sameCapabilities(a, b Capabilities) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// DeleteCopy stops syncing, tells Oolix the attributes are no longer
// available, and deletes everything copied from the Partner's database. The
// connection settings and the choices made on the setup page are kept, so
// publishing again is one click.
func (r *Runner) DeleteCopy(ctx context.Context) error {
	r.cancel.Lock()
	if r.stop != nil {
		r.stop()
	}
	r.cancel.Unlock()

	r.mu.Lock()
	defer r.mu.Unlock()

	s := Settings{r.Store}
	if m, err := s.Mapping(ctx); err != nil {
		return err
	} else if m != nil && m.PublishedAt != nil {
		m.PublishedAt = nil
		if err := s.SaveMapping(ctx, *m); err != nil {
			return err
		}
	}
	r.Reschedule()

	// Withdrawn first: no Buyer should be offered what can no longer be served.
	if prev, err := s.Published(ctx); err == nil && prev != nil && !prev.Withdrawn && len(prev.Capabilities.Attributes) > 0 {
		rec := PublishRecord{At: r.Now().UTC(), Capabilities: prev.Capabilities.Withdrawn(), Withdrawn: true}
		if p := r.publisher.Load(); p != nil {
			if err := (*p)(ctx, rec.Capabilities); err != nil {
				rec.Error = err.Error()
			}
		} else {
			rec.Error = "this Agent is not registered with Oolix"
		}
		if err := s.Store.Put(ctx, keyPublish, rec); err != nil {
			return err
		}
	}

	if err := r.Store.DeleteCopiedData(ctx); err != nil {
		return err
	}
	for _, key := range []string{keyLastSync, keyLastGood} {
		if err := r.Store.Delete(ctx, key); err != nil {
			return err
		}
	}
	// The history holds counts and a few unrecognised values from the table.
	_, err := r.Store.Pool.Exec(ctx, `DELETE FROM oolix_sync_runs`)
	r.Logger.Info("copied data deleted at the Partner's request")
	return err
}
