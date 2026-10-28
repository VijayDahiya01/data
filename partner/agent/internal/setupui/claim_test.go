package setupui

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oolix/partner-agent/internal/controlsync"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/testdb"
)

// An Agent Oolix hosts in an enclave has no log anyone can read, so no
// generated password: the Partner claims it with a one-time code from their
// portal, and chooses the password.
func TestAHostedAgentIsClaimedWithAOneTimeCode(t *testing.T) {
	dsn := testdb.URL(t, "setupui")
	ctx := context.Background()
	store, err := localstore.Open(ctx, dsn, filepath.Join(t.TempDir(), "local.key"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	if _, err := store.Pool.Exec(ctx, `DELETE FROM oolix_agent_settings`); err != nil {
		t.Fatal(err)
	}
	var registered []managed.Identity
	s, err := New(ctx, Options{
		Store: store, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		APIBaseURL: "https://oolix.example.test", KeyPath: filepath.Join(t.TempDir(), "agent-key.pem"),
		Claim:        true,
		OnRegistered: func(id managed.Identity) { registered = append(registered, id) },
		Register: func(_ context.Context, _ *http.Client, base, code, _ string, _ []string) (*controlsync.RegistrationResult, error) {
			if code != "one-time-code" {
				return nil, errors.New("register returned 401")
			}
			return &controlsync.RegistrationResult{AgentID: "agent-1", ClientID: "client-1", Audience: "oolix-agent-api",
				PartnerOrgID: "org-1", ManifestIssuer: base, ManifestAudience: "oolix-partner-agent"}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	newClient := func() *http.Client {
		jar, _ := cookiejar.New(nil)
		return &http.Client{Jar: jar}
	}
	page := func(res *http.Response, err error) (int, string) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(body)
	}
	c := newClient()
	if _, body := page(c.Get(srv.URL + "/login")); !strings.Contains(body, "Claim this Agent") {
		t.Fatal("an unclaimed hosted Agent does not offer to be claimed")
	}
	claim := func(c *http.Client, code, p1, p2 string) (int, string) {
		return page(c.PostForm(srv.URL+"/login", url.Values{"code": {code}, "password": {p1}, "password2": {p2}}))
	}
	if status, _ := claim(c, "stolen-code", "long enough password", "long enough password"); status != http.StatusUnauthorized {
		t.Errorf("a wrong code: %d", status)
	}
	if status, _ := claim(c, "one-time-code", "long enough password", "another password"); status != http.StatusBadRequest {
		t.Errorf("passwords that differ: %d", status)
	}
	if len(registered) != 0 {
		t.Fatal("registered before a valid claim")
	}
	if status, body := claim(c, "one-time-code", "long enough password", "long enough password"); status != http.StatusOK ||
		!strings.Contains(body, "Connected to Oolix") {
		t.Fatalf("claim: %d %s", status, body)
	}
	if len(registered) != 1 || registered[0].PartnerOrgID != "org-1" {
		t.Errorf("registered: %+v", registered)
	}

	// Claimed: everyone else signs in with the password chosen.
	other := newClient()
	if _, body := page(other.Get(srv.URL + "/login")); strings.Contains(body, "Claim this Agent") {
		t.Error("a claimed Agent offered to be claimed again")
	}
	if status, body := page(other.PostForm(srv.URL+"/login", url.Values{"password": {"long enough password"}})); status != http.StatusOK ||
		strings.Contains(body, "not right") {
		t.Errorf("signing in with the chosen password: %d", status)
	}
}
