package localstore

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"time"
)

// Snapshot is what an Agent keeps across restarts when its disk does not
// survive them -- an Agent hosted in an enclave, whose store lives in memory:
// its settings, and the consent withdrawals it was told about, which must
// outlive any copy. Not the copy of the customers: a sync rebuilds that from
// the Partner's database.
type Snapshot struct {
	Settings    map[string]json.RawMessage `json:"settings"`
	Withdrawals map[string]time.Time       `json:"withdrawals"`
}

// Snapshot reads the settings and withdrawals.
func (s *Store) Snapshot(ctx context.Context) (Snapshot, error) {
	snap := Snapshot{Settings: map[string]json.RawMessage{}, Withdrawals: map[string]time.Time{}}
	rows, err := s.Pool.Query(ctx, `SELECT key, value FROM oolix_agent_settings ORDER BY key`)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var key string
		var raw []byte
		if err := rows.Scan(&key, &raw); err != nil {
			rows.Close()
			return snap, err
		}
		snap.Settings[key] = raw
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return snap, err
	}
	rows, err = s.Pool.Query(ctx, `SELECT partner_user_id, withdrawn_at FROM `+WithdrawalsTable)
	if err != nil {
		return snap, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var at time.Time
		if err := rows.Scan(&id, &at); err != nil {
			return snap, err
		}
		snap.Withdrawals[id] = at
	}
	return snap, rows.Err()
}

// Restore writes a snapshot back, over whatever the store holds.
func (s *Store) Restore(ctx context.Context, snap Snapshot) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for key, raw := range snap.Settings {
		if _, err := tx.Exec(ctx, `
			INSERT INTO oolix_agent_settings (key, value, updated_at) VALUES ($1, $2, NOW())
			ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, key, []byte(raw)); err != nil {
			return err
		}
	}
	for id, at := range snap.Withdrawals {
		if _, err := tx.Exec(ctx, `
			INSERT INTO `+WithdrawalsTable+` (partner_user_id, withdrawn_at) VALUES ($1, $2)
			ON CONFLICT (partner_user_id) DO UPDATE SET withdrawn_at = GREATEST(`+WithdrawalsTable+`.withdrawn_at, EXCLUDED.withdrawn_at)`,
			id, at); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Fingerprint says whether a snapshot changed, without comparing it whole.
func (snap Snapshot) Fingerprint() [32]byte {
	raw, _ := json.Marshal(snap) // map keys marshal sorted
	return sha256.Sum256(raw)
}
