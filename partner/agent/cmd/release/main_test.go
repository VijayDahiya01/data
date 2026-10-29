package main

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/update"
)

// What CI does with each release, and what an Agent then checks.
func TestReleaseSignsWhatAnAgentChecks(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"keygen"}, &out, os.Getenv); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		k, v, _ := strings.Cut(line, "=")
		env[k] = v
	}
	dir := t.TempDir()
	var bins []string
	for _, name := range []string{"oolix-agent-linux-amd64", "oolix-agent-windows-amd64.exe"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("binary "+name), 0o755); err != nil {
			t.Fatal(err)
		}
		bins = append(bins, p)
	}
	manifest, sig := filepath.Join(dir, "release.json"), filepath.Join(dir, "release.json.sig")
	if err := run(append([]string{"manifest", "-version", "abc123", "-built-at", "2026-10-28T09:00:00+05:30",
		"-out", manifest}, bins...), &out, nil); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"sign", "-out", sig, manifest}, &out, func(k string) string { return env[k] }); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := run([]string{"verify", "-key", env["AGENT_RELEASE_PUBLIC_KEY"], manifest, sig}, &out, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "release abc123") || !strings.Contains(out.String(), "2 binaries") {
		t.Errorf("verify said %q", out.String())
	}

	m, _ := os.ReadFile(manifest)
	s, _ := os.ReadFile(sig)
	pub, _ := update.Key(env["AGENT_RELEASE_PUBLIC_KEY"])
	rel, err := update.Open(pub, m, s)
	if err != nil {
		t.Fatal(err)
	}
	if f := rel.Files["windows-amd64"]; f.Name != "oolix-agent-windows-amd64.exe" || f.Size == 0 ||
		!rel.BuiltAt.Equal(time.Date(2026, 10, 28, 3, 30, 0, 0, time.UTC)) {
		t.Errorf("release %+v", rel)
	}

	// Without the key, or with another one, nothing is signed or verified.
	if err := run([]string{"sign", manifest}, &out, func(string) string { return "" }); err == nil {
		t.Error("signed without a key")
	}
	other := base64.StdEncoding.EncodeToString(make([]byte, 32))
	if err := run([]string{"verify", "-key", other, manifest, sig}, &out, nil); err == nil {
		t.Error("verified with the wrong key")
	}
	if err := run([]string{"manifest", "-version", "x", "-built-at", "2026-10-28T09:00:00Z", "agent.bin"}, &out, nil); err == nil {
		t.Error("a binary without its platform in the name was listed")
	}
}
