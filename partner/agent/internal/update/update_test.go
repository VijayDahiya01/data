package update

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// release is a signed release served the way Oolix publishes one.
type release struct {
	key      ed25519.PrivateKey
	manifest []byte
	sig      []byte
	binary   []byte
}

func newRelease(t *testing.T, key ed25519.PrivateKey, version string, built time.Time, binary []byte) release {
	t.Helper()
	sum := sha256.Sum256(binary)
	m, err := json.Marshal(Release{Version: version, BuiltAt: built, Files: map[string]File{
		Platform(): {Name: "oolix-agent-" + Platform(), SHA256: hex.EncodeToString(sum[:]), Size: int64(len(binary))},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return release{key: key, manifest: m, sig: Sign(key, m), binary: binary}
}

func serve(t *testing.T, r *release) *httptest.Server {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch {
		case strings.HasSuffix(req.URL.Path, "/release.json"):
			_, _ = w.Write(r.manifest)
		case strings.HasSuffix(req.URL.Path, "/release.json.sig"):
			_, _ = w.Write(r.sig)
		case strings.HasSuffix(req.URL.Path, "/oolix-agent-"+Platform()):
			_, _ = w.Write(r.binary)
		default:
			http.NotFound(w, req)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// withBuild sets the release key and build time this binary was built with.
func withBuild(t *testing.T, pub ed25519.PublicKey, built time.Time) {
	t.Helper()
	oldKey, oldBuilt, oldActivate := ReleaseKey, BuiltAt, activateRelease
	ReleaseKey, BuiltAt = base64.StdEncoding.EncodeToString(pub), built.Format(time.RFC3339)
	activateRelease = func(string, string, *Release) error { return nil }
	t.Cleanup(func() { ReleaseKey, BuiltAt, activateRelease = oldKey, oldBuilt, oldActivate })
}

var (
	v1Built = time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	v2Built = time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
)

func TestInstallAKeptRelease(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	withBuild(t, pub, v1Built)
	rel := newRelease(t, priv, "v2", v2Built, []byte("the new agent"))
	srv := serve(t, &rel)
	state := t.TempDir()
	restarted := false
	u := New(Options{StateDir: state, Version: "v1", Client: srv.Client(), Restart: func() { restarted = true }})
	if u.Pending() {
		t.Fatal("pending with nothing offered")
	}
	u.Hear(&Offer{Version: "v2", URL: srv.URL + "/agent/v2"}, nil)
	if !u.Pending() || !u.Status().CanInstall {
		t.Fatalf("not pending: %+v", u.Status())
	}
	if err := u.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !restarted {
		t.Error("installed without restarting into it")
	}
	got, err := os.ReadFile(filepath.Join(state, "updates", "v2", binaryName))
	if err != nil || !bytes.Equal(got, rel.binary) {
		t.Fatalf("kept binary %q, %v", got, err)
	}

	// At the next start of the installed v1, v2 runs in its place -- three
	// starts to prove itself, then it is set aside and v1 runs.
	dir := filepath.Join(state, "updates")
	for i := 1; i <= maxStarts; i++ {
		bin, err := kept(dir, pub, v1Built, Platform())
		if err != nil || bin != filepath.Join(dir, "v2", binaryName) {
			t.Fatalf("start %d: %q, %v", i, bin, err)
		}
	}
	if bin, err := kept(dir, pub, v1Built, Platform()); bin != "" || err == nil {
		t.Fatalf("a release that never proved healthy ran a fourth time: %q, %v", bin, err)
	}
	if !setAside(dir, "v2") {
		t.Error("the failed release was not set aside")
	}
	u.Hear(&Offer{Version: "v2", URL: srv.URL + "/agent/v2"}, nil)
	if u.Pending() {
		t.Error("a release set aside is offered again")
	}
}

func TestAHealthyReleaseKeepsRunning(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	withBuild(t, pub, v1Built)
	rel := newRelease(t, priv, "v2", v2Built, []byte("the new agent"))
	srv := serve(t, &rel)
	state := t.TempDir()
	u := New(Options{StateDir: state, Version: "v1", Client: srv.Client()})
	u.Hear(&Offer{Version: "v2", URL: srv.URL + "/agent/v2/"}, nil)
	if err := u.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(state, "updates")
	for i := 0; i < 10; i++ {
		if bin, err := kept(dir, pub, v1Built, Platform()); bin == "" || err != nil {
			t.Fatalf("start %d: %q, %v", i, bin, err)
		}
		// Running as v2, it reached Oolix.
		BuiltAt = v2Built.Format(time.RFC3339)
		Healthy(state)
		BuiltAt = v1Built.Format(time.RFC3339)
	}

	// The Partner installs a newer binary by hand: it wins, and the kept
	// release is cleared away.
	if bin, _ := kept(dir, pub, v2Built.Add(time.Hour), Platform()); bin != "" {
		t.Errorf("an older kept release ran in place of a newer install: %q", bin)
	}
	if _, err := os.Stat(filepath.Join(dir, "v2")); !os.IsNotExist(err) {
		t.Error("the older kept release was not deleted")
	}

	// A kept binary that changed after it was checked is not run.
	if err := u.install(context.Background(), Offer{Version: "v2", URL: srv.URL + "/agent/v2"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "v2", binaryName), []byte("something else"), 0o700); err != nil {
		t.Fatal(err)
	}
	if bin, err := kept(dir, pub, v1Built, Platform()); bin != "" || err == nil {
		t.Errorf("a changed binary ran: %q, %v", bin, err)
	}
}

func TestReleasesThatAreRefused(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	withBuild(t, pub, v1Built)
	for name, tc := range map[string]struct {
		rel   release
		offer string // the version offered
		https bool
		want  string
	}{
		"signed by another key": {rel: newRelease(t, other, "v2", v2Built, []byte("x")), offer: "v2", https: true,
			want: "not signed with Oolix's release key"},
		"older than this agent": {rel: newRelease(t, priv, "v0", v1Built.Add(-time.Hour), []byte("x")), offer: "v0",
			https: true, want: "not newer"},
		"not the version offered": {rel: newRelease(t, priv, "v3", v2Built, []byte("x")), offer: "v2", https: true,
			want: "not the v2 offered"},
		"over plain http": {rel: newRelease(t, priv, "v2", v2Built, []byte("x")), offer: "v2",
			want: "HTTPS only"},
	} {
		t.Run(name, func(t *testing.T) {
			srv := serve(t, &tc.rel)
			url := srv.URL + "/agent/" + tc.offer
			if !tc.https {
				url = strings.Replace(url, "https://", "http://", 1)
			}
			state := t.TempDir()
			u := New(Options{StateDir: state, Version: "v1", Client: srv.Client()})
			u.Hear(&Offer{Version: tc.offer, URL: url}, nil)
			err := u.Install(context.Background())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %v, want %q", err, tc.want)
			}
			if u.Status().LastError == "" {
				t.Error("the failure is not shown on the setup page")
			}
			if _, err := os.Stat(filepath.Join(state, "updates", "next.json")); !os.IsNotExist(err) {
				t.Error("a refused release was kept")
			}
		})
	}

	// A binary that is not the one signed.
	rel := newRelease(t, priv, "v2", v2Built, []byte("the new agent"))
	rel.binary = []byte("the new agent, changed")
	srv := serve(t, &rel)
	state := t.TempDir()
	u := New(Options{StateDir: state, Version: "v1", Client: srv.Client()})
	u.Hear(&Offer{Version: "v2", URL: srv.URL + "/v2"}, nil)
	if err := u.Install(context.Background()); err == nil || !strings.Contains(err.Error(), "not the binary") {
		t.Fatalf("a changed binary was installed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(state, "updates", "v2", binaryName)); !os.IsNotExist(err) {
		t.Error("the changed binary was left behind")
	}
}

func TestWhenTheAgentCannotUpdateItself(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	withBuild(t, pub, v1Built)
	if st := New(Options{StateDir: t.TempDir(), Hosted: true}).Status(); st.CanInstall || !strings.Contains(st.WhyNot, "enclave") {
		t.Errorf("hosted: %+v", st)
	}
	ReleaseKey = ""
	u := New(Options{StateDir: t.TempDir(), Version: "v1"})
	u.Hear(&Offer{Version: "v2", URL: "https://example.com/v2"}, nil)
	if st := u.Status(); st.CanInstall || st.WhyNot != cannotUpdate || !st.Newer {
		t.Errorf("no key: %+v", st)
	}
	if u.Pending() || u.Install(context.Background()) == nil {
		t.Error("a build without the release key tried to update")
	}
	if NightHour(2) != 1 || NightHour(0) != 23 {
		t.Error("night hour")
	}
}

// A damaged record of the kept release is dropped, never followed outside the
// updates folder.
func TestADamagedRecordIsDropped(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	state := t.TempDir()
	dir := filepath.Join(state, "updates")
	outside := filepath.Join(state, "precious")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(dir, "next.json"), next{Version: "../precious", BuiltAt: v2Built}); err != nil {
		t.Fatal(err)
	}
	if bin, err := kept(dir, pub, v1Built, Platform()); bin != "" || err != nil {
		t.Fatalf("a damaged record ran %q: %v", bin, err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("a folder outside the updates folder was touched")
	}
	if _, err := os.Stat(filepath.Join(dir, "next.json")); !os.IsNotExist(err) {
		t.Error("the damaged record was kept")
	}
}

func TestOpenRefusesFilesOutsideTheRelease(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	for _, name := range []string{"../oolix-agent", "/usr/local/bin/oolix-agent", `..\oolix-agent.exe`, "c:oolix"} {
		m, _ := json.Marshal(Release{Version: "v2", BuiltAt: v2Built, Files: map[string]File{
			"linux-amd64": {Name: name, SHA256: strings.Repeat("a", 64), Size: 1}}})
		if _, err := Open(pub, m, Sign(priv, m)); err == nil {
			t.Errorf("a release naming %q was accepted", name)
		}
	}
}
