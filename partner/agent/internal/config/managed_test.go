package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The Compose bundle configures the Agent through the environment alone.
func TestManagedModeFromTheEnvironment(t *testing.T) {
	dir := t.TempDir()
	pw := filepath.Join(dir, "store-password")
	if err := os.WriteFile(pw, []byte("s3cret/with:odd@chars\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OOLIX_API_BASE_URL", "https://api.example.test/")
	t.Setenv("OOLIX_LOCAL_STORE_URL", "postgres://oolix_agent@local-store:5432/oolix_agent?sslmode=disable")
	t.Setenv("OOLIX_LOCAL_STORE_PASSWORD_FILE", pw)

	cfg, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.IsManaged() || cfg.Oolix.APIBaseURL != "https://api.example.test" {
		t.Errorf("config: %+v", cfg)
	}
	if cfg.Managed.SetupListenAddr != "0.0.0.0:8083" || cfg.Agent.ListenAddr != "0.0.0.0:8082" ||
		cfg.Managed.StateDir != "/var/lib/oolix-agent" || cfg.State.Mode != "embedded" {
		t.Errorf("defaults: %+v / %+v", cfg.Managed, cfg.Agent)
	}
	dsn, err := cfg.Managed.LocalStoreDSN()
	if err != nil {
		t.Fatal(err)
	}
	// The password is escaped into the URL, and the rest of it kept.
	want := "postgres://oolix_agent:s3cret%2Fwith%3Aodd%40chars@local-store:5432/oolix_agent?sslmode=disable"
	if dsn != want {
		t.Errorf("dsn %q", dsn)
	}
}

func TestManagedModeNeedsTheControlPlaneAndAStore(t *testing.T) {
	t.Setenv("OOLIX_API_BASE_URL", "")
	t.Setenv("OOLIX_LOCAL_STORE_URL", "")
	_, err := FromEnv()
	if err == nil || !strings.Contains(err.Error(), "OOLIX_API_BASE_URL") ||
		!strings.Contains(err.Error(), "OOLIX_LOCAL_STORE_URL") {
		t.Errorf("got %v", err)
	}
}

// A value the setup page owns would be ignored if accepted here.
func TestManagedModeRefusesWhatTheSetupPageOwns(t *testing.T) {
	c := &Config{Connector: ConnectorConfig{Type: ConnectorManaged, DSN: "postgres://x"}}
	c.Oolix.APIBaseURL = "https://api.example.test"
	c.Managed.LocalStoreURL = "postgres://y"
	c.Agent.PartnerID = "p"
	c.Channels.Meta.Enabled = true
	c.applyDefaults()
	err := c.validate()
	for _, want := range []string{"connector.dsn is not used", "agent.partner_id is not used", "Meta"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("want %q in %v", want, err)
		}
	}
}

func TestAnEmptyPasswordFileIsAnError(t *testing.T) {
	pw := filepath.Join(t.TempDir(), "empty")
	if err := os.WriteFile(pw, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	m := ManagedConfig{LocalStoreURL: "postgres://a@b/c", LocalStorePasswordFile: pw}
	if _, err := m.LocalStoreDSN(); err == nil {
		t.Error("an empty password was accepted")
	}
}
