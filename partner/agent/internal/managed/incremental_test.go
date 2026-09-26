package managed

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/testdb"
)

func TestRunnerChoosesFullOrIncrementalAndReportsQuality(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	partnerURL := testdb.URL(t, "managed_source")
	db, err := pgx.Connect(ctx, partnerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	day := func(d int) time.Time { return time.Date(2026, 9, d, 9, 0, 0, 0, time.UTC) }
	exec(`DROP TABLE IF EXISTS members`)
	exec(`CREATE TABLE members (id text PRIMARY KEY, city text, consent boolean, changed timestamptz)`)
	exec(`INSERT INTO members VALUES ('A', 'Mumbai', true, $1), ('B', 'Thane', true, $1)`, day(20))

	settings := Settings{store}
	if err := settings.SaveSource(ctx, source.Config{Kind: source.Postgres, URI: partnerURL}); err != nil {
		t.Fatal(err)
	}
	published := now
	m := Mapping{Table: "members", IDColumn: "id", UpdatedColumn: "changed", PublishedAt: &published,
		Attributes: map[string]AttributeMapping{"city": {Column: "city", Publish: true}},
		Consent:    ConsentMapping{Column: "consent"}}
	if err := settings.SaveMapping(ctx, m); err != nil {
		t.Fatal(err)
	}

	r := NewRunner(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	clock := now
	r.Now = func() time.Time { return clock }
	var reports []Quality
	r.SetQualityReporter(func(_ context.Context, q Quality) error {
		reports = append(reports, q)
		return nil
	})
	r.SetPublisher(ctx, func(context.Context, Capabilities) error { return nil })

	sync := func(want string) *Report {
		t.Helper()
		rep, err := r.syncWith(ctx, false)
		if err != nil {
			t.Fatal(err)
		}
		if rep.Mode != want {
			t.Fatalf("a %s sync, want %s", rep.Mode, want)
		}
		return rep
	}

	// Nothing to build on yet: in full, and the Partner hears how complete
	// the copy is -- one of two customers has a known city.
	sync(ModeFull)
	if len(reports) != 1 || reports[0].CustomersBucket != "UNDER_10K" || len(reports[0].Attributes) != 1 ||
		reports[0].Attributes[0].CoveragePct != 50 || reports[0].Attributes[0].UnreadablePct != 50 {
		t.Fatalf("quality: %+v", reports)
	}

	// The next night: only what changed since the last sync -- B, and A
	// again, because rows stamped at the watermark itself are read twice on
	// purpose -- and no quality report.
	exec(`UPDATE members SET city = 'Pune', changed = $1 WHERE id = 'B'`, day(25))
	clock = now.Add(24 * time.Hour)
	if rep := sync(ModeIncremental); rep.Changed != 2 {
		t.Errorf("changed %d", rep.Changed)
	}
	if len(reports) != 1 {
		t.Error("an incremental sync reported quality")
	}

	// New choices mean a full sync, so nothing rests on the old ones.
	m.Attributes["city"] = AttributeMapping{Column: "city", Publish: false}
	if err := settings.SaveMapping(ctx, m); err != nil {
		t.Fatal(err)
	}
	sync(ModeFull)
	sync(ModeIncremental)

	// And a week on, a full sync whatever happens.
	clock = clock.Add(FullSyncEvery)
	sync(ModeFull)
}

func TestBucketsKeepCountsVague(t *testing.T) {
	for n, want := range map[int]string{0: "UNDER_10K", 9_999: "UNDER_10K", 10_000: "10K_50K",
		499_999: "250K_500K", 1_000_000: "OVER_1M"} {
		if got := bucket(n); got != want {
			t.Errorf("%d: %s", n, got)
		}
	}
}
