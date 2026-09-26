package localstore

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTheLocalSecretSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "local.key")
	first, err := loadOrCreateKey(path)
	if err != nil {
		t.Fatal(err)
	}
	again, err := loadOrCreateKey(path)
	if err != nil || !bytes.Equal(first, again) {
		t.Fatalf("the key changed on restart (%v)", err)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
			t.Errorf("key file mode %v", info.Mode().Perm())
		}
	}

	// The same id scrambles the same way after a restart -- ad decisions
	// depend on it -- and differently on another server.
	a, b := &Store{key: first}, &Store{key: again}
	if a.ScrambleID("C1") != b.ScrambleID("C1") || a.ScrambleID("C1") == a.ScrambleID("C2") {
		t.Error("scrambling is not stable")
	}
	other, err := loadOrCreateKey(filepath.Join(t.TempDir(), "other.key"))
	if err != nil {
		t.Fatal(err)
	}
	if (&Store{key: other}).ScrambleID("C1") == a.ScrambleID("C1") {
		t.Error("two servers scramble an id the same way")
	}
}

func TestSealedSecretsResistTampering(t *testing.T) {
	key, err := loadOrCreateKey(filepath.Join(t.TempDir(), "local.key"))
	if err != nil {
		t.Fatal(err)
	}
	s := &Store{key: key}
	sealed, err := s.Seal("s3cret-password")
	if err != nil || strings.Contains(sealed, "s3cret") {
		t.Fatalf("sealed %q (%v)", sealed, err)
	}
	if got, err := s.Unseal(sealed); err != nil || got != "s3cret-password" {
		t.Errorf("unsealed %q (%v)", got, err)
	}

	raw, _ := base64.StdEncoding.DecodeString(sealed)
	raw[len(raw)-1] ^= 1
	if _, err := s.Unseal(base64.StdEncoding.EncodeToString(raw)); err == nil {
		t.Error("a tampered secret was accepted")
	}
	otherKey, _ := loadOrCreateKey(filepath.Join(t.TempDir(), "other.key"))
	if _, err := (&Store{key: otherKey}).Unseal(sealed); err == nil {
		t.Error("another server's key read the secret")
	}
}

// A damaged key file stops the Agent rather than being quietly replaced,
// which would strand the sealed database password.
func TestADamagedKeyFileIsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "local.key")
	if err := os.WriteFile(path, []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadOrCreateKey(path); err == nil {
		t.Error("a damaged key file was accepted")
	}
}
