// Package setupui is the managed Agent's setup and status pages: the whole of
// a Partner's integration work, done in a browser on their own server.
//
// It is plain on purpose -- Go templates, one stylesheet and a few lines of
// script, all embedded in the binary -- so the image stays small and a
// Partner's security team can read every line of what they run. The pages
// accept a database login, so they sit behind a password, carry a CSRF token
// on every form, and belong on a private network only.
package setupui

import (
	"bytes"
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/controlsync"
	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/source"
)

//go:embed templates static
var assets embed.FS

// Options wires the pages to the rest of the Agent.
type Options struct {
	Store  *localstore.Store
	Runner *managed.Runner
	Logger *slog.Logger
	// APIBaseURL is the Oolix control plane that registration talks to.
	APIBaseURL string
	// KeyPath is where registration writes the Agent's private key.
	KeyPath string
	// ImportFolder is the only folder CSV and Excel files are read from.
	ImportFolder string
	// Password, when set, is the setup password (OOLIX_SETUP_PASSWORD).
	// Otherwise one is generated on first start and written to the log once.
	Password string
	// OnRegistered is told once the Agent has an identity, so serving starts.
	OnRegistered func(managed.Identity)

	HTTPClient *http.Client
	Register   func(ctx context.Context, client *http.Client, apiBaseURL, token, keyPath string,
		capabilities []string) (*controlsync.RegistrationResult, error)
	OpenSource func(ctx context.Context, cfg source.Config) (source.Source, error)
	Now        func() time.Time
}

const (
	cookieName    = "oolix_setup"
	sessionTTL    = 8 * time.Hour
	maxSessions   = 64
	loginWindow   = 15 * time.Minute
	maxFailures   = 5
	sampleRows    = 1000
	previewMaxAge = 30 * time.Minute
	passwordKey   = "setup_password"
	pbkdfRounds   = 600_000
)

// Server serves the setup pages.
type Server struct {
	opts     Options
	settings managed.Settings
	pages    map[string]*template.Template
	static   http.Handler

	mu       sync.Mutex
	sessions map[string]*session
	failures map[string][]time.Time
	previews map[string]*preview
}

type session struct {
	csrf    string
	expires time.Time
}

// preview is a sample of a table the Partner is reviewing -- the customer
// table, or an orders or bookings table -- held in memory only: raw values
// are never written to disk.
type preview struct {
	table   string
	columns []detect.Column
	sample  map[string][]any
	takenAt time.Time
}

// New prepares the pages and makes sure there is a setup password.
func New(ctx context.Context, opts Options) (*Server, error) {
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	}
	if opts.Register == nil {
		opts.Register = controlsync.Register
	}
	if opts.OpenSource == nil {
		opts.OpenSource = source.Open
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	s := &Server{
		opts:     opts,
		settings: managed.Settings{Store: opts.Store},
		pages:    map[string]*template.Template{},
		sessions: map[string]*session{},
		failures: map[string][]time.Time{},
		previews: map[string]*preview{},
	}
	names, err := fs.Glob(assets, "templates/*.html")
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		base := strings.TrimPrefix(name, "templates/")
		if base == "layout.html" {
			continue
		}
		t, err := template.New(base).Funcs(funcs).ParseFS(assets, "templates/layout.html", name)
		if err != nil {
			return nil, fmt.Errorf("setup page %s: %w", base, err)
		}
		s.pages[base] = t
	}
	static, err := fs.Sub(assets, "static")
	if err != nil {
		return nil, err
	}
	s.static = http.StripPrefix("/static/", http.FileServer(http.FS(static)))
	if err := s.ensurePassword(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// Handler routes the pages.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /static/", s.static)
	mux.HandleFunc("GET /login", s.loginPage)
	mux.HandleFunc("POST /login", s.login)
	mux.HandleFunc("POST /logout", s.auth(s.logout))
	mux.HandleFunc("GET /{$}", s.auth(s.overview))
	mux.HandleFunc("GET /register", s.auth(s.registerPage))
	mux.HandleFunc("POST /register", s.auth(s.register))
	mux.HandleFunc("GET /source", s.auth(s.sourcePage))
	mux.HandleFunc("POST /source", s.auth(s.saveSource))
	mux.HandleFunc("GET /table", s.auth(s.tablePage))
	mux.HandleFunc("POST /table", s.auth(s.chooseTable))
	mux.HandleFunc("GET /review", s.auth(s.reviewPage))
	mux.HandleFunc("POST /review", s.auth(s.saveReview))
	mux.HandleFunc("GET /activity", s.auth(s.activityPage))
	mux.HandleFunc("POST /activity", s.auth(s.saveActivity))
	mux.HandleFunc("GET /consent", s.auth(s.consentPage))
	mux.HandleFunc("POST /consent", s.auth(s.saveConsent))
	mux.HandleFunc("POST /sync", s.auth(s.syncNow))
	mux.HandleFunc("POST /delete", s.auth(s.deleteCopy))
	return s.secure(mux)
}

