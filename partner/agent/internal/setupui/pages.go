package setupui

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/standard"
)

// --- steps -------------------------------------------------------------------

type step struct {
	Path, Label, Detail   string
	Done, Current, Locked bool
}

// state is what the setup has so far.
type state struct {
	identity *managed.Identity
	source   *source.Config
	draft    *managed.Mapping
	live     *managed.Mapping
}

func (s *Server) state(ctx context.Context) (state, error) {
	var st state
	var err error
	if st.identity, err = s.settings.Identity(ctx); err != nil {
		return st, err
	}
	if st.source, err = s.settings.Source(ctx); err != nil {
		return st, err
	}
	if st.draft, err = s.settings.Draft(ctx); err != nil {
		return st, err
	}
	st.live, err = s.settings.Mapping(ctx)
	return st, err
}

func (st state) reviewed() bool {
	return st.draft != nil && st.draft.IDColumn != "" &&
		(len(mapped(st.draft)) > 0 || len(managed.ActivityProvides(*st.draft)) > 0)
}

// hasActivity says whether an orders or bookings table is set up.
func (st state) hasActivity() bool {
	return st.draft != nil && len(managed.ActivityProvides(*st.draft)) > 0
}

func (st state) published() bool { return st.live != nil && st.live.PublishedAt != nil }

func (s *Server) steps(st state, current string) []step {
	steps := []step{
		{Path: "/register", Label: "Connect to Oolix", Done: st.identity != nil},
		{Path: "/source", Label: "Connect your database", Done: st.source != nil},
		{Path: "/table", Label: "Choose the customer table",
			Done: st.draft != nil && st.draft.Table != "", Locked: st.source == nil},
		{Path: "/review", Label: "Check the matches", Done: st.reviewed(),
			Locked: st.draft == nil || st.draft.Table == ""},
		{Path: "/activity", Label: "Orders and bookings", Done: st.hasActivity(),
			Locked: st.draft == nil || st.draft.IDColumn == "", Detail: "optional"},
		{Path: "/consent", Label: "Consent and publish", Done: st.published(), Locked: !st.reviewed()},
	}
	if st.source != nil {
		steps[1].Detail = st.source.Kind.Label()
	}
	if st.draft != nil && st.draft.Table != "" {
		steps[2].Detail = st.draft.Table
	}
	if st.reviewed() {
		steps[3].Detail = fmt.Sprintf("%d attributes", len(mapped(st.draft)))
	}
	if st.hasActivity() {
		var tables []string
		if st.draft.Orders != nil && st.draft.Orders.Table != "" {
			tables = append(tables, "orders")
		}
		if st.draft.Bookings != nil && st.draft.Bookings.Table != "" {
			tables = append(tables, "bookings")
		}
		steps[4].Detail = strings.Join(tables, " and ")
	}
	for i := range steps {
		steps[i].Current = steps[i].Path == current
	}
	return steps
}

// next is the first step not yet done.
func (st state) next() string {
	switch {
	case st.identity == nil:
		return "/register"
	case st.source == nil:
		return "/source"
	case st.draft == nil || st.draft.Table == "":
		return "/table"
	case !st.reviewed():
		return "/review"
	default:
		return "/consent"
	}
}

func label(key string) string {
	if a, ok := standard.ByKey(key); ok {
		return a.Label
	}
	return key
}

func mapped(m *managed.Mapping) []string {
	var out []string
	provides := managed.ActivityProvides(*m)
	for _, a := range standard.Attributes {
		if am, ok := m.Attributes[a.Key]; ok && am.Column != "" && !provides[a.Key] {
			out = append(out, a.Key)
		}
	}
	return out
}

func (s *Server) view(r *http.Request, sess *session, st state, title, path string) view {
	return view{
		Title: title, CSRF: sess.csrf, Steps: s.steps(st, path),
		Notice: notices[r.URL.Query().Get("notice")],
	}
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	s.opts.Logger.Error("setup page error", "error", err.Error())
	http.Error(w, "Something went wrong: "+err.Error(), http.StatusInternalServerError)
}

func redirect(w http.ResponseWriter, r *http.Request, path string) {
	http.Redirect(w, r, path, http.StatusSeeOther)
}

// --- overview ----------------------------------------------------------------

type attrStatus struct {
	Key, Label string
	// FixAt is the page where unknown values are answered.
	FixAt        string
	Filled       int
	Percent      int
	Unreadable   int
	Unrecognised int
	Published    bool
}

