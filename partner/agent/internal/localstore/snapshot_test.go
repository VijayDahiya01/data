package localstore

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A snapshot carries the settings and the withdrawals to a store that has
// neither, as an enclave's store is after a restart.
func TestASnapshotRestoresSettingsAndWithdrawals(t *testing.T) {
	dsn := os.Getenv("OOLIX_TEST_LOCALSTORE_URL")
	if dsn == "" {
		t.Skip("OOLIX_TEST_LOCALSTORE_URL not set")
	}
	ctx := context.Background()
	s, err := Open(ctx, dsn, filepath.Join(t.TempDir(), "local.key"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	cleanup := func() {
		_, _ = s.Pool.Exec(ctx, `DELETE FROM oolix_agent_settings WHERE key LIKE 'snapshot_test_%'`)
		_, _ = s.Pool.Exec(ctx, `DELETE FROM `+WithdrawalsTable+` WHERE partner_user_id LIKE 'snapshot-test-%'`)
	}
	cleanup()
	t.Cleanup(cleanup)

	if err := s.Put(ctx, "snapshot_test_mapping", map[string]any{"table": "customers"}); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	if _, err := s.Pool.Exec(ctx, `INSERT INTO `+WithdrawalsTable+` VALUES ('snapshot-test-1', $1)`, at); err != nil {
		t.Fatal(err)
	}
	snap, err := s.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(snap.Settings["snapshot_test_mapping"]) == "" || !snap.Withdrawals["snapshot-test-1"].Equal(at) {
		t.Fatalf("snapshot: %+v", snap)
	}
	before := snap.Fingerprint()

	cleanup()
	if err := s.Restore(ctx, snap); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if ok, err := s.Get(ctx, "snapshot_test_mapping", &got); !ok || err != nil || got["table"] != "customers" {
		t.Errorf("restored setting: %v %v %v", got, ok, err)
	}
	again, _ := s.Snapshot(ctx)
	if again.Fingerprint() != before {
		t.Error("the restored store snapshots differently")
	}
}
