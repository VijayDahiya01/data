package eventbuffer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/state"
)

// This buffer carries the numbers a Partner is PAID on -- §18, §49, §102.
//
// Both directions cost real money and neither announces itself. A dropped
// batch under-pays the Partner for delivery that happened; a batch uploaded
// twice under two different ids over-pays, and the Buyer is billed for it.
// Everything below is one of those two failures.

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeStore is the Agent's local counter store.
type fakeStore struct {
	mu       sync.Mutex
	counters map[string]state.Counter
	drains   int
	drainErr error
}

func (s *fakeStore) DrainCounters(context.Context) (map[string]state.Counter, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.drains++
	if s.drainErr != nil {
		return nil, s.drainErr
	}
	out := s.counters
	// Draining empties the store, exactly as the real one does. That is what
	// makes a lost batch unrecoverable, and why these tests exist.
	s.counters = map[string]state.Counter{}
	return out, nil
}

func (s *fakeStore) FrequencyCount(context.Context, string, string, time.Duration) (int, error) {
	return 0, nil
}
func (s *fakeStore) RecordImpression(context.Context, string, string, time.Duration) error {
	return nil
}
func (s *fakeStore) RecordClick(context.Context, string) error             { return nil }
func (s *fakeStore) SpendEstimate(context.Context, string) (int64, error)  { return 0, nil }
func (s *fakeStore) AddSpendEstimate(context.Context, string, int64) error { return nil }
func (s *fakeStore) Close() error                                          { return nil }

type received struct {
	batchID    string
	idemKey    string
	counters   []counterDTO
	authHeader string
}

func serverThat(t *testing.T, status func(n int) int) (*httptest.Server, *[]received) {
	t.Helper()
	var got []received
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body struct {
			BatchID  string       `json:"batch_id"`
			Counters []counterDTO `json:"counters"`
		}
		_ = json.Unmarshal(raw, &body)

		mu.Lock()
		got = append(got, received{
			batchID:    body.BatchID,
			idemKey:    r.Header.Get("Idempotency-Key"),
			counters:   body.Counters,
			authHeader: r.Header.Get("Authorization"),
		})
		n := len(got)
		mu.Unlock()

		w.WriteHeader(status(n))
	}))
	t.Cleanup(srv.Close)
	return srv, &got
}

func uploaderFor(t *testing.T, srv *httptest.Server, store *fakeStore) *Uploader {
	t.Helper()
	return New(srv.Client(), srv.URL, "agent-1", store,
		func(context.Context) (string, error) { return "test-token", nil }, quietLogger())
}

func withCounters() *fakeStore {
	return &fakeStore{counters: map[string]state.Counter{
		"act-1": {Impressions: 120, Clicks: 7},
		"act-2": {Impressions: 40, Clicks: 1},
	}}
}

// --- the money properties ---------------------------------------------------

func TestASuccessfulFlushUploadsEveryCounterOnce(t *testing.T) {
	srv, got := serverThat(t, func(int) int { return http.StatusCreated })
	store := withCounters()

	if err := uploaderFor(t, srv, store).Flush(context.Background()); err != nil {
		t.Fatalf("flush: %v", err)
	}

	if len(*got) != 1 {
		t.Fatalf("expected one upload, got %d", len(*got))
	}
	if len((*got)[0].counters) != 2 {
		t.Errorf("uploaded %d counters; want 2", len((*got)[0].counters))
	}

	var total int64
	for _, c := range (*got)[0].counters {
		total += c.Impressions
	}
	if total != 160 {
		t.Errorf("uploaded %d impressions; want 160 -- the Partner is paid on this", total)
	}
}

func TestAFailedUploadDoesNotLoseTheCounters(t *testing.T) {
	// The store has already been emptied by the drain. If the batch were
	// dropped here the delivery is gone for good, and the Partner is paid for
	// less than they served.
	srv, got := serverThat(t, func(n int) int {
		if n == 1 {
			return http.StatusInternalServerError
		}
		return http.StatusCreated
	})
	store := withCounters()
	u := uploaderFor(t, srv, store)

	if err := u.Flush(context.Background()); err == nil {
		t.Fatal("expected the first flush to fail")
	}
	if u.Pending() != 2 {
		t.Fatalf("after a failed upload, Pending()=%d; the batch was lost", u.Pending())
	}

	if err := u.Flush(context.Background()); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if u.Pending() != 0 {
		t.Errorf("after a successful retry, Pending()=%d; want 0", u.Pending())
	}

	// The counters must have survived intact, not been re-drained from an
	// empty store.
	last := (*got)[len(*got)-1]
	var total int64
	for _, c := range last.counters {
		total += c.Impressions
	}
	if total != 160 {
		t.Errorf("retry carried %d impressions; want the original 160", total)
	}
}

