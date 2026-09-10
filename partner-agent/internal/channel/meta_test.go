package channel

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// capture records every request a test server receives, so assertions can be
// made about what actually went over the wire rather than what we intended.
type capture struct {
	method string
	path   string
	form   url.Values
	body   string
}

func metaServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request, c capture)) (*httptest.Server, *[]capture) {
	t.Helper()
	var seen []capture
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(raw))
		c := capture{method: r.Method, path: r.URL.Path, form: form, body: string(raw)}
		seen = append(seen, c)
		handler(w, r, c)
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

func metaAdapter(t *testing.T, baseURL string) *MetaAdapter {
	t.Helper()
	a, err := NewMetaAdapter(MetaConfig{
		AccessToken: "SECRET-TOKEN-VALUE",
		AdAccountID: "1234567890",
		BusinessID:  "biz-1",
		BaseURL:     baseURL,
	}, quietLogger())
	if err != nil {
		t.Fatalf("adapter: %v", err)
	}
	return a
}

func TestMetaRefusesToBuildWithoutCredentials(t *testing.T) {
	// A misconfigured adapter must fail at construction, not silently upload
	// to the wrong account or send an unauthenticated request.
	if _, err := NewMetaAdapter(MetaConfig{AdAccountID: "1"}, quietLogger()); err == nil {
		t.Error("expected a refusal when the access token is missing")
	}
	if _, err := NewMetaAdapter(MetaConfig{AccessToken: "t"}, quietLogger()); err == nil {
		t.Error("expected a refusal when the ad account is missing")
	}
}

func TestMetaCreatesThenUploads(t *testing.T) {
	srv, seen := metaServer(t, func(w http.ResponseWriter, r *http.Request, c capture) {
		if strings.HasSuffix(c.path, "/customaudiences") {
			fmt.Fprint(w, `{"id":"aud-99"}`)
			return
		}
		fmt.Fprint(w, `{"audience_id":"aud-99","num_received":1}`)
	})

	res, err := metaAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		AudienceName: "Campaign 7 - Partner A",
		Members:      []Member{{Email: "Person@Example.com"}},
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.ResourceID != "aud-99" || res.Accepted != 1 {
		t.Errorf("result = %+v; want aud-99 with 1 accepted", res)
	}

	if len(*seen) != 2 {
		t.Fatalf("expected create then upload, got %d requests", len(*seen))
	}
	if !strings.HasSuffix((*seen)[0].path, "/customaudiences") {
		t.Errorf("first call was %s, expected audience creation", (*seen)[0].path)
	}
	// §15: the data came from the Partner, not the advertiser's own customers.
	// Declaring otherwise is a terms violation, not a cosmetic field.
	if got := (*seen)[0].form.Get("customer_file_source"); got != "PARTNER_PROVIDED_ONLY" {
		t.Errorf("customer_file_source = %q; want PARTNER_PROVIDED_ONLY", got)
	}
}

func TestMetaReusesAnExistingAudience(t *testing.T) {
	// A refresh must not create a second audience: the ad set points at the
	// first one, so a new id would leave the campaign targeting a stale list.
	srv, seen := metaServer(t, func(w http.ResponseWriter, r *http.Request, c capture) {
		fmt.Fprint(w, `{"audience_id":"aud-1","num_received":1}`)
	})

	_, err := metaAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		ExistingResourceID: "aud-1",
		Members:            []Member{{Email: "a@example.com"}},
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	for _, c := range *seen {
		if strings.HasSuffix(c.path, "/customaudiences") {
			t.Error("a refresh created a new audience instead of reusing the existing id")
		}
	}
}

