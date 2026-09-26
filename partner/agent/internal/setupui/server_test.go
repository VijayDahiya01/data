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
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/controlsync"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/testdb"
)

const customersCSV = `customer_id,Full Name,DOB,sex,City,tier,is_app_user,lastLogin,marketing_opt_in,unsubscribed_at
C1,Asha Rao,14/04/1992,F,Bombay,Gold,Y,2026-09-01 10:30:00,yes,
C2,Ravi Iyer,14-04-1993,M,bangalore,Silver,N,2026-08-01 00:00:00,true,
C3,Mira Das,1992-04-13T18:30:00Z,female,Mumbai,Elite,1,2026-09-20 09:00:00,Y,
C4,Kid Kumar,01/01/2015,M,Mumbai,Gold,Y,2026-09-01 10:00:00,yes,
C5,No Consent,,2,Pune,,0,,no,
C6,Near Mumbai,31/12/1990,M,Thane,Platinum,Y,2026-09-01 10:30:00,yes,
C7,Withdrew,05/05/1985,F,Delhi,Gold,Y,2026-09-01 10:30:00,yes,2026-09-10
`

const ordersCSV = `order_id,customer_id,order_date,category,pay_mode,channel
O1,C1,2026-09-20 10:00:00,Shoes,GPay,App
O2,C2,2026-09-01 10:00:00,Groceries,COD,Store
O3,C3,2026-05-01 10:00:00,Stationery,UPI,Web
O4,C1,2026-09-22 10:00:00,Shoes,UPI,App
`

var testNow = time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)

