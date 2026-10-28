package audience

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// memberIndex answers "is this customer in this audience?" from memory.
//
// Each ad decision asks it once per candidate campaign. From the database that
// is a round trip each; at thousands of decisions a second it is the first
// thing to give. So each materialized audience is held as the sorted 64-bit
// fingerprints of its members' IDs -- about 8 MB a million -- and a lookup is
// a binary search.
//
// The database stays the truth. An audience is loaded on first use and
// reloaded when its materialization version changes, checked at most once a
// minute; until it is loaded, and once its members expire, lookups go to the
// database as before. Consent is never answered from here: a customer who
// withdraws is refused by the consent check whatever this says.
//
// A fingerprint collision between two IDs is possible in principle -- about
// one in 10^12 lookups for a ten-million-member audience -- and would treat a
// consenting non-member as a member, never a non-consenting customer as
// consenting.
type memberIndex struct {
	pool  *pgxpool.Pool
	check time.Duration

	mu   sync.Mutex
	sets map[string]*memberSet
}

type memberSet struct {
	ids      []uint64 // sorted
	versions []int32  // the build each member was selected by, in ids' order
	version  int      // the materialization version loaded
	expires  time.Time
	checked  time.Time
	loading  bool
	ready    bool
}

func newMemberIndex(pool *pgxpool.Pool) *memberIndex {
	return &memberIndex{pool: pool, check: time.Minute, sets: map[string]*memberSet{}}
}

func fingerprint(id string) uint64 {
	sum := sha256.Sum256([]byte(id))
	return binary.BigEndian.Uint64(sum[:8])
}

// lookup answers from memory when it can: found is false when the database
// must be asked instead.
func (ix *memberIndex) lookup(activationID, partnerUserID string) (found, member bool, version int) {
	if ix.pool == nil {
		return false, false, 0
	}
	now := time.Now()
	ix.mu.Lock()
	set := ix.sets[activationID]
	if set == nil {
		set = &memberSet{}
		ix.sets[activationID] = set
	}
	if !set.loading && now.Sub(set.checked) >= ix.check {
		set.loading = true
		go ix.refresh(activationID, set.version, set.ready)
	}
	ready, expired := set.ready, now.After(set.expires)
	ids, versions := set.ids, set.versions
	ix.mu.Unlock()

	if !ready || expired {
		return false, false, 0
	}
	fp := fingerprint(partnerUserID)
	i, ok := slices.BinarySearch(ids, fp)
	if !ok {
		return true, false, 0
	}
	return true, true, int(versions[i])
}

// forget drops an audience, for one that was rebuilt or removed: the next
// lookup loads it again.
func (ix *memberIndex) forget(activationID string) {
	ix.mu.Lock()
	delete(ix.sets, activationID)
	ix.mu.Unlock()
}

// refresh reloads an audience when its version changed.
func (ix *memberIndex) refresh(activationID string, loadedVersion int, loaded bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	finish := func(apply func(*memberSet)) {
		ix.mu.Lock()
		defer ix.mu.Unlock()
		set := ix.sets[activationID]
		if set == nil {
			return
		}
		if apply != nil {
			apply(set)
		}
		set.loading, set.checked = false, time.Now()
	}

	var version int
	if err := ix.pool.QueryRow(ctx, `SELECT materialization_version FROM oolix_audience_materialization
		WHERE activation_id = $1 AND status = 'READY'`, activationID).Scan(&version); err != nil {
		// Not built, or the database is unavailable: lookups stay with the
		// database, which answers or fails closed itself.
		finish(func(s *memberSet) { s.ready = false })
		return
	}
	if loaded && version == loadedVersion {
		finish(nil)
		return
	}
	rows, err := ix.pool.Query(ctx, `SELECT partner_user_id, materialization_version, expires_at
		FROM oolix_audience_members WHERE activation_id = $1 AND expires_at > NOW()`, activationID)
	if err != nil {
		finish(func(s *memberSet) { s.ready = false })
		return
	}
	type entry struct {
		fp uint64
		v  int32
	}
	var entries []entry
	var expires time.Time
	for rows.Next() {
		var id string
		var v int32
		var exp time.Time
		if err := rows.Scan(&id, &v, &exp); err != nil {
			rows.Close()
			finish(func(s *memberSet) { s.ready = false })
			return
		}
		entries = append(entries, entry{fingerprint(id), v})
		if expires.IsZero() || exp.Before(expires) {
			expires = exp
		}
	}
	rows.Close()
	if rows.Err() != nil {
		finish(func(s *memberSet) { s.ready = false })
		return
	}
	slices.SortFunc(entries, func(a, b entry) int {
		switch {
		case a.fp < b.fp:
			return -1
		case a.fp > b.fp:
			return 1
		}
		return 0
	})
	ids := make([]uint64, len(entries))
	versions := make([]int32, len(entries))
	for i, e := range entries {
		ids[i], versions[i] = e.fp, e.v
	}
	if expires.IsZero() {
		// No live members: an empty audience until it is rebuilt.
		expires = time.Now().Add(ix.check)
	}
	finish(func(s *memberSet) {
		s.ids, s.versions, s.version, s.expires, s.ready = ids, versions, version, expires, true
	})
}