// The test this whole package exists to pass.
func TestMetaNeverSendsARawIdentifier(t *testing.T) {
	raw := Member{
		Email:     "Person@Example.com",
		Phone:     "+1 (555) 010-2030",
		FirstName: "Ada",
		LastName:  "Lovelace",
		Country:   "GB",
		Zip:       "SW1A 1AA",
		MobileID:  "6D92078A-8246-4BA4-AE5B-76104861E7DC",
	}

	srv, seen := metaServer(t, func(w http.ResponseWriter, r *http.Request, c capture) {
		if strings.HasSuffix(c.path, "/customaudiences") {
			fmt.Fprint(w, `{"id":"aud-1"}`)
			return
		}
		fmt.Fprint(w, `{"num_received":1}`)
	})

	if _, err := metaAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		AudienceName: "test", Members: []Member{raw},
	}); err != nil {
		t.Fatalf("sync: %v", err)
	}

	// Everything that identifies a person, in the forms it could leak in.
	forbidden := []string{
		"Person@Example.com", "person@example.com",
		"5550102030", "Ada", "ada", "Lovelace", "lovelace",
		"SW1A", "sw1a1aa",
	}
	for _, c := range *seen {
		decoded, _ := url.QueryUnescape(c.body)
		haystack := c.body + " " + decoded
		for _, f := range forbidden {
			if strings.Contains(haystack, f) {
				t.Errorf("request to %s carried the raw value %q", c.path, f)
			}
		}
	}

	// And the hashes that should be there instead.
	upload := (*seen)[len(*seen)-1]
	payload := upload.form.Get("payload")
	wantEmail, _ := NormalizeAndHash(ProviderMeta, KindEmail, raw.Email)
	if !strings.Contains(payload, wantEmail) {
		t.Error("the upload did not contain the hashed email")
	}
	// The advertising id is the documented exception: sent as-is, because a
	// hashed one matches nothing.
	if !strings.Contains(strings.ToLower(payload), strings.ToLower(raw.MobileID)) {
		t.Error("the advertising id should be sent unhashed")
	}
}

func TestMetaBatchesAboveTheRequestCap(t *testing.T) {
	// Exceeding the cap fails the whole request rather than truncating, so an
	// unbatched large audience uploads nothing at all.
	members := make([]Member, metaMaxUsersPerRequest+250)
	for i := range members {
		members[i] = Member{Email: fmt.Sprintf("user%d@example.com", i)}
	}

	srv, seen := metaServer(t, func(w http.ResponseWriter, r *http.Request, c capture) {
		if strings.HasSuffix(c.path, "/customaudiences") {
			fmt.Fprint(w, `{"id":"aud-1"}`)
			return
		}
		fmt.Fprint(w, `{"num_received":1}`)
	})

	res, err := metaAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		AudienceName: "big", Members: members,
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Accepted != len(members) {
		t.Errorf("accepted %d; want %d", res.Accepted, len(members))
	}

	uploads := 0
	for _, c := range *seen {
		if strings.HasSuffix(c.path, "/users") {
			uploads++
			var p struct {
				Data [][]string `json:"data"`
			}
			_ = json.Unmarshal([]byte(c.form.Get("payload")), &p)
			if len(p.Data) > metaMaxUsersPerRequest {
				t.Errorf("a request carried %d rows, over the %d cap", len(p.Data), metaMaxUsersPerRequest)
			}
		}
	}
	if uploads != 2 {
		t.Errorf("expected 2 upload requests for %d members, got %d", len(members), uploads)
	}
}

func TestMetaSkipsUnusableMembersRatherThanPaddingWithEmptyHashes(t *testing.T) {
	srv, seen := metaServer(t, func(w http.ResponseWriter, r *http.Request, c capture) {
		if strings.HasSuffix(c.path, "/customaudiences") {
			fmt.Fprint(w, `{"id":"aud-1"}`)
			return
		}
		fmt.Fprint(w, `{"num_received":1}`)
	})

	res, err := metaAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		AudienceName: "mixed",
		Members: []Member{
			{Email: "good@example.com"},
			{Email: "not-an-address", Phone: "123"}, // nothing usable
			{},                                      // entirely empty
		},
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Accepted != 1 || res.Skipped != 2 {
		t.Errorf("accepted=%d skipped=%d; want 1 and 2", res.Accepted, res.Skipped)
	}

	// A row of empty hashes matches nobody while inflating the count, which is
	// how a broken attribute mapping passes for a working upload.
	upload := (*seen)[len(*seen)-1]
	var p struct {
		Data [][]string `json:"data"`
	}
	_ = json.Unmarshal([]byte(upload.form.Get("payload")), &p)
	if len(p.Data) != 1 {
		t.Fatalf("uploaded %d rows; want 1", len(p.Data))
	}
}

