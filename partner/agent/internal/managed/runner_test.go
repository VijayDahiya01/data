package managed

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/oolix/partner-agent/internal/audience"
	"github.com/oolix/partner-agent/internal/connector"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/testdb"
)

func TestRunnerServesPublishesAndDeletes(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "customers.csv"), []byte(messyCSV), 0o600); err != nil {
		t.Fatal(err)
	}
	settings := Settings{store}
	cfg := source.Config{Kind: source.File, Folder: dir}
	if err := settings.SaveSource(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	src, err := source.Open(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	m := mappingFor(t, src, "customers.csv")
	src.Close()
	published := time.Now()
	m.PublishedAt, m.Channels = &published, []string{"PARTNER_WEB", "PARTNER_APP"}
	if err := settings.SaveMapping(ctx, m); err != nil {
		t.Fatal(err)
	}

	r := NewRunner(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.Now = func() time.Time { return now }
	var sent []Capabilities
	r.SetPublisher(ctx, func(_ context.Context, c Capabilities) error {
		sent = append(sent, c)
		return nil
	})
	if len(sent) != 0 {
		t.Fatal("published before anything was synced")
	}

	if _, err := r.SyncOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 {
		t.Fatalf("published %d times", len(sent))
	}
	keys := sent[0].Keys()
	for _, want := range []string{"age", "gender", "city", "loyalty_tier", "app_active", "active_user_days"} {
		if !slices.Contains(keys, want) {
			t.Errorf("%s not published: %v", want, keys)
		}
	}
	if !slices.Equal(sent[0].Channels, []string{"PARTNER_WEB", "PARTNER_APP"}) || sent[0].Geographies[0] != "IN" {
		t.Errorf("published %+v", sent[0])
	}

	// Ad decisions arrive with the Partner's own customer id.
	view, err := connector.NewPostgresView(ctx, connector.PostgresOptions{
		DSN: testdb.URL(t, "managed"), MembershipQuery: MembershipQuery,
		ConsentQuery: ConsentQuery, QueryTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer view.Close()
	conn := ScrambledConnector{Connector: view, Scramble: store.ScrambleID}
	checkConsent := func(when string) {
		t.Helper()
		for id, want := range map[string]bool{"C1": true, "C2": true, "C3": true, "C5": false,
			"C7": false, "C8": false, "nobody": false} {
			got, err := conn.IsAdvertisingEligible(ctx, id, "any-purpose")
			if err != nil || got != want {
				t.Errorf("%s: %s eligible = %v (%v), want %v", when, id, got, err, want)
			}
		}
		if member, err := conn.IsMember(ctx, "C1", "some-segment"); err != nil || member {
			t.Errorf("%s: prebuilt segment membership = %v (%v)", when, member, err)
		}
	}
	checkConsent("first copy")

	ev := audience.NewEvaluator(audience.EvaluatorOptions{
		Pool: store.Pool, AttributeTable: localstore.AttributesTable,
		Mappings: EvaluatorMappings(), MappingVersion: MappingVersion,
	})
	index := ScrambledAudience{AudienceIndex: ev, Scramble: store.ScrambleID}
	rules := []audience.Rule{{Attribute: "city", Operator: audience.OpIN, Value: []interface{}{"MUMBAI"}, Required: true}}
	activation := uuid.NewString()
	if _, err := ev.Materialize(ctx, activation, "ag", 1, rules, "", time.Hour); err != nil {
		t.Fatal(err)
	}
	if member, _, err := index.IsMaterializedMember(ctx, "C1", activation); err != nil || !member {
		t.Errorf("C1 in Mumbai audience = %v (%v)", member, err)
	}

	// The nightly sync swaps in a new copy under the open connections, and
	// publishes nothing when nothing changed.
	if _, err := r.SyncOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 {
		t.Errorf("an unchanged list was published again")
	}
	checkConsent("after the swap")
	if _, err := ev.Materialize(ctx, uuid.NewString(), "ag", 1, rules, "", time.Hour); err != nil {
		t.Errorf("counting after the swap: %v", err)
	}
	if next := r.NextRun(ctx); next == nil || !next.After(now) {
		t.Errorf("next run %v", next)
	}

	if err := r.DeleteCopy(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 || sent[1].Attributes[0].Status != "UNAVAILABLE" {
		t.Fatalf("delete did not withdraw the attributes: %+v", sent)
	}
	var left int
	_ = store.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oolix_audience_attributes)
		+ (SELECT count(*) FROM oolix_user_consent) + (SELECT count(*) FROM oolix_audience_members)
		+ (SELECT count(*) FROM oolix_sync_runs)`).Scan(&left)
	if left != 0 {
		t.Errorf("%d rows left after delete", left)
	}
	if r.NextRun(ctx) != nil {
		t.Error("nightly sync still scheduled after delete")
	}
	if eligible, _ := conn.IsAdvertisingEligible(ctx, "C1", "any-purpose"); eligible {
		t.Error("consent survived the delete")
	}
}

func TestNextRun(t *testing.T) {
	loc := time.FixedZone("IST", 5*3600+30*60)
	at := func(h, m int) time.Time { return time.Date(2026, 9, 26, h, m, 0, 0, loc) }
	if got := nextRun(at(1, 0), 2, loc); !got.Equal(at(2, 0)) {
		t.Errorf("before the hour: %v", got)
	}
	if got := nextRun(at(2, 0), 2, loc); !got.Equal(at(2, 0).AddDate(0, 0, 1)) {
		t.Errorf("on the hour: %v", got)
	}
	if got := nextRun(at(23, 0), 2, loc); !got.Equal(at(2, 0).AddDate(0, 0, 1)) {
		t.Errorf("late evening: %v", got)
	}
}
