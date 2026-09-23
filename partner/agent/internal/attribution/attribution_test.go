package attribution

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// The click token is what a lead is eventually attributed to -- §14, §19, §71,
// §90. Two things ride on it.
//
// It is the ONLY link between an ad that was shown and a lead that arrives
// later, so a token whose metadata never reaches Oolix is inventory the
// Partner served and can never be paid for.
//
// And it is a bearer credential. §90 makes it opaque -- 32 random bytes -- and
// keeps only its SHA-256 anywhere at rest. Storing the raw value would let
// anyone who read that store forge attributed clicks, and every one of them
// would look genuine.

type capture struct {
	mu   sync.Mutex
	body []map[string]any
	raw  []string
}

func (c *capture) add(raw string, items []map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.raw = append(c.raw, raw)
	c.body = append(c.body, items...)
}

func (c *capture) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.body)
}

func serverThat(t *testing.T, status func(n int) int) (*httptest.Server, *capture) {
	t.Helper()
	cap := &capture{}
	var calls int
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body struct {
			Tokens []map[string]any `json:"tokens"`
		}
		_ = json.Unmarshal(raw, &body)

		mu.Lock()
		calls++
		n := calls
		mu.Unlock()

		code := status(n)
		if code < 300 {
			cap.add(string(raw), body.Tokens)
		} else {
			// Still record the attempt's payload so a failed upload can be
			// inspected for leaks too.
			cap.mu.Lock()
			cap.raw = append(cap.raw, string(raw))
			cap.mu.Unlock()
		}
		w.WriteHeader(code)
	}))
	t.Cleanup(srv.Close)
	return srv, cap
}

func issuerFor(srv *httptest.Server) *Issuer {
	return NewIssuer(srv.Client(), srv.URL, "agent-1",
		func(context.Context) (string, error) { return "test-token", nil })
}

func TestATokenIsOpaqueAndUnpredictable(t *testing.T) {
	srv, _ := serverThat(t, func(int) int { return http.StatusCreated })
	i := issuerFor(srv)

	seen := map[string]bool{}
	for n := 0; n < 500; n++ {
		tok, err := i.Issue(context.Background(), "act-1", "cv-1", "slot")
		if err != nil {
			t.Fatalf("issue: %v", err)
		}
		if seen[tok] {
			t.Fatalf("token %q was issued twice", tok)
		}
		seen[tok] = true

		// §90: it encodes nothing. Anything derivable from it would leak from
		// a URL a browser puts in its history and its referrer headers.
		for _, leak := range []string{"act-1", "cv-1", "slot"} {
			if len(tok) > 0 && contains(tok, leak) {
				t.Fatalf("token %q contains %q", tok, leak)
			}
		}
		if len(tok) < 40 {
			t.Fatalf("token %q is too short to be 32 random bytes", tok)
		}
	}
}

func TestTheRawTokenIsNeverSentOrStored(t *testing.T) {
	// The whole point of hashing: whatever Oolix holds must not be usable to
	// forge a click.
	srv, cap := serverThat(t, func(int) int { return http.StatusCreated })
	i := issuerFor(srv)

	tok, err := i.Issue(context.Background(), "act-1", "cv-1", "slot")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if err := i.Flush(context.Background()); err != nil {
		t.Fatalf("flush: %v", err)
	}

	cap.mu.Lock()
	defer cap.mu.Unlock()
	for _, raw := range cap.raw {
		if contains(raw, tok) {
			t.Fatalf("the raw token was uploaded: %s", raw)
		}
	}
	if len(cap.body) != 1 {
		t.Fatalf("uploaded %d tokens; want 1", len(cap.body))
	}
	if _, ok := cap.body[0]["token_hash"]; !ok {
		t.Errorf("no token_hash in the payload: %v", cap.body[0])
	}
}

func TestAFailedFlushDoesNotLoseTokens(t *testing.T) {
	// A token whose metadata never arrives is unattributable, so the Partner
	// served inventory they can never be paid for (§14, §19).
	srv, cap := serverThat(t, func(n int) int {
		if n == 1 {
			return http.StatusInternalServerError
		}
		return http.StatusCreated
	})
	i := issuerFor(srv)

	for n := 0; n < 3; n++ {
		if _, err := i.Issue(context.Background(), "act-1", "cv-1", "slot"); err != nil {
			t.Fatalf("issue: %v", err)
		}
	}

	if err := i.Flush(context.Background()); err == nil {
		t.Fatal("expected the first flush to fail")
	}
	if i.Pending() != 3 {
		t.Fatalf("Pending()=%d after a failed flush; the tokens were lost", i.Pending())
	}

	if err := i.Flush(context.Background()); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if i.Pending() != 0 {
		t.Errorf("Pending()=%d after a successful retry", i.Pending())
	}
	if cap.count() != 3 {
		t.Errorf("delivered %d tokens; want all 3", cap.count())
	}
}

func TestTokensIssuedDuringAFailedFlushAreAlsoKept(t *testing.T) {
	// The window between draining the queue and the upload failing. A token
	// issued in it must not be dropped when the failed batch is put back.
	srv, cap := serverThat(t, func(n int) int {
		if n == 1 {
			return http.StatusBadGateway
		}
		return http.StatusCreated
	})
	i := issuerFor(srv)

	_, _ = i.Issue(context.Background(), "act-1", "cv-1", "slot")
	_ = i.Flush(context.Background()) // fails, batch goes back

	_, _ = i.Issue(context.Background(), "act-2", "cv-2", "slot")

	if i.Pending() != 2 {
		t.Fatalf("Pending()=%d; want the retried token plus the new one", i.Pending())
	}
	if err := i.Flush(context.Background()); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if cap.count() != 2 {
		t.Errorf("delivered %d tokens; want 2", cap.count())
	}
}

func TestNothingIsUploadedWhenNoTokenWasIssued(t *testing.T) {
	srv, cap := serverThat(t, func(int) int { return http.StatusCreated })
	if err := issuerFor(srv).Flush(context.Background()); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if cap.count() != 0 {
		t.Errorf("uploaded %d tokens for an empty queue", cap.count())
	}
}

func TestATokenFailureDoesNotDiscardTheQueue(t *testing.T) {
	srv, _ := serverThat(t, func(int) int { return http.StatusCreated })
	i := NewIssuer(srv.Client(), srv.URL, "agent-1",
		func(context.Context) (string, error) { return "", errors.New("token endpoint down") })

	_, _ = i.Issue(context.Background(), "act-1", "cv-1", "slot")
	if err := i.Flush(context.Background()); err == nil {
		t.Fatal("expected the flush to fail")
	}
	if i.Pending() != 1 {
		t.Errorf("Pending()=%d; the token was lost to an auth failure", i.Pending())
	}
}

func TestConcurrentIssuanceLosesNothing(t *testing.T) {
	// Ad decisions are concurrent. A lost token is unpaid delivery.
	srv, cap := serverThat(t, func(int) int { return http.StatusCreated })
	i := issuerFor(srv)

	const n = 150
	done := make(chan struct{})
	for k := 0; k < n; k++ {
		go func() {
			_, _ = i.Issue(context.Background(), "act-1", "cv-1", "slot")
			done <- struct{}{}
		}()
	}
	for k := 0; k < n; k++ {
		<-done
	}

	if i.Pending() != n {
		t.Fatalf("Pending()=%d after %d concurrent issues", i.Pending(), n)
	}
	if err := i.Flush(context.Background()); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if cap.count() != n {
		t.Errorf("delivered %d of %d tokens", cap.count(), n)
	}
}

func contains(haystack, needle string) bool {
	if needle == "" || len(needle) > len(haystack) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