func TestARetryReusesTheSameBatchIdAndIdempotencyKey(t *testing.T) {
	// §22.3 / §57: the server deduplicates on the batch id. A retry that
	// minted a new one would be counted as additional delivery -- the Partner
	// paid twice for the same impressions, and the Buyer billed for them.
	srv, got := serverThat(t, func(n int) int {
		if n <= 2 {
			return http.StatusBadGateway
		}
		return http.StatusCreated
	})
	u := uploaderFor(t, srv, withCounters())

	for i := 0; i < 3; i++ {
		_ = u.Flush(context.Background())
	}

	if len(*got) != 3 {
		t.Fatalf("expected 3 attempts, got %d", len(*got))
	}
	first := (*got)[0].batchID
	if first == "" {
		t.Fatal("no batch id was sent")
	}
	for i, r := range *got {
		if r.batchID != first {
			t.Errorf("attempt %d used batch id %q, first used %q -- this double-counts delivery",
				i+1, r.batchID, first)
		}
		if r.idemKey != first {
			t.Errorf("attempt %d sent Idempotency-Key %q; it must equal the batch id", i+1, r.idemKey)
		}
	}
}

func TestAPendingBatchIsNotOverwrittenByANewDrain(t *testing.T) {
	// The failure this catches: a second flush while a batch is still pending
	// drains the store again and replaces the unsent batch. The first batch's
	// delivery is then never uploaded and never recoverable.
	srv, _ := serverThat(t, func(int) int { return http.StatusInternalServerError })
	store := withCounters()
	u := uploaderFor(t, srv, store)

	for i := 0; i < 4; i++ {
		_ = u.Flush(context.Background())
	}

	if store.drains != 1 {
		t.Errorf("the store was drained %d times while a batch was pending; want 1", store.drains)
	}
	if u.Pending() != 2 {
		t.Errorf("Pending()=%d; the original batch should still be waiting", u.Pending())
	}
}

func TestNothingIsUploadedWhenThereIsNothingToReport(t *testing.T) {
	// An empty batch still costs a request and a row, and makes an idle Agent
	// look like a delivering one.
	srv, got := serverThat(t, func(int) int { return http.StatusCreated })
	store := &fakeStore{counters: map[string]state.Counter{}}

	if err := uploaderFor(t, srv, store).Flush(context.Background()); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if len(*got) != 0 {
		t.Errorf("uploaded %d batches for an empty store; want 0", len(*got))
	}
}

func TestCountersAreNotDrainedWhenTheStoreFails(t *testing.T) {
	srv, got := serverThat(t, func(int) int { return http.StatusCreated })
	store := &fakeStore{drainErr: errors.New("redis unreachable")}

	if err := uploaderFor(t, srv, store).Flush(context.Background()); err == nil {
		t.Fatal("expected a drain failure to surface")
	}
	if len(*got) != 0 {
		t.Error("a batch was uploaded despite the drain failing")
	}
}

func TestTheUploadIsAuthenticated(t *testing.T) {
	// An unauthenticated batch is rejected, which looks exactly like a
	// transient failure and retries forever.
	srv, got := serverThat(t, func(int) int { return http.StatusCreated })
	if err := uploaderFor(t, srv, withCounters()).Flush(context.Background()); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if (*got)[0].authHeader != "Bearer test-token" {
		t.Errorf("authorization header = %q", (*got)[0].authHeader)
	}
}

func TestATokenFailureDoesNotDiscardTheBatch(t *testing.T) {
	// The counters are already drained by this point. Losing them because a
	// token refresh failed would be silent under-payment.
	srv, _ := serverThat(t, func(int) int { return http.StatusCreated })
	store := withCounters()
	u := New(srv.Client(), srv.URL, "agent-1", store,
		func(context.Context) (string, error) { return "", errors.New("token endpoint down") },
		quietLogger())

	if err := u.Flush(context.Background()); err == nil {
		t.Fatal("expected the flush to fail")
	}
	if u.Pending() != 2 {
		t.Errorf("Pending()=%d after a token failure; the batch was lost", u.Pending())
	}
}

func TestEveryCounterCarriesAnHourBucket(t *testing.T) {
	// §49 aggregates by hour. A missing or malformed bucket lands the delivery
	// in the wrong reporting period, which is a reconciliation dispute later.
	srv, got := serverThat(t, func(int) int { return http.StatusCreated })
	if err := uploaderFor(t, srv, withCounters()).Flush(context.Background()); err != nil {
		t.Fatalf("flush: %v", err)
	}

	for _, c := range (*got)[0].counters {
		ts, err := time.Parse(time.RFC3339, c.BucketStart)
		if err != nil {
			t.Fatalf("bucket_start %q is not RFC3339: %v", c.BucketStart, err)
		}
		if ts.Minute() != 0 || ts.Second() != 0 {
			t.Errorf("bucket_start %q is not truncated to the hour", c.BucketStart)
		}
		if ts.Location() != time.UTC {
			t.Errorf("bucket_start %q is not UTC (§53)", c.BucketStart)
		}
	}
}