type overviewData struct {
	Next       string
	Identity   *managed.Identity
	Source     *source.Config
	Live       *managed.Mapping
	Running    *time.Time
	NextRun    *time.Time
	Last       *managed.Report
	Good       *managed.Report
	Published  *managed.PublishRecord
	Attributes []attrStatus
	Offered    []string
	// NextFull is when a Partner with a changed-at column next gets a full
	// refresh.
	NextFull *time.Time
	Activity []activityStatus
}

type activityStatus struct {
	Title string
	managed.ActivityReport
}

func (s *Server) overview(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	d := overviewData{Next: st.next(), Identity: st.identity, Source: st.source, Live: st.live,
		Running: s.opts.Runner.RunningSince(), NextRun: s.opts.Runner.NextRun(ctx)}
	if d.Last, err = s.settings.LastSync(ctx); err != nil {
		s.fail(w, err)
		return
	}
	if d.Good, err = s.settings.LastGoodSync(ctx); err != nil {
		s.fail(w, err)
		return
	}
	if d.Published, err = s.settings.Published(ctx); err != nil {
		s.fail(w, err)
		return
	}
	offered := map[string]bool{}
	if d.Published != nil && !d.Published.Withdrawn && d.Published.Error == "" {
		for _, c := range d.Published.Capabilities.Attributes {
			offered[c.AttributeKey] = true
			d.Offered = append(d.Offered, label(c.AttributeKey))
		}
	}
	if d.Good != nil {
		var provides map[string]bool
		if st.live != nil {
			provides = managed.ActivityProvides(*st.live)
		}
		for _, a := range standard.Attributes {
			ar, ok := d.Good.Attributes[a.Key]
			if !ok {
				continue
			}
			fixAt := "/review"
			if provides[a.Key] {
				fixAt = "/activity"
			}
			d.Attributes = append(d.Attributes, attrStatus{
				Key: a.Key, Label: a.Label, FixAt: fixAt, Filled: ar.Filled, Percent: percent(ar.Filled, d.Good.Customers),
				Unreadable: ar.Unreadable, Unrecognised: len(ar.Unrecognised), Published: offered[a.Key],
			})
		}
		for _, kind := range []string{"orders", "bookings"} {
			if ar, ok := d.Good.Activity[kind]; ok {
				d.Activity = append(d.Activity, activityStatus{Title: map[string]string{
					"orders": "Orders", "bookings": "Bookings"}[kind], ActivityReport: ar})
			}
		}
	}
	if st.live != nil && st.live.UpdatedColumn != "" && st.live.PublishedAt != nil {
		if full, err := s.settings.LastFullSync(ctx); err == nil && full != nil {
			next := full.FinishedAt.Add(managed.FullSyncEvery)
			d.NextFull = &next
		}
	}
	v := s.view(r, sess, st, "Overview", "/")
	v.Data = d
	if d.Running != nil {
		v.Refresh = 5
	}
	s.render(w, "overview.html", v)
}

// --- registration ------------------------------------------------------------

