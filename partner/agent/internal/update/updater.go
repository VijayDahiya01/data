package update

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Offer is a release Oolix's API offers this Agent: the rollout has reached
// it, and the release is published under URL.
type Offer struct {
	Version string
	URL     string
}

// Status is what the setup page shows about updates.
type Status struct {
	Version string
	BuiltAt time.Time
	Offer   *Offer
	// Newer says the offer is a release this Agent would install: not its
	// own version, nor one set aside.
	Newer bool
	// Supported is false when Oolix no longer supports this version, nil
	// when it has not said.
	Supported *bool
	// CanInstall says this Agent can update itself; WhyNot, why not.
	CanInstall bool
	WhyNot     string
	Installing bool
	LastError  string
	LastTry    time.Time
}

// Options configure an Updater.
type Options struct {
	StateDir string
	// Version is this binary's version, as heartbeats report it.
	Version string
	Client  *http.Client
	Logger  *slog.Logger
	// Restart stops the Agent so the installed release starts.
	Restart func()
	// Hosted is an Agent in an enclave Oolix hosts: what runs there is the
	// image its Partner verified, so it is never updated from inside.
	Hosted bool
}

// Updater installs the releases offered to this Agent.
type Updater struct {
	dir      string
	key      ed25519.PublicKey
	built    time.Time
	version  string
	platform string
	client   *http.Client
	logger   *slog.Logger
	restart  func()
	whyNot   string

	mu         sync.Mutex
	offer      *Offer
	supported  *bool
	installing bool
	lastErr    string
	lastTry    time.Time
}

const cannotUpdate = "This build of the Agent cannot update itself: install new versions by hand."

func New(o Options) *Updater {
	u := &Updater{dir: filepath.Join(o.StateDir, "updates"), built: builtAt(), version: o.Version,
		platform: Platform(), client: o.Client, logger: o.Logger, restart: o.Restart}
	if u.logger == nil {
		u.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if u.client == nil {
		u.client = &http.Client{Timeout: 10 * time.Minute}
	}
	key, err := Key(ReleaseKey)
	switch {
	case o.Hosted:
		u.whyNot = "Oolix updates the Agent it hosts by publishing a new enclave image."
	case err != nil || u.built.IsZero():
		u.whyNot = cannotUpdate
	case o.StateDir == "":
		u.whyNot = "The Agent has no state folder to keep updates in."
	default:
		u.key = key
	}
	return u
}

// Hear records what the latest heartbeat said: the release offered, if any,
// and whether this version is still supported.
func (u *Updater) Hear(offer *Offer, supported *bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.offer, u.supported = offer, supported
}

// Status says where updates stand.
func (u *Updater) Status() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	st := Status{Version: u.version, BuiltAt: u.built, Offer: u.offer, Supported: u.supported,
		CanInstall: u.whyNot == "", WhyNot: u.whyNot, Installing: u.installing,
		LastError: u.lastErr, LastTry: u.lastTry}
	st.Newer = u.offer != nil && u.newer(u.offer.Version)
	return st
}

// Pending says a release this Agent would install is offered.
func (u *Updater) Pending() bool {
	st := u.Status()
	return st.CanInstall && st.Newer && !st.Installing
}

func (u *Updater) newer(version string) bool {
	return version != "" && version != u.version && !setAside(u.dir, version)
}

var errNothing = errors.New("no newer version is offered to this Agent")

// Install downloads the offered release, checks it and keeps it, then
// restarts the Agent into it.
func (u *Updater) Install(ctx context.Context) error {
	u.mu.Lock()
	o := u.offer
	switch {
	case u.whyNot != "":
		u.mu.Unlock()
		return errors.New(u.whyNot)
	case u.installing:
		u.mu.Unlock()
		return errors.New("an update is being installed already")
	case o == nil || !u.newer(o.Version):
		u.mu.Unlock()
		return errNothing
	}
	u.installing = true
	u.mu.Unlock()

	err := u.install(ctx, *o)
	u.mu.Lock()
	u.installing, u.lastTry, u.lastErr = false, time.Now(), ""
	if err != nil {
		u.lastErr = err.Error()
	}
	u.mu.Unlock()
	if err != nil {
		u.logger.Warn("the update could not be installed", "version", o.Version, "err", err)
		return err
	}
	u.logger.Info("update installed; restarting into it", "version", o.Version)
	if u.restart != nil {
		u.restart()
	}
	return nil
}