// secure sets the headers every response carries and caps request size.
func (s *Server) secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		if !strings.HasPrefix(r.URL.Path, "/static/") {
			h.Set("Cache-Control", "no-store")
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		next.ServeHTTP(w, r)
	})
}

type handler func(w http.ResponseWriter, r *http.Request, sess *session)

// auth requires a signed-in session, and on a POST a matching CSRF token.
func (s *Server) auth(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess := s.session(r)
		if sess == nil {
			if r.Method == http.MethodGet {
				http.Redirect(w, r, "/login", http.StatusSeeOther)
				return
			}
			http.Error(w, "Your session has ended. Sign in again.", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodPost {
			if err := r.ParseForm(); err != nil {
				http.Error(w, "The form could not be read.", http.StatusBadRequest)
				return
			}
			got := r.PostFormValue("csrf")
			if subtle.ConstantTimeCompare([]byte(got), []byte(sess.csrf)) != 1 {
				http.Error(w, "This form has expired. Go back, reload the page and try again.", http.StatusForbidden)
				return
			}
		}
		h(w, r, sess)
	}
}

func (s *Server) session(r *http.Request) *session {
	c, err := r.Cookie(cookieName)
	if err != nil || c.Value == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess := s.sessions[c.Value]
	if sess == nil || s.opts.Now().After(sess.expires) {
		delete(s.sessions, c.Value)
		return nil
	}
	return sess
}

// --- sign-in -----------------------------------------------------------------

type passwordRecord struct {
	Salt   []byte `json:"salt"`
	Hash   []byte `json:"hash"`
	Rounds int    `json:"rounds"`
}

func hashPassword(password string, salt []byte, rounds int) ([]byte, error) {
	return pbkdf2.Key(sha256.New, password, salt, rounds, 32)
}

func (s *Server) ensurePassword(ctx context.Context) error {
	store := s.opts.Store
	if s.opts.Password != "" {
		if len(s.opts.Password) < 12 {
			return errors.New("OOLIX_SETUP_PASSWORD must be at least 12 characters")
		}
		if err := s.savePassword(ctx, s.opts.Password); err != nil {
			return err
		}
		s.opts.Logger.Info("setup page password taken from OOLIX_SETUP_PASSWORD")
		return nil
	}
	var rec passwordRecord
	ok, err := store.Get(ctx, passwordKey, &rec)
	if err != nil {
		return err
	}
	if ok {
		s.opts.Logger.Info("setup page ready; its password was written to this log when the Agent first " +
			"started. To choose a new one, restart the Agent with OOLIX_SETUP_PASSWORD set")
		return nil
	}
	password := newPassword()
	if err := s.savePassword(ctx, password); err != nil {
		return err
	}
	// Written once. The log is the Partner's own, on their own server; after
	// this line only the hash exists.
	s.opts.Logger.Warn("setup page password -- shown this once, keep it safe",
		"setup_password", password)
	return nil
}

func (s *Server) savePassword(ctx context.Context, password string) error {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	hash, err := hashPassword(password, salt, pbkdfRounds)
	if err != nil {
		return err
	}
	return s.opts.Store.Put(ctx, passwordKey, passwordRecord{Salt: salt, Hash: hash, Rounds: pbkdfRounds})
}

// newPassword is 20 characters that cannot be misread: no 0/o, 1/l/i.
func newPassword() string {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
	var b strings.Builder
	for i := 0; i < 20; i++ {
		if i > 0 && i%5 == 0 {
			b.WriteByte('-')
		}
		b.WriteByte(alphabet[randInt(len(alphabet))])
	}
	return b.String()
}

func randInt(n int) int {
	var buf [1]byte
	for {
		if _, err := rand.Read(buf[:]); err != nil {
			panic(err)
		}
		// Rejection sampling keeps every character equally likely.
		if int(buf[0]) < 256-256%n {
			return int(buf[0]) % n
		}
	}
}

func token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// tooManyFailures reports whether a client has failed to sign in too often.
func (s *Server) tooManyFailures(client string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := s.opts.Now().Add(-loginWindow)
	kept := s.failures[client][:0]
	for _, t := range s.failures[client] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	s.failures[client] = kept
	return len(kept) >= maxFailures
}

func (s *Server) recordFailure(client string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures[client] = append(s.failures[client], s.opts.Now())
}

func (s *Server) loginPage(w http.ResponseWriter, r *http.Request) {
	if s.session(r) != nil {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	s.render(w, "login.html", view{Title: "Sign in"})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	client := clientKey(r)
	if s.tooManyFailures(client) {
		w.WriteHeader(http.StatusTooManyRequests)
		s.render(w, "login.html", view{Title: "Sign in",
			Error: "Too many wrong passwords. Wait 15 minutes, then try again."})
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "The form could not be read.", http.StatusBadRequest)
		return
	}
	var rec passwordRecord
	ok, err := s.opts.Store.Get(r.Context(), passwordKey, &rec)
	if err != nil || !ok {
		http.Error(w, "The setup password is not available. Check the Agent's log.", http.StatusInternalServerError)
		return
	}
	given := strings.TrimSpace(r.PostFormValue("password"))
	hash, err := hashPassword(given, rec.Salt, rec.Rounds)
	if err != nil || subtle.ConstantTimeCompare(hash, rec.Hash) != 1 {
		s.recordFailure(client)
		s.opts.Logger.Warn("wrong setup page password", "client", client)
		w.WriteHeader(http.StatusUnauthorized)
		s.render(w, "login.html", view{Title: "Sign in", Error: "That password is not right."})
		return
	}

	id, sess := token(), &session{csrf: token(), expires: s.opts.Now().Add(sessionTTL)}
	s.mu.Lock()
	for k, v := range s.sessions {
		if s.opts.Now().After(v.expires) {
			delete(s.sessions, k)
		}
	}
	if len(s.sessions) >= maxSessions {
		// The oldest session makes room.
		oldest := ""
		for k, v := range s.sessions {
			if oldest == "" || v.expires.Before(s.sessions[oldest].expires) {
				oldest = k
			}
		}
		delete(s.sessions, oldest)
	}
	s.sessions[id] = sess
	delete(s.failures, client)
	s.mu.Unlock()

	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: id, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil,
		MaxAge: int(sessionTTL.Seconds()),
	})
	s.opts.Logger.Info("signed in to the setup page", "client", client)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request, _ *session) {
	if c, err := r.Cookie(cookieName); err == nil {
		s.mu.Lock()
		delete(s.sessions, c.Value)
		s.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		SameSite: http.SameSiteStrictMode})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

