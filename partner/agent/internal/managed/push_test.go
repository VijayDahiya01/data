package managed

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/source"
)

const pushCSV = `customer_id,City,marketing_opt_in
C1,Mumbai,yes
C2,Pune,yes
`

func pushRunner(t *testing.T) (*Runner, *localstore.Store, Mapping, source.Source) {
	t.Helper()
	store := localStore(t)
	ctx := context.Background()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "customers.csv"), []byte(pushCSV), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := source.Config{Kind: source.File, Folder: dir, Location: "Asia/Kolkata"}
	src, err := source.Open(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = src.Close() })
	now := time.Now()
	m := Mapping{Table: "customers.csv", IDColumn: "customer_id",
		Attributes:  map[string]AttributeMapping{"city": {Column: "City", Publish: true}},
		Consent:     ConsentMapping{Column: "marketing_opt_in"},
		PublishedAt: &now}
	s := Settings{store}
	if err := s.SaveSource(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveMapping(ctx, m); err != nil {
		t.Fatal(err)
	}
	r := NewRunner(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return r, store, m, src
}

func inCopy(t *testing.T, store *localstore.Store, id string) (city string, consented bool) {
	t.Helper()
	ctx := context.Background()
	_ = store.Pool.QueryRow(ctx, `SELECT city FROM oolix_audience_attributes WHERE partner_user_id = $1`,
		store.ScrambleID(id)).Scan(&city)
	_ = store.Pool.QueryRow(ctx, `SELECT eligible FROM oolix_user_consent WHERE partner_user_id = $1`,
		store.ScrambleID(id)).Scan(&consented)
	return city, consented
}

func TestAWithdrawalOutlivesTheTableUntilConsentIsGivenAgain(t *testing.T) {
	_, store, m, src := pushRunner(t)
	ctx := context.Background()
	if _, err := Sync(ctx, src, store, m, time.Now()); err != nil {
		t.Fatal(err)
	}
	if city, ok := inCopy(t, store, "C1"); city != "MUMBAI" || !ok {
		t.Fatalf("before: %q %v", city, ok)
	}

	// Out at once: no attributes, no consent, so no ad.
	if err := WithdrawConsent(ctx, store, "C1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if city, ok := inCopy(t, store, "C1"); city != "" || ok {
		t.Fatalf("after withdrawing: %q %v", city, ok)
	}
	// The table still says yes; the refresh keeps them out anyway.
	rep, err := Sync(ctx, src, store, m, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if city, _ := inCopy(t, store, "C1"); city != "" || rep.Customers != 1 || rep.NotConsented != 1 {
		t.Fatalf("refresh after withdrawing: %q, %+v", city, rep)
	}
	// Given again: back at the next refresh.
	if err := RestoreConsent(ctx, store, "C1"); err != nil {
		t.Fatal(err)
	}
	if _, err := Sync(ctx, src, store, m, time.Now()); err != nil {
		t.Fatal(err)
	}
	if city, ok := inCopy(t, store, "C1"); city != "MUMBAI" || !ok {
		t.Fatalf("after restoring: %q %v", city, ok)
	}
}

func TestConsentDatedAfterAWithdrawalCounts(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	dir := t.TempDir()
	csv := "customer_id,City,opted_in_at\nC1,Mumbai," + time.Now().Add(48*time.Hour).Format("2006-01-02 15:04") + "\n" +
		"C2,Pune,2020-01-01 10:00\n"
	if err := os.WriteFile(filepath.Join(dir, "customers.csv"), []byte(csv), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := source.Open(ctx, source.Config{Kind: source.File, Folder: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	m := Mapping{Table: "customers.csv", IDColumn: "customer_id",
		Attributes: map[string]AttributeMapping{"city": {Column: "City", Publish: true}},
		Consent:    ConsentMapping{Column: "opted_in_at"}}
	// Both withdrew yesterday. C1's table records consent given since; C2's
	// is from 2020.
	yesterday := time.Now().Add(-24 * time.Hour)
	for _, id := range []string{"C1", "C2"} {
		if err := WithdrawConsent(ctx, store, id, yesterday); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Sync(ctx, src, store, m, time.Now().Add(72*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if city, _ := inCopy(t, store, "C1"); city != "MUMBAI" {
		t.Error("consent given after the withdrawal should count")
	}
	if city, _ := inCopy(t, store, "C2"); city != "" {
		t.Error("consent from before the withdrawal should not")
	}
}

func TestPushedCustomersAreCleanedAndApplied(t *testing.T) {
	r, store, m, src := pushRunner(t)
	ctx := context.Background()
	if _, err := Sync(ctx, src, store, m, time.Now()); err != nil {
		t.Fatal(err)
	}

	rep, err := r.ApplyPushed(ctx, []source.Row{
		{"customer_id": "C2", "City": "bombay", "marketing_opt_in": "Y"},
		{"customer_id": "C3", "City": "Gurgaon", "marketing_opt_in": "yes"},
		{"customer_id": "C1", "City": "Mumbai", "marketing_opt_in": "no"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Mode != ModePushed || rep.Changed != 3 || rep.NotConsented != 1 {
		t.Errorf("push: %+v", rep)
	}
	for id, want := range map[string]string{"C1": "", "C2": "MUMBAI", "C3": "GURUGRAM"} {
		if city, _ := inCopy(t, store, id); city != want {
			t.Errorf("%s: %q, want %q", id, city, want)
		}
	}

	// A partial row would blank what it leaves out, so it is refused.
	_, err = r.ApplyPushed(ctx, []source.Row{{"customer_id": "C2", "City": "Pune"}})
	var rowsErr *PushRowsError
	if !errors.As(err, &rowsErr) {
		t.Errorf("a row without its consent column: %v", err)
	}
	// Nothing is applied while a refresh runs.
	r.mu.Lock()
	_, err = r.ApplyPushed(ctx, []source.Row{{"customer_id": "C2", "City": "Pune", "marketing_opt_in": "Y"}})
	r.mu.Unlock()
	if !errors.Is(err, ErrBusy) {
		t.Errorf("during a refresh: %v", err)
	}
	// Nor before anything is published.
	unpublished := m
	unpublished.PublishedAt = nil
	if err := (Settings{store}).SaveMapping(ctx, unpublished); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ApplyPushed(ctx, []source.Row{{"customer_id": "C2"}}); !errors.Is(err, ErrNotPublished) {
		t.Errorf("before publishing: %v", err)
	}
}

func TestPushTokens(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	if PushAuthorized(ctx, store, "anything") {
		t.Error("authorised before a token exists")
	}
	token, err := PushToken(ctx, store)
	if err != nil || len(token) < 40 {
		t.Fatalf("token %q, %v", token, err)
	}
	if again, _ := PushToken(ctx, store); again != token {
		t.Error("the token changed")
	}
	if !PushAuthorized(ctx, store, token) || PushAuthorized(ctx, store, token+"x") || PushAuthorized(ctx, store, "") {
		t.Error("token check")
	}
}