type harness struct {
	t          *testing.T
	store      *localstore.Store
	runner     *managed.Runner
	server     *httptest.Server
	client     *http.Client
	published  []managed.Capabilities
	registered []managed.Identity
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dsn := testdb.URL(t, "setupui")
	ctx := context.Background()
	store, err := localstore.Open(ctx, dsn, filepath.Join(t.TempDir(), "local.key"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	if err := store.DeleteCopiedData(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Pool.Exec(ctx, `DELETE FROM oolix_agent_settings`); err != nil {
		t.Fatal(err)
	}

	importDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(importDir, "customers.csv"), []byte(customersCSV), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(importDir, "orders.csv"), []byte(ordersCSV), 0o600); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := &harness{t: t, store: store}
	h.runner = managed.NewRunner(store, logger)
	h.runner.Now = func() time.Time { return testNow }

	s, err := New(ctx, Options{
		Store: store, Runner: h.runner, Logger: logger,
		APIBaseURL: "https://oolix.example.test", KeyPath: filepath.Join(t.TempDir(), "agent-key.pem"),
		ImportFolder: importDir, Password: "correct horse battery",
		OnRegistered: func(id managed.Identity) {
			h.registered = append(h.registered, id)
			h.runner.SetPublisher(context.Background(), func(_ context.Context, c managed.Capabilities) error {
				h.published = append(h.published, c)
				return nil
			})
		},
		Register: func(_ context.Context, _ *http.Client, base, code, _ string, _ []string) (*controlsync.RegistrationResult, error) {
			if code != "one-time-code" {
				return nil, errors.New("register returned 401: Invalid bootstrap token.")
			}
			return &controlsync.RegistrationResult{AgentID: "agent-1", ClientID: "client-1",
				Issuer: base, Audience: "oolix-agent-api", PartnerOrgID: "org-1",
				ManifestIssuer: base, ManifestAudience: "oolix-partner-agent"}, nil
		},
		Now: func() time.Time { return testNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	h.server = httptest.NewServer(s.Handler())
	t.Cleanup(h.server.Close)
	jar, _ := cookiejar.New(nil)
	h.client = &http.Client{Jar: jar}
	return h
}

func (h *harness) get(path string) (int, string) {
	h.t.Helper()
	res, err := h.client.Get(h.server.URL + path)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

func (h *harness) post(path string, form url.Values) (int, string, string) {
	h.t.Helper()
	res, err := h.client.PostForm(h.server.URL+path, form)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Request.URL.RequestURI(), string(body)
}

var csrfField = regexp.MustCompile(`name="csrf" value="([0-9a-f]+)"`)

func (h *harness) csrf() string {
	h.t.Helper()
	_, body := h.get("/register")
	m := csrfField.FindStringSubmatch(body)
	if m == nil {
		h.t.Fatal("no CSRF token on the page")
	}
	return m[1]
}

func TestSetupFromSignInToPublishedCopy(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	// Signed out, every page leads to sign-in.
	if code, body := h.get("/"); code != 200 || !strings.Contains(body, "Setup password") {
		t.Fatalf("signed out: %d", code)
	}
	if code, _, _ := h.post("/login", url.Values{"password": {"wrong password!"}}); code != http.StatusUnauthorized {
		t.Errorf("wrong password: %d", code)
	}
	if code, at, body := h.post("/login", url.Values{"password": {"correct horse battery"}}); code != 200 || at != "/" ||
		!strings.Contains(body, "Connect your customer data") {
		t.Fatalf("sign-in: %d at %s", code, at)
	}

	// A form without the page's token is refused.
	if code, _, _ := h.post("/register", url.Values{"code": {"one-time-code"}}); code != http.StatusForbidden {
		t.Errorf("post without CSRF token: %d", code)
	}
	csrf := h.csrf()

	// 1. Connect to Oolix.
	if _, _, body := h.post("/register", url.Values{"csrf": {csrf}, "code": {"used-up"}}); !strings.Contains(body, "Invalid bootstrap token") {
		t.Error("a rejected code should say why")
	}
	if _, at, _ := h.post("/register", url.Values{"csrf": {csrf}, "code": {"one-time-code"}}); at != "/?notice=registered" {
		t.Fatalf("register ended at %s", at)
	}
	if len(h.registered) != 1 || h.registered[0].PartnerOrgID != "org-1" {
		t.Fatalf("registered: %+v", h.registered)
	}

	// 2. A database the Agent cannot reach explains itself, and never echoes
	// the password back.
	_, _, body := h.post("/source", url.Values{"csrf": {csrf}, "kind": {"postgres"}, "host": {"localhost"},
		"port": {"1"}, "database": {"shop"}, "user": {"reader"}, "password": {"s3cret-pass"}, "tls": {"disable"}})
	if !strings.Contains(body, "host.docker.internal") || strings.Contains(body, "s3cret-pass") {
		t.Error("the localhost hint is missing, or the password was echoed")
	}
	if _, at, _ := h.post("/source", url.Values{"csrf": {csrf}, "kind": {"file"}, "location": {"Asia/Kolkata"}}); at != "/table?notice=connected" {
		t.Fatalf("file source ended at %s", at)
	}

	// 3. Choose the table.
	if _, body := h.get("/table"); !strings.Contains(body, `value="customers.csv" checked`) {
		t.Error("the customer file should be suggested")
	}
	_, at, body := h.post("/table", url.Values{"csrf": {csrf}, "table": {"customers.csv"}})
	if at != "/review" {
		t.Fatalf("table choice ended at %s", at)
	}
	// 4. The review shows the suggestions, the cleaning and the open question.
	for _, want := range []string{`<option value="customer_id" selected>`, `name="col_age"`,
		`<code>14/04/1992</code>`, "14 Apr 1992 (age 34)", `<code>Thane</code>`, `<code>Elite</code>`} {
		if !strings.Contains(body, want) {
			t.Errorf("review page lacks %q", want)
		}
	}
	form := url.Values{"csrf": {csrf}, "id_column": {"customer_id"},
		"col_age": {"DOB"}, "order_age": {"day"}, "publish_age": {"on"},
		"col_gender": {"sex"}, "publish_gender": {"on"},
		"col_city": {"City"}, "publish_city": {"on"},
		"col_loyalty_tier": {"tier"}, "publish_loyalty_tier": {"on"},
		"action": {"check"}}
	if _, at, _ := h.post("/review", form); at != "/review?notice=saved" {
		t.Fatalf("check ended at %s", at)
	}
	// Answer the open question: Thane counts as Mumbai here; Elite is ignored.
	form.Set("raw_city_0", "Thane")
	form.Set("code_city_0", "MUMBAI")
	form.Set("raw_loyalty_tier_0", "Elite")
	form.Set("code_loyalty_tier_0", "-")
	form.Set("action", "next")
	// Orders and bookings come next; this Partner has none to add.
	if _, at, _ := h.post("/review", form); at != "/activity" {
		t.Fatalf("review ended at %s", at)
	}
	draft, _ := managed.Settings{Store: h.store}.Draft(ctx)
	if draft.Attributes["city"].Overrides["Thane"] != "MUMBAI" || draft.Attributes["loyalty_tier"].Overrides["Elite"] != "" {
		t.Errorf("answers not kept: %+v", draft.Attributes)
	}

	// 5. Consent, then publish.
	// C1, C2, C3, C4 and C6 agreed (C4 is left out later for age); C7 withdrew.
	if _, body := h.get("/consent"); !strings.Contains(body, "5 agreed") || !strings.Contains(body, "1 took it back") {
		t.Error("the consent sample should count five agreements and one withdrawal")
	}
	if _, _, body := h.post("/consent", url.Values{"csrf": {csrf}, "consent_column": {""}, "web": {"on"},
		"sync_hour": {"3"}, "action": {"publish"}}); !strings.Contains(body, "records agreement to marketing") {
		t.Error("publishing without consent should be refused")
	}
	if _, at, _ := h.post("/consent", url.Values{"csrf": {csrf}, "consent_column": {"marketing_opt_in"},
		"withdrawal_column": {"unsubscribed_at"}, "web": {"on"}, "sync_hour": {"3"}, "action": {"publish"}}); at != "/?notice=publishing" {
		t.Fatalf("publish ended at %s", at)
	}

	// The runner copies and publishes (its loop is not running in this test).
	rep, err := h.runner.SyncOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// C1, C2, C3 and C6 (Thane, now Mumbai); C4 is a child, C5 said no, C7 withdrew.
	if rep.Customers != 4 || rep.UnderAge != 1 || rep.NotConsented != 2 {
		t.Errorf("sync: %+v", rep)
	}
	if len(h.published) != 1 || !slices.Equal(h.published[0].Keys(), []string{"age", "gender", "city", "loyalty_tier"}) {
		t.Errorf("published: %+v", h.published)
	}
	var mumbai int
	_ = h.store.Pool.QueryRow(ctx, `SELECT count(*) FROM oolix_audience_attributes WHERE city = 'MUMBAI'`).Scan(&mumbai)
	if mumbai != 3 {
		t.Errorf("customers in Mumbai after the answer: %d", mumbai)
	}

	_, body = h.get("/")
	for _, want := range []string{"Customers who can be shown ads", "<dd>4</dd>", "Age (from date of birth), Gender, City, Loyalty tier"} {
		if !strings.Contains(body, want) {
			t.Errorf("overview lacks %q", want)
		}
	}

	// Delete: everything copied goes, the attributes are withdrawn.
	if _, at, _ := h.post("/delete", url.Values{"csrf": {csrf}, "confirm": {"DELETE"}}); at != "/?notice=deleted" {
		t.Fatalf("delete ended at %s", at)
	}
	if len(h.published) != 2 || h.published[1].Attributes[0].Status != "UNAVAILABLE" {
		t.Errorf("not withdrawn: %+v", h.published)
	}
	var left int
	_ = h.store.Pool.QueryRow(ctx, `SELECT count(*) FROM oolix_audience_attributes`).Scan(&left)
	if left != 0 {
		t.Errorf("%d customers left after delete", left)
	}

	// Signed out again, and a guessing client is shut out.
	h.post("/logout", url.Values{"csrf": {csrf}})
	if code, body := h.get("/"); code != 200 || !strings.Contains(body, "Setup password") {
		t.Errorf("after sign-out: %d", code)
	}
	for i := 0; i < maxFailures; i++ {
		h.post("/login", url.Values{"password": {"guess"}})
	}
	if code, _, _ := h.post("/login", url.Values{"password": {"correct horse battery"}}); code != http.StatusTooManyRequests {
		t.Errorf("after %d wrong passwords the right one gave %d", maxFailures, code)
	}
}

func TestEveryResponseCarriesSecurityHeaders(t *testing.T) {
	h := newHarness(t)
	res, err := h.client.Get(h.server.URL + "/login")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	for header, want := range map[string]string{
		"Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY",
		"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
	} {
		if !strings.Contains(res.Header.Get(header), want) {
			t.Errorf("%s = %q", header, res.Header.Get(header))
		}
	}
}

func TestIndianNumber(t *testing.T) {
	for n, want := range map[int]string{0: "0", 999: "999", 1000: "1,000", 123456: "1,23,456", 12345678: "1,23,45,678"} {
		if got := indianNumber(n); got != want {
			t.Errorf("%d: %s", n, got)
		}
	}
}

func TestGeneratedPasswordsAreReadable(t *testing.T) {
	p := newPassword()
	if !regexp.MustCompile(`^[a-z2-9]{5}(-[a-z2-9]{5}){3}$`).MatchString(p) || strings.ContainsAny(p, "01ilo") {
		t.Errorf("password %q", p)
	}
}

func TestExplainNamesTheLikelyCause(t *testing.T) {
	cfg := source.Config{Kind: source.Postgres, Host: "db.internal"}
	for msg, want := range map[string]string{
		`password authentication failed for user "x"`:         "username or password",
		"dial tcp: lookup db.internal: no such host":          "could not be found",
		"dial tcp 10.0.0.5:5432: connect: connection refused": "Nothing answered",
	} {
		if got := explain(errors.New(msg), cfg); !strings.Contains(got, want) {
			t.Errorf("%q explained as %q", msg, got)
		}
	}
}

func TestTheOrdersStep(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	h.post("/login", url.Values{"password": {"correct horse battery"}})
	csrf := h.csrf()
	h.post("/register", url.Values{"csrf": {csrf}, "code": {"one-time-code"}})
	h.post("/source", url.Values{"csrf": {csrf}, "kind": {"file"}, "location": {"Asia/Kolkata"}})
	h.post("/table", url.Values{"csrf": {csrf}, "table": {"customers.csv"}})
	review := url.Values{"csrf": {csrf}, "id_column": {"customer_id"}, "col_city": {"City"},
		"publish_city": {"on"}, "action": {"next"}}
	if _, at, _ := h.post("/review", review); at != "/activity" {
		t.Fatalf("review ended at %s", at)
	}

	// Choosing the orders table fills in what the tool found.
	if _, at, _ := h.post("/activity", url.Values{"csrf": {csrf}, "orders_table": {"orders.csv"},
		"action": {"check"}}); at != "/activity?notice=saved" {
		t.Fatalf("choosing the table ended at %s", at)
	}
	_, body := h.get("/activity")
	for _, want := range []string{`<option value="customer_id" selected>`, `<option value="order_date" selected>`,
		`<option value="pay_mode" selected>`, `<code>Stationery</code>`, "Purchases in the last 90 days"} {
		if !strings.Contains(body, want) {
			t.Errorf("the orders step lacks %q", want)
		}
	}

	// Stationery is ignored, and purchase counts are not offered.
	form := url.Values{"csrf": {csrf}, "orders_table": {"orders.csv"}, "orders_customer": {"customer_id"},
		"orders_date": {"order_date"}, "orders_purchase_category": {"category"},
		"orders_payment_method": {"pay_mode"}, "orders_order_channel": {"channel"},
		"orders_raw_purchase_category_0": {"Stationery"}, "orders_code_purchase_category_0": {"-"},
		"action": {"next"}}
	for _, key := range []string{"purchase_recency_days", "purchase_frequency", "purchase_category",
		"payment_method", "online_shopper"} {
		form.Set("orders_shown_"+key, "1")
		if key != "purchase_frequency" {
			form.Set("orders_offer_"+key, "on")
		}
	}
	if _, at, _ := h.post("/activity", form); at != "/consent" {
		t.Fatalf("the orders step ended at %s", at)
	}
	draft, _ := managed.Settings{Store: h.store}.Draft(ctx)
	if o := draft.Orders; o == nil || o.CategoryColumn != "category" || o.Overrides["purchase_category"]["Stationery"] != "" ||
		!slices.Equal(o.Withhold, []string{"purchase_frequency"}) {
		t.Fatalf("orders saved as %+v", draft.Orders)
	}

	h.post("/consent", url.Values{"csrf": {csrf}, "consent_column": {"marketing_opt_in"}, "web": {"on"},
		"sync_hour": {"3"}, "action": {"publish"}})
	rep, err := h.runner.SyncOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if o := rep.Activity["orders"]; o.Used != 4 {
		t.Errorf("orders used: %+v", o)
	}
	if len(h.published) != 1 {
		t.Fatalf("published %d times", len(h.published))
	}
	keys := h.published[0].Keys()
	for _, want := range []string{"city", "purchase_recency_days", "purchase_category", "payment_method", "online_shopper"} {
		if !slices.Contains(keys, want) {
			t.Errorf("%s not published: %v", want, keys)
		}
	}
	if slices.Contains(keys, "purchase_frequency") {
		t.Error("a withheld attribute was published")
	}
	if _, body := h.get("/"); !strings.Contains(body, "Orders <code>orders.csv</code>") {
		t.Error("the overview does not show what was read from the orders table")
	}
}