var safeVersion = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

func (u *Updater) install(ctx context.Context, o Offer) error {
	if !safeVersion.MatchString(o.Version) {
		return fmt.Errorf("%q is not a version the Agent can install", o.Version)
	}
	base := strings.TrimSuffix(o.URL, "/") + "/"
	if !strings.HasPrefix(base, "https://") {
		return errors.New("releases are downloaded over HTTPS only")
	}
	manifest, err := u.get(ctx, base+"release.json", 1<<20)
	if err != nil {
		return err
	}
	sig, err := u.get(ctx, base+"release.json.sig", 4<<10)
	if err != nil {
		return err
	}
	rel, err := Open(u.key, manifest, sig)
	if err != nil {
		return err
	}
	switch {
	case rel.Version != o.Version:
		return fmt.Errorf("the release published is %s, not the %s offered", rel.Version, o.Version)
	case !rel.BuiltAt.After(u.built):
		// Signed, but not newer: an old release offered again is refused.
		return errors.New("the release offered is not newer than this Agent")
	}
	f, ok := rel.Files[u.platform]
	if !ok {
		return fmt.Errorf("the release has no binary for %s", u.platform)
	}
	dir := filepath.Join(u.dir, rel.Version)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	bin := filepath.Join(dir, binaryName)
	if err := u.download(ctx, base+f.Name, bin, f); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "release.json"), manifest, 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "release.json.sig"), sig, 0o600); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(u.dir, "next.json"), next{Version: rel.Version, BuiltAt: rel.BuiltAt}); err != nil {
		return err
	}
	return activateRelease(u.dir, bin, rel)
}

// activateRelease is activate, replaced in tests: on Windows it swaps the
// running program, which in a test is the test itself.
var activateRelease = activate

func (u *Updater) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := u.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("downloading the release: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("downloading %s: %s", filepath.Base(req.URL.Path), res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err == nil && int64(len(b)) > limit {
		err = fmt.Errorf("%s is larger than a release file can be", filepath.Base(req.URL.Path))
	}
	return b, err
}

// download writes the binary beside its final name and moves it there only
// once its size and SHA-256 match the signed release.
func (u *Updater) download(ctx context.Context, url, dest string, f File) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := u.client.Do(req)
	if err != nil {
		return fmt.Errorf("downloading the release: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading %s: %s", f.Name, res.Status)
	}
	part := dest + ".part"
	out, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(res.Body, f.Size+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	switch {
	case err != nil:
	case n != f.Size || hex.EncodeToString(h.Sum(nil)) != strings.ToLower(f.SHA256):
		err = fmt.Errorf("%s is not the binary the release signed", f.Name)
	default:
		err = os.Rename(part, dest)
	}
	if err != nil {
		_ = os.Remove(part)
	}
	return err
}

// --- what is kept, between starts --------------------------------------------

// next is the release kept to run at the next start.
type next struct {
	Version string    `json:"version"`
	BuiltAt time.Time `json:"built_at"`
}

// starts counts the starts of a kept release since it last proved healthy.
type starts struct {
	Version string `json:"version"`
	Count   int    `json:"count"`
}

// maxStarts is how many starts a kept release gets to prove healthy.
const maxStarts = 3

var binaryName = func() string {
	if runtime.GOOS == "windows" {
		return "oolix-agent.exe"
	}
	return "oolix-agent"
}()

