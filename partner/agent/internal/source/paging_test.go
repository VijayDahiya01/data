package source

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

// A large table is read in slices, in key order, each a short query; a slice
// that fails is tried again from the last row read; and a Partner's limit on
// rows per second holds. Shown on PostgreSQL with slices of 10 rows.
func TestLargeTablesAreReadInSlices(t *testing.T) {
	url := os.Getenv("OOLIX_TEST_POSTGRES_URL")
	if url == "" {
		t.Skip("OOLIX_TEST_POSTGRES_URL not set")
	}
	stmts := []string{`DROP VIEW IF EXISTS paging_view`, `DROP TABLE IF EXISTS paging_customers`,
		`CREATE TABLE paging_customers (id integer PRIMARY KEY, name text)`}
	for i := 1; i <= 25; i++ {
		stmts = append(stmts, fmt.Sprintf(`INSERT INTO paging_customers VALUES (%d, 'C%d')`, i, i))
	}
	stmts = append(stmts, `CREATE VIEW paging_view AS SELECT id, name FROM paging_customers`)
	sqlFixture(t, "pgx", url, stmts...)
	t.Cleanup(func() {
		sqlFixture(t, "pgx", url, `DROP VIEW IF EXISTS paging_view`, `DROP TABLE IF EXISTS paging_customers`)
	})

	ctx := context.Background()
	src, err := Open(ctx, Config{Kind: Postgres, URI: url, Location: "Asia/Kolkata"})
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	s := src.(*sqlSource)
	s.pageSize = 10

	admin, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()

	read := func(table string, during func(n int)) ([]string, error) {
		var names []string
		err := src.Stream(ctx, table, []string{"name"}, func(r Row) error {
			names = append(names, r["name"].(string))
			if during != nil {
				during(len(names))
			}
			return nil
		})
		return names, err
	}
	want := make([]string, 25)
	for i := range want {
		want[i] = fmt.Sprintf("C%d", i+1)
	}
	same := func(got []string) bool {
		if len(got) != len(want) {
			return false
		}
		for i := range got {
			if got[i] != want[i] {
				return false
			}
		}
		return true
	}

	// Every row once, in key order, across three slices.
	if got, err := read("paging_customers", nil); err != nil || !same(got) {
		t.Fatalf("read %v, %v", got, err)
	}

	// The Agent's connection is cut halfway: the read carries on from the
	// last row it had, with nothing read twice and nothing missed.
	got, err := read("paging_customers", func(n int) {
		if n == 15 {
			if _, err := admin.Exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
				WHERE application_name = 'oolix-agent' AND pid <> pg_backend_pid()`); err != nil {
				t.Error(err)
			}
		}
	})
	if err != nil || !same(got) {
		t.Fatalf("after a dropped connection: read %v, %v", got, err)
	}

	// The caller's own error stops the read, and is not retried.
	calls := 0
	stop := errors.New("stop here")
	err = src.Stream(ctx, "paging_customers", []string{"name"}, func(Row) error {
		calls++
		if calls == 12 {
			return stop
		}
		return nil
	})
	if !errors.Is(err, stop) || calls != 12 {
		t.Errorf("callback error: %v after %d rows", err, calls)
	}

	// A view has no key to slice by, so it is read in one query.
	if got, err := read("paging_view", nil); err != nil || len(got) != 25 {
		t.Errorf("view: %d rows, %v", len(got), err)
	}

	// 50 rows a second: the first 20 rows take at least 0.4 s.
	s.rowsPerSecond = 50
	started := time.Now()
	if got, err := read("paging_customers", nil); err != nil || !same(got) {
		t.Fatalf("paced read %v, %v", got, err)
	}
	if took := time.Since(started); took < 350*time.Millisecond {
		t.Errorf("50 rows a second read 25 rows in %v", took)
	}
}

func TestSliceQueriesPerDatabase(t *testing.T) {
	for kind, want := range map[Kind][2]string{
		Postgres: {`SELECT "id", "dob" FROM "public"."c" ORDER BY "id" LIMIT 10`,
			`SELECT "id", "dob" FROM "public"."c" WHERE "u" >= '20260101' AND "id" > $1 ORDER BY "id" LIMIT 10`},
		MySQL: {"SELECT `id`, `dob` FROM `c` ORDER BY `id` LIMIT 10",
			"SELECT `id`, `dob` FROM `c` WHERE `u` >= '20260101' AND `id` > ? ORDER BY `id` LIMIT 10"},
		SQLServer: {`SELECT TOP (10) [id], [dob] FROM [dbo].[c] ORDER BY [id]`,
			`SELECT TOP (10) [id], [dob] FROM [dbo].[c] WHERE [u] >= '20260101' AND [id] > @p1 ORDER BY [id]`},
	} {
		d := dialects[kind]
		q := d.quote
		from := map[Kind]string{Postgres: `"public"."c"`, MySQL: "`c`", SQLServer: `[dbo].[c]`}[kind]
		cols := q("id") + ", " + q("dob")
		if got := d.page(cols, from, "", q("id"), false, 10); got != want[0] {
			t.Errorf("%s first slice:\n got  %s\n want %s", kind, got, want[0])
		}
		if got := d.page(cols, from, q("u")+" >= '20260101'", q("id"), true, 10); got != want[1] {
			t.Errorf("%s next slice:\n got  %s\n want %s", kind, got, want[1])
		}
	}
}