func TestMetaFailsLoudlyWhenNothingIsUsable(t *testing.T) {
	// Reporting success on an empty upload leaves an empty audience that looks
	// exactly like a working one until the delivery numbers arrive.
	srv, _ := metaServer(t, func(w http.ResponseWriter, r *http.Request, c capture) {
		fmt.Fprint(w, `{"id":"aud-1"}`)
	})

	_, err := metaAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		AudienceName: "empty",
		Members:      []Member{{Email: "nope"}, {}},
	})
	if err == nil {
		t.Fatal("expected an error when no member produced a usable identifier")
	}
	if !strings.Contains(err.Error(), "attribute mapping") {
		t.Errorf("error should point at the likely cause; got %q", err)
	}
}

func TestMetaDistinguishesRetryableFailures(t *testing.T) {
	for _, tc := range []struct {
		status    int
		retryable bool
	}{
		{http.StatusTooManyRequests, true},
		{http.StatusBadGateway, true},
		{http.StatusServiceUnavailable, true},
		// A 4xx is a definite answer. Retrying it hammers a platform that has
		// already said no.
		{http.StatusBadRequest, false},
		{http.StatusForbidden, false},
	} {
		srv, _ := metaServer(t, func(w http.ResponseWriter, r *http.Request, c capture) {
			w.WriteHeader(tc.status)
			fmt.Fprint(w, `{"error":{"message":"nope","type":"OAuthException","code":190}}`)
		})

		_, err := metaAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
			AudienceName: "x", Members: []Member{{Email: "a@example.com"}},
		})
		if err == nil {
			t.Fatalf("status %d: expected an error", tc.status)
		}
		if IsRetryable(err) != tc.retryable {
			t.Errorf("status %d: retryable=%v; want %v", tc.status, IsRetryable(err), tc.retryable)
		}
	}
}

func TestMetaErrorsNeverCarryTheAccessToken(t *testing.T) {
	// Meta echoes request parameters on some endpoints, and the request
	// carries the token. An error that quotes the body wholesale puts a
	// long-lived credential into logs.
	srv, _ := metaServer(t, func(w http.ResponseWriter, r *http.Request, c capture) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintf(w, `{"error":{"message":"bad","type":"X","code":1},"echo":%q}`, c.body)
	})

	_, err := metaAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		AudienceName: "x", Members: []Member{{Email: "a@example.com"}},
	})
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "SECRET-TOKEN-VALUE") {
		t.Errorf("the access token reached the error message: %q", err)
	}
}

func TestMetaRemoveClearsMembershipRatherThanDeletingTheAudience(t *testing.T) {
	// A Custom Audience referenced by a live ad set cannot be deleted, and
	// attempting it fails in a way that leaves the members in place.
	srv, seen := metaServer(t, func(w http.ResponseWriter, r *http.Request, c capture) {
		fmt.Fprint(w, `{"success":true}`)
	})

	if err := metaAdapter(t, srv.URL).Remove(context.Background(), "aud-1"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if len(*seen) != 1 {
		t.Fatalf("expected one request, got %d", len(*seen))
	}
	got := (*seen)[0]
	if got.method != http.MethodDelete {
		t.Errorf("method = %s; want DELETE", got.method)
	}
	if !strings.HasSuffix(got.path, "/users") {
		t.Errorf("path = %s; want the /users edge, not the audience itself", got.path)
	}
}