func (s *Server) registerPage(w http.ResponseWriter, r *http.Request, sess *session) {
	st, err := s.state(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	v := s.view(r, sess, st, "Connect to Oolix", "/register")
	v.Data = map[string]any{"Identity": st.identity}
	s.render(w, "register.html", v)
}

func (s *Server) register(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	v := s.view(r, sess, st, "Connect to Oolix", "/register")
	v.Data = map[string]any{"Identity": st.identity}
	if st.identity != nil {
		redirect(w, r, "/register")
		return
	}
	code := strings.TrimSpace(r.PostFormValue("code"))
	if code == "" {
		v.Error = "Paste the one-time code from the Oolix portal."
		s.render(w, "register.html", v)
		return
	}
	res, err := s.opts.Register(ctx, s.opts.HTTPClient, s.opts.APIBaseURL, code, s.opts.KeyPath,
		[]string{"PARTNER_WEB", "PARTNER_APP"})
	if err != nil {
		v.Error = "Oolix did not accept the code: " + err.Error()
		s.render(w, "register.html", v)
		return
	}
	if res.PartnerOrgID == "" || res.ManifestIssuer == "" {
		v.Error = "Oolix accepted the code but did not say which organisation this Agent belongs to. " +
			"The Oolix control plane is older than this Agent; ask Oolix support to update it."
		s.render(w, "register.html", v)
		return
	}
	id := managed.Identity{
		AgentID: res.AgentID, ClientID: res.ClientID, PartnerOrgID: res.PartnerOrgID,
		ManifestIssuer: res.ManifestIssuer, ManifestAudience: res.ManifestAudience,
		TokenAudience: res.Audience, RegisteredAt: s.opts.Now().UTC(),
	}
	if err := s.settings.SaveIdentity(ctx, id); err != nil {
		s.fail(w, err)
		return
	}
	s.opts.Logger.Info("registered with Oolix from the setup page", "agent_id", id.AgentID)
	if s.opts.OnRegistered != nil {
		s.opts.OnRegistered(id)
	}
	redirect(w, r, "/?notice=registered")
}

// --- database ----------------------------------------------------------------

type option struct{ Value, Label string }

var locations = []option{
	{"Asia/Kolkata", "India (IST)"}, {"UTC", "UTC"}, {"Asia/Dubai", "Gulf (GST)"},
	{"Asia/Singapore", "Singapore (SGT)"}, {"Europe/London", "UK"}, {"America/New_York", "US Eastern"},
}

var tlsModes = []option{
	{"prefer", "Use encryption when the server offers it"},
	{"require", "Always encrypt"},
	{"disable", "Never encrypt (only on a private network)"},
}

type sourceData struct {
	Kinds        []option
	Locations    []option
	TLSModes     []option
	Config       source.Config
	Port         string
	HasPassword  bool
	HasURI       bool
	ImportFolder string
	Files        []string
}

func (s *Server) sourceData(cfg source.Config) sourceData {
	d := sourceData{Locations: locations, TLSModes: tlsModes, Config: cfg, ImportFolder: s.opts.ImportFolder,
		HasPassword: cfg.Password != "", HasURI: cfg.URI != ""}
	for _, k := range source.Kinds {
		d.Kinds = append(d.Kinds, option{string(k), k.Label()})
	}
	if cfg.Port > 0 {
		d.Port = strconv.Itoa(cfg.Port)
	}
	// Never sent back to the browser.
	d.Config.Password, d.Config.URI = "", ""
	if entries, err := os.ReadDir(s.opts.ImportFolder); err == nil {
		for _, e := range entries {
			ext := strings.ToLower(filepath.Ext(e.Name()))
			if !e.IsDir() && slices.Contains([]string{".csv", ".tsv", ".txt", ".xlsx", ".xlsm"}, ext) {
				d.Files = append(d.Files, e.Name())
			}
		}
	}
	return d
}

func (s *Server) sourcePage(w http.ResponseWriter, r *http.Request, sess *session) {
	st, err := s.state(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	cfg := source.Config{Kind: source.Postgres, TLS: "prefer", Location: "Asia/Kolkata"}
	if st.source != nil {
		cfg = *st.source
	}
	v := s.view(r, sess, st, "Connect your database", "/source")
	v.Data = s.sourceData(cfg)
	s.render(w, "source.html", v)
}

func (s *Server) saveSource(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	f := r.PostFormValue
	cfg := source.Config{
		Kind: source.Kind(f("kind")), Host: strings.TrimSpace(f("host")),
		Database: strings.TrimSpace(f("database")), User: strings.TrimSpace(f("user")),
		Password: f("password"), TLS: f("tls"), URI: strings.TrimSpace(f("uri")), Location: f("location"),
	}
	v := s.view(r, sess, st, "Connect your database", "/source")
	show := func(msg string) {
		v.Error = msg
		v.Data = s.sourceData(cfg)
		s.render(w, "source.html", v)
	}
	if !slices.Contains(source.Kinds, cfg.Kind) {
		show("Choose what kind of database it is.")
		return
	}
	if !slices.ContainsFunc(locations, func(o option) bool { return o.Value == cfg.Location }) {
		cfg.Location = "Asia/Kolkata"
	}
	if !slices.ContainsFunc(tlsModes, func(o option) bool { return o.Value == cfg.TLS }) {
		cfg.TLS = "prefer"
	}
	if p := strings.TrimSpace(f("port")); p != "" {
		port, err := strconv.Atoi(p)
		if err != nil || port < 1 || port > 65535 {
			show("The port must be a number between 1 and 65535.")
			return
		}
		cfg.Port = port
	}
	if cfg.Kind == source.File {
		// Always the import folder: the page cannot be used to read files
		// anywhere else on this server.
		cfg = source.Config{Kind: source.File, Folder: s.opts.ImportFolder, Location: cfg.Location}
	} else if saved := st.source; saved != nil && saved.Kind == cfg.Kind {
		// A blank secret keeps the saved one, so correcting a host name does
		// not mean typing the password again.
		if cfg.Password == "" && saved.Host == cfg.Host && saved.User == cfg.User {
			cfg.Password = saved.Password
		}
		if cfg.URI == "" && f("keep_uri") == "on" {
			cfg.URI = saved.URI
		}
	}
	if cfg.Kind != source.File && cfg.URI == "" && (cfg.Host == "" || cfg.Database == "" && cfg.Kind != source.MongoDB) {
		show("Fill in the server address and the database name, or paste a connection string.")
		return
	}

	testCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	src, err := s.opts.OpenSource(testCtx, cfg)
	if err == nil {
		err = src.Test(testCtx)
		if err == nil {
			_, err = src.Tables(testCtx)
		}
		_ = src.Close()
	}
	if err != nil {
		show(explain(err, cfg))
		return
	}
	if err := s.settings.SaveSource(ctx, cfg); err != nil {
		s.fail(w, err)
		return
	}
	s.clearPreview()
	s.opts.Logger.Info("database connection saved from the setup page", "kind", string(cfg.Kind))
	redirect(w, r, "/table?notice=connected")
}

// explain turns a connection error into something a Partner can act on.
func explain(err error, cfg source.Config) string {
	msg := err.Error()
	low := strings.ToLower(msg)
	hint := ""
	host := cfg.Host
	if h, _, splitErr := net.SplitHostPort(host); splitErr == nil {
		host = h
	}
	switch {
	case host == "localhost" || host == "127.0.0.1" || host == "::1":
		hint = "Inside Docker, \"localhost\" is the Agent's own container. Use your database server's " +
			"address -- or host.docker.internal if the database runs on this same machine."
	case strings.Contains(low, "password") || strings.Contains(low, "access denied") ||
		strings.Contains(low, "login failed") || strings.Contains(low, "authentication"):
		hint = "The username or password was not accepted."
	case strings.Contains(low, "no such host"):
		hint = "The server name could not be found from inside the Agent's container."
	case strings.Contains(low, "refused") || strings.Contains(low, "timeout") || strings.Contains(low, "deadline"):
		hint = "Nothing answered at that address. Check the address and port, and that your firewall " +
			"lets this server connect."
	case strings.Contains(low, "tls") || strings.Contains(low, "ssl") || strings.Contains(low, "certificate"):
		hint = "The encryption settings did not match the server's. Try another Encryption option."
	case errors.Is(err, os.ErrNotExist):
		hint = "Put your CSV or Excel files in the import folder first."
	}
	if hint == "" {
		return "Could not connect: " + msg
	}
	return hint + " (" + msg + ")"
}

// --- table -------------------------------------------------------------------

type tableRow struct {
	Name     string
	Rows     int64
	Likely   bool
	Selected bool
}

// likelyCustomers spots a table, collection, file or sheet named for customers.
func likelyCustomers(name string) bool {
	w := strings.ToLower(name)
	for _, hint := range []string{"customer", "user", "member", "client", "account", "subscriber", "profile", "contact"} {
		if strings.Contains(w, hint) {
			return true
		}
	}
	return false
}

func (s *Server) tables(ctx context.Context, cfg source.Config) ([]source.Table, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	src, err := s.opts.OpenSource(ctx, cfg)
	if err != nil {
		return nil, err
	}
	defer src.Close()
	return src.Tables(ctx)
}

func (s *Server) tablePage(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	if st.source == nil {
		redirect(w, r, "/source")
		return
	}
	v := s.view(r, sess, st, "Choose the customer table", "/table")
	tables, err := s.tables(ctx, *st.source)
	if err != nil {
		v.Error = explain(err, *st.source)
	}
	current := ""
	if st.draft != nil {
		current = st.draft.Table
	}
	rows := make([]tableRow, 0, len(tables))
	for _, t := range tables {
		rows = append(rows, tableRow{Name: t.Name, Rows: t.Rows, Likely: likelyCustomers(t.Name), Selected: t.Name == current})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Likely != rows[j].Likely {
			return rows[i].Likely
		}
		return rows[i].Rows > rows[j].Rows
	})
	if current == "" && len(rows) > 0 && rows[0].Likely {
		rows[0].Selected = true
	}
	v.Data = map[string]any{"Tables": rows, "Kind": st.source.Kind.Label()}
	s.render(w, "table.html", v)
}

func (s *Server) chooseTable(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	if st.source == nil {
		redirect(w, r, "/source")
		return
	}
	table := r.PostFormValue("table")
	tables, err := s.tables(ctx, *st.source)
	if err != nil || !slices.ContainsFunc(tables, func(t source.Table) bool { return t.Name == table }) {
		redirect(w, r, "/table")
		return
	}
	p, err := s.takePreview(ctx, *st.source, table)
	if err != nil {
		v := s.view(r, sess, st, "Choose the customer table", "/table")
		v.Error = "Could not read a sample of " + table + ": " + err.Error()
		v.Data = map[string]any{"Kind": st.source.Kind.Label()}
		s.render(w, "table.html", v)
		return
	}
	if st.draft == nil || st.draft.Table != table {
		d := suggestMapping(p, st.draft, s.opts.Now())
		if err := s.settings.SaveDraft(ctx, d); err != nil {
			s.fail(w, err)
			return
		}
	}
	redirect(w, r, "/review")
}

// suggestMapping starts a draft from what the tool found in the sample.
func suggestMapping(p *preview, prev *managed.Mapping, now time.Time) managed.Mapping {
	m := managed.Mapping{Table: p.table, Attributes: map[string]managed.AttributeMapping{},
		SyncHour: 2, Channels: []string{"PARTNER_WEB"}}
	if prev != nil {
		m.SyncHour, m.Channels = prev.SyncHour, prev.Channels
	}
	m.IDColumn, _ = detect.SuggestID(p.columns, p.sample)
	consent, withdrawal := detect.SuggestConsent(p.columns)
	m.Consent = managed.ConsentMapping{Column: consent, Withdrawal: withdrawal}
	for _, sg := range detect.Suggest(p.columns, p.sample, now) {
		if sg.Column != "" {
			m.Attributes[sg.Attribute] = managed.AttributeMapping{Column: sg.Column, Order: sg.Order, Publish: true}
		}
	}
	return m
}

func (s *Server) takePreview(ctx context.Context, cfg source.Config, table string) (*preview, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	src, err := s.opts.OpenSource(ctx, cfg)
	if err != nil {
		return nil, err
	}
	defer src.Close()
	cols, err := src.Columns(ctx, table)
	if err != nil {
		return nil, err
	}
	sample, err := src.Sample(ctx, table, sampleRows)
	if err != nil {
		return nil, err
	}
	p := &preview{table: table, columns: cols, sample: sample, takenAt: s.opts.Now()}
	s.mu.Lock()
	// A few tables at most: the customer table, orders and bookings.
	if len(s.previews) >= 4 {
		s.previews = map[string]*preview{}
	}
	s.previews[table] = p
	s.mu.Unlock()
	return p, nil
}

func (s *Server) clearPreview() {
	s.mu.Lock()
	s.previews = map[string]*preview{}
	s.mu.Unlock()
}

// previewOf returns a sample of a table, taking a new one when there is none
// or it is old.
func (s *Server) previewOf(ctx context.Context, st state, table string) (*preview, error) {
	s.mu.Lock()
	p := s.previews[table]
	s.mu.Unlock()
	if p != nil && s.opts.Now().Sub(p.takenAt) < previewMaxAge {
		return p, nil
	}
	if st.source == nil {
		return nil, errors.New("connect your database first")
	}
	return s.takePreview(ctx, *st.source, table)
}

// currentPreview is the sample of the draft's customer table.
func (s *Server) currentPreview(ctx context.Context, st state) (*preview, error) {
	return s.previewOf(ctx, st, st.draft.Table)
}

// --- review ------------------------------------------------------------------

var groups = []struct {
	Name string
	Keys []string
}{
	{"About the customer", []string{"age", "gender", "country", "state_region", "city"}},
	{"Shopping", []string{"online_shopper", "purchase_category", "purchase_recency_days", "purchase_frequency",
		"payment_method", "loyalty_tier"}},
	{"Travel", []string{"recent_booking", "domestic_international", "booking_recency_days"}},
	{"Activity", []string{"active_user_days", "app_active"}},
}

// expects tells the Partner what kind of column each attribute wants.
var expects = map[string]string{
	"age":                    "Date of birth. Age is worked out from it; customers under 18 are left out.",
	"gender":                 "Male, female or other -- in any spelling or code (M, F, 1, 2...).",
	"country":                "Country name or code.",
	"state_region":           "State name or code (Maharashtra, MH...).",
	"city":                   "City name, old or new (Bombay, Mumbai...).",
	"online_shopper":         "Yes/no: has bought online.",
	"purchase_category":      "The kind of product they buy most.",
	"purchase_recency_days":  "Date of the last order.",
	"purchase_frequency":     "Number of purchases in the last 90 days.",
	"payment_method":         "How they usually pay (UPI, card, COD...).",
	"recent_booking":         "Yes/no: has a recent booking.",
	"domestic_international": "Domestic or international travel.",
	"booking_recency_days":   "Date of the last booking.",
	"active_user_days":       "When the customer was last active, such as the last login.",
	"app_active":             "Yes/no: uses your app.",
	"loyalty_tier":           "Loyalty tier (Bronze, Silver, Gold, Platinum).",
}

type answer struct {
	Raw   string
	Count int
	Code  string // "" undecided, "-" ignore, or a code
}

type attrRow struct {
	Key, Label, Expects string
	// FromActivity names the table that supplies the attribute instead.
	FromActivity string
	Column       string
	Measure      managed.Measurement
	Percent      int
	IsDate       bool
	AskOrder     bool
	Order        string
	OrderNote    string
	Codes        []string
	Answers      []answer
	Publish      bool
	Problem      string
}

type reviewGroup struct {
	Name string
	Rows []attrRow
}

type columnOption struct {
	Name, Type string
	Unique     int
}

type reviewData struct {
	Table    string
	Columns  []columnOption
	IDColumn string
	IDUnique int
	Groups   []reviewGroup
	Sampled  int
	// TimeColumns can serve as the changed-at column; empty for files, which
	// are read whole.
	TimeColumns   []string
	UpdatedColumn string
}

func (s *Server) reviewPage(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	if st.draft == nil || st.draft.Table == "" {
		redirect(w, r, "/table")
		return
	}
	v := s.view(r, sess, st, "Check the matches", "/review")
	p, err := s.currentPreview(ctx, st)
	if err != nil {
		v.Error = "Could not read a sample of the table: " + err.Error()
		v.Data = reviewData{Table: st.draft.Table}
		s.render(w, "review.html", v)
		return
	}
	v.Data = s.reviewData(p, st.draft)
	if e := r.URL.Query().Get("problem"); e == "id" {
		v.Error = "Choose the column that holds the customer ID."
	} else if e == "none" {
		v.Error = "Choose a column for at least one attribute here, or add an orders or bookings table " +
			"on the next step."
	}
	s.render(w, "review.html", v)
}

func uniqueShare(values []any) int {
	seen := map[string]bool{}
	filled := 0
	for _, v := range values {
		t := strings.TrimSpace(clean.Text(v))
		if t == "" {
			continue
		}
		filled++
		seen[t] = true
	}
	return percent(len(seen), filled)
}

func (s *Server) reviewData(p *preview, m *managed.Mapping) reviewData {
	now := s.opts.Now()
	d := reviewData{Table: p.table, IDColumn: m.IDColumn, UpdatedColumn: m.UpdatedColumn}
	for _, c := range p.columns {
		d.Columns = append(d.Columns, columnOption{Name: c.Name, Type: c.Type})
		d.Sampled = max(d.Sampled, len(p.sample[c.Name]))
		if source.TimeType(c.Type) {
			d.TimeColumns = append(d.TimeColumns, c.Name)
		}
	}
	provides := managed.ActivityProvides(*m)
	if m.IDColumn != "" {
		d.IDUnique = uniqueShare(p.sample[m.IDColumn])
	}
	for _, g := range groups {
		rg := reviewGroup{Name: g.Name}
		for _, key := range g.Keys {
			a, _ := standard.ByKey(key)
			am := m.Attributes[key]
			row := attrRow{Key: key, Label: a.Label, Expects: expects[key], Column: am.Column,
				IsDate: a.Kind == standard.KindDate || a.Kind == standard.KindTimestamp,
				Codes:  a.Allowed, Publish: am.Publish || am.Column == ""}
			if provides[key] {
				row.FromActivity = "bookings"
				if slices.Contains(standard.OrderKeys, key) {
					row.FromActivity = "orders"
				}
				row.Column = ""
			} else if am.Column != "" {
				values := p.sample[am.Column]
				if row.IsDate {
					report := clean.DetectOrder(values)
					if report.DayFirst+report.MonthFirst+report.Ambiguous > 0 {
						row.AskOrder = true
						decision := report.Decide()
						if !decision.Confident {
							row.OrderNote = decision.Note
						}
						if am.Order == clean.OrderUnknown {
							am.Order = decision.Order
						}
					}
					switch am.Order {
					case clean.DayFirst:
						row.Order = "day"
					case clean.MonthFirst:
						row.Order = "month"
					}
				}
				ms, err := managed.Measure(a, am, "", values, now)
				if err != nil {
					row.Problem = err.Error()
				}
				row.Measure, row.Percent = ms, ms.Percent()
				// The Partner's earlier answers first, then what is still open.
				for _, raw := range sortedKeys(am.Overrides) {
					code := am.Overrides[raw]
					if code == "" {
						code = "-"
					}
					row.Answers = append(row.Answers, answer{Raw: raw, Code: code})
				}
				for _, u := range ms.Unrecognised {
					row.Answers = append(row.Answers, answer{Raw: u.Value, Count: u.Count})
				}
			}
			rg.Rows = append(rg.Rows, row)
		}
		d.Groups = append(d.Groups, rg)
	}
	return d
}

func (s *Server) saveReview(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	if st.draft == nil || st.draft.Table == "" {
		redirect(w, r, "/table")
		return
	}
	p, err := s.currentPreview(ctx, st)
	if err != nil {
		redirect(w, r, "/review")
		return
	}
	known := map[string]bool{}
	for _, c := range p.columns {
		known[c.Name] = true
	}
	f := r.PostFormValue
	m := *st.draft
	if id := f("id_column"); known[id] {
		m.IDColumn = id
	} else {
		m.IDColumn = ""
	}
	m.UpdatedColumn = ""
	for _, c := range p.columns {
		if c.Name == f("updated_column") && source.TimeType(c.Type) {
			m.UpdatedColumn = c.Name
		}
	}
	provides := managed.ActivityProvides(m)
	m.Attributes = map[string]managed.AttributeMapping{}
	for _, a := range standard.Attributes {
		col := f("col_" + a.Key)
		if !known[col] || provides[a.Key] {
			continue
		}
		prev := st.draft.Attributes[a.Key]
		am := managed.AttributeMapping{Column: col, Publish: f("publish_"+a.Key) == "on" || prev.Column != col}
		switch f("order_" + a.Key) {
		case "day":
			am.Order = clean.DayFirst
		case "month":
			am.Order = clean.MonthFirst
		}
		if a.Kind == standard.KindEnum && prev.Column == col {
			am.Overrides = map[string]string{}
			for i := 0; i < 200; i++ {
				raw := f(fmt.Sprintf("raw_%s_%d", a.Key, i))
				if raw == "" {
					break
				}
				switch code := f(fmt.Sprintf("code_%s_%d", a.Key, i)); {
				case code == "-":
					am.Overrides[raw] = ""
				case slices.Contains(a.Allowed, code):
					am.Overrides[raw] = code
				}
			}
		}
		m.Attributes[a.Key] = am
	}
	if err := s.settings.SaveDraft(ctx, m); err != nil {
		s.fail(w, err)
		return
	}
	if f("action") != "next" {
		redirect(w, r, "/review?notice=saved")
		return
	}
	if m.IDColumn == "" {
		redirect(w, r, "/review?problem=id")
		return
	}
	// Orders and bookings next; nothing need be matched here if they
	// supply everything.
	redirect(w, r, "/activity")
}

// --- consent and publish -----------------------------------------------------

type consentData struct {
	Columns    []columnOption
	Consent    managed.ConsentMapping
	Measure    managed.ConsentMeasurement
	Web, App   bool
	SyncHour   int
	Hours      []int
	Offered    []string
	Registered bool
}

func (s *Server) consentData(st state, p *preview, m *managed.Mapping) consentData {
	d := consentData{Consent: m.Consent, SyncHour: m.SyncHour, Registered: st.identity != nil,
		Web: slices.Contains(m.Channels, "PARTNER_WEB"), App: slices.Contains(m.Channels, "PARTNER_APP")}
	for h := 0; h < 24; h++ {
		d.Hours = append(d.Hours, h)
	}
	for _, c := range p.columns {
		d.Columns = append(d.Columns, columnOption{Name: c.Name, Type: c.Type})
	}
	d.Measure = managed.MeasureConsent(m.Consent, "", p.sample, s.opts.Now())
	d.Offered = offered(m)
	return d
}

// offered lists the labels of the attributes the Partner chose to offer,
// from the customer table and from orders and bookings.
func offered(m *managed.Mapping) []string {
	provides := managed.ActivityProvides(*m)
	var out []string
	for _, a := range standard.Attributes {
		if provides[a.Key] {
			if !slices.Contains(withheld(m), a.Key) {
				out = append(out, a.Label)
			}
			continue
		}
		if am, ok := m.Attributes[a.Key]; ok && am.Column != "" && am.Publish {
			out = append(out, a.Label)
		}
	}
	return out
}

func withheld(m *managed.Mapping) []string {
	var out []string
	for _, am := range []*managed.ActivityMapping{m.Orders, m.Bookings} {
		if am != nil {
			out = append(out, am.Withhold...)
		}
	}
	return out
}

func (s *Server) consentPage(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	if !st.reviewed() {
		if st.draft != nil && st.draft.IDColumn != "" {
			redirect(w, r, "/review?problem=none")
			return
		}
		redirect(w, r, "/review")
		return
	}
	v := s.view(r, sess, st, "Consent and publish", "/consent")
	p, err := s.currentPreview(ctx, st)
	if err != nil {
		v.Error = "Could not read a sample of the table: " + err.Error()
		v.Data = consentData{}
		s.render(w, "consent.html", v)
		return
	}
	v.Data = s.consentData(st, p, st.draft)
	s.render(w, "consent.html", v)
}

func (s *Server) saveConsent(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	if !st.reviewed() {
		redirect(w, r, "/review")
		return
	}
	p, err := s.currentPreview(ctx, st)
	if err != nil {
		redirect(w, r, "/consent")
		return
	}
	known := map[string]bool{}
	for _, c := range p.columns {
		known[c.Name] = true
	}
	f := r.PostFormValue
	m := *st.draft
	m.Consent = managed.ConsentMapping{Everyone: f("everyone") == "on"}
	if col := f("consent_column"); known[col] && !m.Consent.Everyone {
		m.Consent.Column = col
	}
	if col := f("withdrawal_column"); known[col] {
		m.Consent.Withdrawal = col
	}
	m.Channels = nil
	if f("web") == "on" {
		m.Channels = append(m.Channels, "PARTNER_WEB")
	}
	if f("app") == "on" {
		m.Channels = append(m.Channels, "PARTNER_APP")
	}
	if h, err := strconv.Atoi(f("sync_hour")); err == nil && h >= 0 && h < 24 {
		m.SyncHour = h
	}
	if err := s.settings.SaveDraft(ctx, m); err != nil {
		s.fail(w, err)
		return
	}
	if f("action") != "publish" {
		redirect(w, r, "/consent?notice=saved")
		return
	}

	v := s.view(r, sess, st, "Consent and publish", "/consent")
	d := s.consentData(st, p, &m)
	v.Data = d
	problem := ""
	switch {
	case st.identity == nil:
		problem = "Connect this Agent to Oolix first (step 1)."
	case m.Consent.Column == "" && !m.Consent.Everyone:
		problem = "Choose the column that records agreement to marketing. Without it nobody can be shown an ad."
	case d.Measure.Agreed == 0:
		problem = "In a sample of your table nobody has agreed to marketing according to the column you chose. " +
			"Check that it is the right column."
	case len(m.Channels) == 0:
		problem = "Choose where you show ads: your website, your app, or both."
	case len(d.Offered) == 0:
		problem = "Choose at least one attribute to offer to advertisers on the previous step."
	}
	if problem != "" {
		v.Error = problem
		s.render(w, "consent.html", v)
		return
	}
	now := s.opts.Now().UTC()
	if m.Consent.Everyone {
		m.Consent.AttestedAt = &now
	}
	if err := s.settings.Publish(ctx, m, now); err != nil {
		s.fail(w, err)
		return
	}
	s.opts.Logger.Info("published from the setup page; copying the customer table now",
		"attributes", len(d.Offered))
	s.opts.Runner.Reschedule()
	s.opts.Runner.SyncNow()
	redirect(w, r, "/?notice=publishing")
}

// --- actions -----------------------------------------------------------------

func (s *Server) syncNow(w http.ResponseWriter, r *http.Request, _ *session) {
	if s.opts.Runner.SyncNow() {
		redirect(w, r, "/?notice=syncing")
		return
	}
	redirect(w, r, "/?notice=queued")
}

func (s *Server) deleteCopy(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	if strings.TrimSpace(r.PostFormValue("confirm")) != "DELETE" {
		st, err := s.state(ctx)
		if err != nil {
			s.fail(w, err)
			return
		}
		redirect(w, r, st.next())
		return
	}
	if err := s.opts.Runner.DeleteCopy(ctx); err != nil {
		s.fail(w, err)
		return
	}
	s.clearPreview()
	if r.PostFormValue("forget") == "on" {
		if err := s.settings.Forget(ctx); err != nil {
			s.fail(w, err)
			return
		}
		redirect(w, r, "/?notice=forgotten")
		return
	}
	redirect(w, r, "/?notice=deleted")
}
