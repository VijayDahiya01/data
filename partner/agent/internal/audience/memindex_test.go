package audience

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/oolix/partner-agent/internal/testdb"
)

// waitReady lets the background load finish.
func waitReady(t *testing.T, ix *memberIndex, activation string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ix.mu.Lock()
		set := ix.sets[activation]
		ready := set != nil && !set.loading && set.ready
		ix.mu.Unlock()
		if ready {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the audience never loaded")
}

func TestMembershipFromMemory(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testdb.URL(t, "audience"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for _, st := range []string{
		`DROP TABLE IF EXISTS oolix_audience_members, oolix_audience_materialization`,
		`CREATE TABLE oolix_audience_members (partner_user_id VARCHAR(120), activation_id UUID,
		   materialization_version INTEGER, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`,
		`CREATE TABLE oolix_audience_materialization (activation_id UUID PRIMARY KEY, materialization_version INTEGER,
		   status VARCHAR(24))`,
	} {
		if _, err := pool.Exec(ctx, st); err != nil {
			t.Fatal(err)
		}
	}
	const a = "00000000-0000-4000-8000-0000000000a1"
	build := func(version int, ttl time.Duration, ids ...string) {
		t.Helper()
		_, _ = pool.Exec(ctx, `DELETE FROM oolix_audience_members WHERE activation_id = $1`, a)
		for _, id := range ids {
			if _, err := pool.Exec(ctx, `INSERT INTO oolix_audience_members VALUES ($1, $2, $3, $4)`,
				id, a, version, time.Now().Add(ttl)); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := pool.Exec(ctx, `INSERT INTO oolix_audience_materialization VALUES ($1, $2, 'READY')
			ON CONFLICT (activation_id) DO UPDATE SET materialization_version = $2`, a, version); err != nil {
			t.Fatal(err)
		}
	}

	ix := newMemberIndex(pool)
	build(1, time.Hour, "C1", "C2", "C3")

	// Not loaded yet: the database answers, and the audience loads behind.
	if found, _, _ := ix.lookup(a, "C1"); found {
		t.Fatal("answered before loading")
	}
	waitReady(t, ix, a)
	for id, want := range map[string]bool{"C1": true, "C3": true, "C9": false} {
		found, member, version := ix.lookup(a, id)
		if !found || member != want || (want && version != 1) {
			t.Errorf("%s: found %v member %v version %d", id, found, member, version)
		}
	}

	// A rebuild: dropped, and loaded again on the next lookup.
	build(2, time.Hour, "C9")
	ix.forget(a)
	ix.lookup(a, "C9")
	waitReady(t, ix, a)
	if _, member, version := ix.lookup(a, "C9"); !member || version != 2 {
		t.Errorf("after the rebuild C9: %v v%d", member, version)
	}
	if _, member, _ := ix.lookup(a, "C1"); member {
		t.Error("a member of the old build is still answered as one")
	}

	// Members that have expired are the database's to answer.
	build(3, 50*time.Millisecond, "C5")
	ix.forget(a)
	ix.lookup(a, "C5")
	waitReady(t, ix, a)
	time.Sleep(100 * time.Millisecond)
	if found, _, _ := ix.lookup(a, "C5"); found {
		t.Error("an expired audience was answered from memory")
	}

	// Without a database there is nothing to load: always the database path.
	if found, _, _ := newMemberIndex(nil).lookup(a, "C1"); found {
		t.Error("an index without a pool answered")
	}
}
