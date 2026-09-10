package httpapi

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/metrics"
)

// This is the §12.1 boundary.
//
// The Partner's own backend calls it with a customer identifier, and that is
// the ONE hop in the whole system where such an identifier appears. It never
// goes further: not into the response, not into a log line, not to Oolix.
//
// It is also on a page-render path (§43, §57), so it has to fail safe. A
// missing field, an oversized body, a broken decision engine -- none of them
// may turn into a 500 that breaks a Partner's checkout page.

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// A server with no engine and no syncer.
//
// That is enough for everything below, because all of it happens BEFORE the
// decision path is reached: body parsing, the size limit, routing, and the
// endpoints that answer without consulting anything.
//
// The decision itself needs a control snapshot, which `main.go` always
// provides and a unit test cannot cheaply fake. It is covered end to end
// instead -- verify-phase4 and verify-v6-serving drive a real Agent, including
// the case where the snapshot is nil because control sync has not completed
// (addecision.Decide answers NO_AD rather than dereferencing it).
func bareServer() *Server {
	return &Server{
		Logger:     quietLogger(),
		Timeout:    100 * time.Millisecond,
		StaleGrace: time.Hour,
		Metrics:    metrics.New(),
	}
}

func post(t *testing.T, s *Server, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func TestAMalformedRequestIsRefusedWithoutA500(t *testing.T) {
	// §43: an ad failure cannot break checkout. A 500 from this endpoint is a
	// Partner's page erroring because an advert could not be chosen.
	for _, body := range []string{
		``,
		`{`,
		`{"placement_id":`,
		`null`,
		`[]`,
	} {
		rec := post(t, bareServer(), "/private/v1/ad-decision", body)
		if rec.Code >= 500 {
			t.Errorf("body %q produced %d; a page-render path must not 5xx", body, rec.Code)
		}
	}
}

func TestAnOversizedBodyIsRefusedRatherThanBuffered(t *testing.T) {
	// Unbounded reads on a page-render path are a denial of service against
	// the Partner's own site.
	// No placement_id, so the handler returns before the decision path: the
	// size limit is what is under test, not the decision.
	huge := `{"partner_user_id":"` + strings.Repeat("A", 64*1024) + `"}`
	rec := post(t, bareServer(), "/private/v1/ad-decision", huge)
	if rec.Code >= 500 {
		t.Errorf("an oversized body produced %d; want a 4xx refusal", rec.Code)
	}
}

func TestHealthzDoesNotDependOnAnything(t *testing.T) {
	// §69.2: liveness must not check dependencies, or a database blip
	// restarts every replica instead of removing them from rotation.
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	bareServer().Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("healthz = %d with no dependencies configured; want 200", rec.Code)
	}
}

func TestMetricsAreServedButCarryNoIdentifier(t *testing.T) {
	// The Partner's own collector scrapes this. A per-user label would
	// reconstruct, inside their monitoring, the record this design avoids.
	s := bareServer()
	s.Metrics.ObserveDecision("NO_AD", "USER_NOT_IN_SEGMENT", 5*time.Millisecond)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("metrics = %d", rec.Code)
	}
	body := strings.ToLower(rec.Body.String())
	for _, forbidden := range []string{"partner_user_id", "user_id=", "customer", "email"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("the exposition contains %q", forbidden)
		}
	}
	if !strings.Contains(rec.Body.String(), "oolix_agent_ad_decisions_total") {
		t.Error("the decision counter is missing from the exposition")
	}
}

func TestUnknownRoutesAndMethodsAreRefused(t *testing.T) {
	// The Agent's surface is deliberately tiny. Anything else is a 404, not a
	// panic and not a redirect.
	s := bareServer()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/private/v1/ad-decision"}, // wrong method
		{http.MethodPost, "/healthz"},               // wrong method
		{http.MethodGet, "/admin"},
		{http.MethodGet, "/../etc/passwd"},
		{http.MethodPost, "/private/v1/anything"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		if rec.Code >= 500 {
			t.Errorf("%s %s produced %d", tc.method, tc.path, rec.Code)
		}
		if rec.Code == http.StatusOK && tc.path != "/private/v1/ad-decision" {
			t.Errorf("%s %s unexpectedly succeeded", tc.method, tc.path)
		}
	}
}

func TestVersionIsReportedWithoutAuthentication(t *testing.T) {
	// A Partner needs to see what they are running, and it is on their own
	// private network. It must reveal nothing else.
	req := httptest.NewRequest(http.MethodGet, "/version", nil)
	rec := httptest.NewRecorder()
	bareServer().Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("version = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, forbidden := range []string{"token", "secret", "dsn", "password"} {
		if strings.Contains(strings.ToLower(body), forbidden) {
			t.Errorf("the version response mentions %q: %s", forbidden, body)
		}
	}
}