func writeJSON(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readJSON(path string, v any) bool {
	b, err := os.ReadFile(path)
	return err == nil && json.Unmarshal(b, v) == nil
}

func setAside(dir, version string) bool {
	var list []string
	readJSON(filepath.Join(dir, "set-aside.json"), &list)
	for _, v := range list {
		if v == version {
			return true
		}
	}
	return false
}

// readNext reads the record of the kept release. Its version names a folder,
// so a record whose version could not have been installed is deleted rather
// than followed outside the updates folder.
func readNext(dir string) (next, bool) {
	var n next
	if !readJSON(filepath.Join(dir, "next.json"), &n) {
		return next{}, false
	}
	if !safeVersion.MatchString(n.Version) || n.BuiltAt.IsZero() {
		_ = os.Remove(filepath.Join(dir, "next.json"))
		return next{}, false
	}
	return n, true
}

func putAside(dir, version string) error {
	var list []string
	readJSON(filepath.Join(dir, "set-aside.json"), &list)
	if !setAside(dir, version) {
		list = append(list, version)
	}
	_ = os.RemoveAll(filepath.Join(dir, version))
	_ = os.Remove(filepath.Join(dir, "next.json"))
	return writeJSON(filepath.Join(dir, "set-aside.json"), list)
}

// kept decides whether the release kept in dir runs in place of a binary
// built at built, returning its binary when it does. Each time it says so it
// counts a start, which Healthy clears once the release proves itself; at a
// start past maxStarts it sets the release aside instead. A kept release
// older than the binary -- the Partner installed a newer one since -- is
// deleted.
func kept(dir string, key ed25519.PublicKey, built time.Time, platform string) (string, error) {
	n, ok := readNext(dir)
	if !ok {
		return "", nil
	}
	switch {
	case n.BuiltAt.Before(built):
		_ = os.RemoveAll(filepath.Join(dir, n.Version))
		_ = os.Remove(filepath.Join(dir, "next.json"))
		return "", nil
	case !n.BuiltAt.After(built), setAside(dir, n.Version):
		// This binary is the kept release, or it was set aside.
		return "", nil
	}
	var s starts
	readJSON(filepath.Join(dir, "starts.json"), &s)
	if s.Version != n.Version {
		s = starts{Version: n.Version}
	}
	if s.Count >= maxStarts {
		return "", errors.Join(fmt.Errorf("release %s failed to start %d times: set aside", n.Version, s.Count),
			putAside(dir, n.Version))
	}
	bin := filepath.Join(dir, n.Version, binaryName)
	if err := check(filepath.Join(dir, n.Version), bin, key, n, platform); err != nil {
		return "", errors.Join(fmt.Errorf("release %s no longer checks out: set aside: %w", n.Version, err),
			putAside(dir, n.Version))
	}
	s.Count++
	return bin, writeJSON(filepath.Join(dir, "starts.json"), s)
}

// check verifies a kept release again: its signature, and its binary's hash.
func check(dir, bin string, key ed25519.PublicKey, n next, platform string) error {
	manifest, err := os.ReadFile(filepath.Join(dir, "release.json"))
	if err != nil {
		return err
	}
	sig, err := os.ReadFile(filepath.Join(dir, "release.json.sig"))
	if err != nil {
		return err
	}
	rel, err := Open(key, manifest, sig)
	if err != nil {
		return err
	}
	f, ok := rel.Files[platform]
	if !ok || rel.Version != n.Version || !rel.BuiltAt.Equal(n.BuiltAt) {
		return errors.New("the kept release does not match its record")
	}
	b, err := os.Open(bin)
	if err != nil {
		return err
	}
	defer b.Close()
	h := sha256.New()
	size, err := io.Copy(h, b)
	if err != nil {
		return err
	}
	if size != f.Size || hex.EncodeToString(h.Sum(nil)) != strings.ToLower(f.SHA256) {
		return errors.New("the kept binary is not the one the release signed")
	}
	return nil
}

// Healthy records that this binary started and reached Oolix: if it is the
// kept release, it no longer needs to prove itself.
func Healthy(stateDir string) {
	dir := filepath.Join(stateDir, "updates")
	if stateDir == "" {
		return
	}
	if n, ok := readNext(dir); !ok || !n.BuiltAt.Equal(builtAt()) {
		return
	}
	_ = os.Remove(filepath.Join(dir, "starts.json"))
}

// NightHour is when automatic updates install: the hour before the nightly
// refresh, so a restart never cuts one short.
func NightHour(syncHour int) int { return (syncHour + 23) % 24 }