// --- rendering ---------------------------------------------------------------

type view struct {
	Title   string
	CSRF    string
	Steps   []step
	Notice  string
	Error   string
	Refresh int
	Data    any
}

func (s *Server) render(w http.ResponseWriter, name string, v view) {
	t, ok := s.pages[name]
	if !ok {
		http.Error(w, "No such page.", http.StatusNotFound)
		return
	}
	var buf bytes.Buffer
	if err := t.ExecuteTemplate(&buf, "layout", v); err != nil {
		s.opts.Logger.Error("showing a setup page failed", "page", name, "error", err.Error())
		http.Error(w, "The page could not be shown. The Agent's log has the details.", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = buf.WriteTo(w)
}

var notices = map[string]string{
	"registered": "Connected to Oolix.",
	"connected":  "Connected to your database. Now choose the table that lists your customers.",
	"saved":      "Saved.",
	"publishing": "Publishing. The Agent is copying your customer table now -- this page refreshes by itself.",
	"syncing":    "Refreshing the copy now.",
	"queued":     "A refresh is already waiting to start.",
	"deleted":    "All copied data has been deleted, and your attributes have been withdrawn from Oolix.",
	"forgotten":  "All copied data, your database login and your choices have been deleted.",
}

var funcs = template.FuncMap{
	"num": func(v any) string {
		switch n := v.(type) {
		case int:
			return indianNumber(n)
		case int64:
			return indianNumber(int(n))
		case int32:
			return indianNumber(int(n))
		}
		return fmt.Sprint(v)
	},
	"lower":   strings.ToLower,
	"when":    when,
	"percent": percent,
	"join":    strings.Join,
	"inc":     func(i int) int { return i + 1 },
	"deref": func(t *time.Time) time.Time {
		if t == nil {
			return time.Time{}
		}
		return *t
	},
}

// indianNumber groups digits the Indian way: 12,34,567.
func indianNumber(n int) string {
	neg := n < 0
	if neg {
		n = -n
	}
	s := fmt.Sprint(n)
	if len(s) > 3 {
		head, tail := s[:len(s)-3], s[len(s)-3:]
		var parts []string
		for len(head) > 2 {
			parts = append([]string{head[len(head)-2:]}, parts...)
			head = head[:len(head)-2]
		}
		if head != "" {
			parts = append([]string{head}, parts...)
		}
		s = strings.Join(append(parts, tail), ",")
	}
	if neg {
		return "-" + s
	}
	return s
}

func when(v any) string {
	var t time.Time
	switch x := v.(type) {
	case time.Time:
		t = x
	case *time.Time:
		if x == nil {
			return ""
		}
		t = *x
	default:
		return ""
	}
	if t.IsZero() {
		return ""
	}
	return t.In(clean.India).Format("2 Jan 2006, 3:04 pm") + " IST"
}

func percent(part, whole int) int {
	if whole <= 0 {
		return 0
	}
	return int(float64(part) / float64(whole) * 100)
}

// sortedKeys is for stable output in tests and pages.
func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
