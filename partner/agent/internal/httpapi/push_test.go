package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakePusher struct {
	withdrawn []string
	rows      []map[string]any
	err       error
}

func (f *fakePusher) Authorized(_ context.Context, token string) bool { return token == "oxp_secret" }
func (f *fakePusher) WithdrawConsent(_ context.Context, id string) error {
	f.withdrawn = append(f.withdrawn, id)
	return f.err
}
func (f *fakePusher) RestoreConsent(context.Context, string) error { return f.err }
func (f *fakePusher) Customers(_ context.Context, rows []map[string]any) (PushResult, error) {
	f.rows = rows
	return PushResult{Received: len(rows), Applied: len(rows)}, f.err
}

func pushCall(t *testing.T, s *Server, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func TestPushRoutes(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	// Outside managed mode there is nothing to push to.
	if rec := pushCall(t, &Server{Logger: logger}, "/private/v1/consent/withdraw", "oxp_secret",
		`{"partner_user_id":"C1"}`); rec.Code != http.StatusNotFound {
		t.Errorf("without a pusher: %d", rec.Code)
	}

	p := &fakePusher{}
	s := &Server{Logger: logger, Pusher: p}
	for _, token := range []string{"", "wrong"} {
		if rec := pushCall(t, s, "/private/v1/consent/withdraw", token, `{"partner_user_id":"C1"}`); rec.Code != http.StatusUnauthorized {
			t.Errorf("token %q: %d", token, rec.Code)
		}
	}
	if len(p.withdrawn) != 0 {
		t.Fatal("an unauthorised call reached the pusher")
	}

	if rec := pushCall(t, s, "/private/v1/consent/withdraw", "oxp_secret", `{"partner_user_id":"C1"}`); rec.Code != http.StatusOK ||
		len(p.withdrawn) != 1 || p.withdrawn[0] != "C1" {
		t.Errorf("withdraw: %d %v", rec.Code, p.withdrawn)
	}
	if rec := pushCall(t, s, "/private/v1/consent/withdraw", "oxp_secret", `not json`); rec.Code != http.StatusBadRequest {
		t.Errorf("bad body: %d", rec.Code)
	}

	// Numbers keep their written form, as the table's text would.
	rec := pushCall(t, s, "/private/v1/customers", "oxp_secret",
		`{"rows":[{"customer_id":"C1","orders_30d":5,"dob":"14/04/1992"}]}`)
	if rec.Code != http.StatusOK || p.rows[0]["orders_30d"] != "5" ||
		!strings.Contains(rec.Body.String(), `"applied":1`) {
		t.Errorf("customers: %d %s %v", rec.Code, rec.Body, p.rows)
	}

	// A refresh is running: try again later.
	p.err = &PushError{Status: http.StatusServiceUnavailable, Message: "a refresh is running"}
	rec = pushCall(t, s, "/private/v1/customers", "oxp_secret", `{"rows":[{"customer_id":"C1"}]}`)
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
		t.Errorf("busy: %d %v", rec.Code, rec.Header())
	}
}
