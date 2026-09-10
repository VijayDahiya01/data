package channel

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type gCapture struct {
	path   string
	body   string
	auth   string
	header http.Header
}

func googleServer(t *testing.T, status int, response string) (*httptest.Server, *[]gCapture) {
	t.Helper()
	var seen []gCapture
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		seen = append(seen, gCapture{
			path:   r.URL.Path,
			body:   string(raw),
			auth:   r.Header.Get("Authorization"),
			header: r.Header.Clone(),
		})
		w.WriteHeader(status)
		fmt.Fprint(w, response)
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

func googleAdapter(t *testing.T, baseURL string) *GoogleAdapter {
	t.Helper()
	a, err := NewGoogleAdapter(GoogleConfig{
		AccessToken:          "GOOGLE-SECRET-TOKEN",
		OperatingAccountID:   "111-222-3333",
		LoginAccountID:       "999-888-7777",
		ProductDestinationID: "userlist-42",
		BaseURL:              baseURL,
	}, quietLogger())
	if err != nil {
		t.Fatalf("adapter: %v", err)
	}
	return a
}

func TestGoogleRefusesToBuildWithoutCredentials(t *testing.T) {
	if _, err := NewGoogleAdapter(GoogleConfig{OperatingAccountID: "1"}, quietLogger()); err == nil {
		t.Error("expected a refusal without an access token")
	}
	if _, err := NewGoogleAdapter(GoogleConfig{AccessToken: "t"}, quietLogger()); err == nil {
		t.Error("expected a refusal without an operating account")
	}
}

// The compliance test. Consent must come from the Partner, never from a
// default in our own code.
func TestGoogleRefusesToUploadWithoutExplicitConsent(t *testing.T) {
	srv, seen := googleServer(t, http.StatusOK, `{}`)

	for _, consent := range []ConsentState{ConsentUnspecified, ConsentDenied} {
		_, err := googleAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
			Members: []Member{{Email: "a@example.com"}},
			Consent: consent,
		})
		if err == nil {
			t.Errorf("consent %q: expected a refusal", consent)
		}
	}

	if len(*seen) != 0 {
		t.Errorf("a request was sent despite absent consent: %d requests", len(*seen))
	}
}

func TestGoogleUsesTheDataManagerIngestEndpoint(t *testing.T) {
	// §48.2: the Data Manager API, not the old Ads API path.
	srv, seen := googleServer(t, http.StatusOK, `{}`)

	res, err := googleAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		Members: []Member{{Email: "a@example.com"}},
		Consent: ConsentGranted,
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.ResourceID != "userlist-42" || res.Accepted != 1 {
		t.Errorf("result = %+v", res)
	}

	got := (*seen)[0]
	if got.path != "/v1/audienceMembers:ingest" {
		t.Errorf("path = %s; want /v1/audienceMembers:ingest", got.path)
	}
	if got.auth != "Bearer GOOGLE-SECRET-TOKEN" {
		t.Errorf("authorization header = %q", got.auth)
	}
	// The manager account has to be named in the header as well as the body,
	// or the call is attributed to the wrong account and 403s.
	if got.header.Get("login-customer-id") != "999-888-7777" {
		t.Errorf("login-customer-id header = %q", got.header.Get("login-customer-id"))
	}
}

func TestGoogleSendsTheAccountPathAndEncoding(t *testing.T) {
	srv, seen := googleServer(t, http.StatusOK, `{}`)

	_, err := googleAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		Members: []Member{{Email: "a@example.com"}},
		Consent: ConsentGranted,
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}

	var req gIngestRequest
	if err := json.Unmarshal([]byte((*seen)[0].body), &req); err != nil {
		t.Fatalf("request was not valid JSON: %v", err)
	}

	if len(req.Destinations) != 1 {
		t.Fatalf("destinations = %d; want 1", len(req.Destinations))
	}
	d := req.Destinations[0]
	if d.OperatingAccount.AccountID != "111-222-3333" {
		t.Errorf("operating account = %q", d.OperatingAccount.AccountID)
	}
	if d.LoginAccount == nil || d.LoginAccount.AccountID != "999-888-7777" {
		t.Errorf("login account not carried: %+v", d.LoginAccount)
	}
	if d.ProductDestinationID != "userlist-42" {
		t.Errorf("destination id = %q", d.ProductDestinationID)
	}
	// Declaring the wrong encoding does not error; it just matches nobody.
	if req.Encoding != "HEX" {
		t.Errorf("encoding = %q; want HEX to match the hex digests we send", req.Encoding)
	}
	if req.Consent.AdUserData != "CONSENT_GRANTED" {
		t.Errorf("consent = %+v", req.Consent)
	}
	if req.TermsOfService.CustomerMatchTermsOfServiceStatus != "ACCEPTED" {
		t.Error("customer match terms of service must be declared accepted")
	}
}

func TestGoogleNeverSendsARawIdentifier(t *testing.T) {
	srv, seen := googleServer(t, http.StatusOK, `{}`)

	_, err := googleAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		Consent: ConsentGranted,
		Members: []Member{{
			Email:     "Person@Example.com",
			Phone:     "+1 (555) 010-2030",
			FirstName: "Ada",
			LastName:  "Lovelace",
			Country:   "GB",
			Zip:       "SW1A 1AA",
		}},
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}

	body := (*seen)[0].body
	for _, forbidden := range []string{
		"Person@Example.com", "person@example.com",
		"5550102030", "Ada", "Lovelace", "lovelace",
	} {
		if strings.Contains(body, forbidden) {
			t.Errorf("request carried the raw value %q", forbidden)
		}
	}

	wantEmail, _ := NormalizeAndHash(ProviderGoogle, KindEmail, "Person@Example.com")
	if !strings.Contains(body, wantEmail) {
		t.Error("the hashed email was not present")
	}
}

func TestGoogleSendsAddressOnlyAsACompleteSet(t *testing.T) {
	// Google matches on the combination. A partial address contributes nothing
	// while still enlarging the request.
	srv, seen := googleServer(t, http.StatusOK, `{}`)

	_, err := googleAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		Consent: ConsentGranted,
		Members: []Member{{
			Email:     "a@example.com",
			FirstName: "Ada",
			// No last name, country or postcode.
		}},
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}

	var req gIngestRequest
	_ = json.Unmarshal([]byte((*seen)[0].body), &req)
	for _, id := range req.AudienceMembers[0].UserData.UserIdentifiers {
		if id.Address != nil {
			t.Errorf("a partial address was sent: %+v", id.Address)
		}
	}
}

func TestGoogleKeepsRegionAndPostcodeInTheClear(t *testing.T) {
	// Name parts are hashed; region and postal code are matched in the clear.
	// Hashing them produces a value that matches nothing.
	srv, seen := googleServer(t, http.StatusOK, `{}`)

	_, err := googleAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		Consent: ConsentGranted,
		Members: []Member{{
			FirstName: "Ada", LastName: "Lovelace", Country: "gb", Zip: "SW1A 1AA",
		}},
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}

	var req gIngestRequest
	_ = json.Unmarshal([]byte((*seen)[0].body), &req)

	var addr *gAddress
	for _, id := range req.AudienceMembers[0].UserData.UserIdentifiers {
		if id.Address != nil {
			addr = id.Address
		}
	}
	if addr == nil {
		t.Fatal("expected a complete address identifier")
	}
	if addr.RegionCode != "GB" {
		t.Errorf("region = %q; want the uppercase code in the clear", addr.RegionCode)
	}
	if addr.PostalCode != "sw1a1aa" {
		t.Errorf("postcode = %q; want it in the clear", addr.PostalCode)
	}
	if len(addr.GivenName) != 64 {
		t.Errorf("given name should be a hex digest, got %q", addr.GivenName)
	}
}

func TestGoogleBatchesLargeAudiences(t *testing.T) {
	members := make([]Member, googleMaxMembersPerRequest+10)
	for i := range members {
		members[i] = Member{Email: fmt.Sprintf("u%d@example.com", i)}
	}

	srv, seen := googleServer(t, http.StatusOK, `{}`)
	res, err := googleAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		Members: members, Consent: ConsentGranted,
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Accepted != len(members) {
		t.Errorf("accepted %d; want %d", res.Accepted, len(members))
	}
	if len(*seen) != 2 {
		t.Errorf("expected 2 batched requests, got %d", len(*seen))
	}
}

func TestGoogleDistinguishesRetryableFailures(t *testing.T) {
	for _, tc := range []struct {
		status    int
		retryable bool
	}{
		{http.StatusTooManyRequests, true},
		{http.StatusInternalServerError, true},
		{http.StatusBadRequest, false},
		{http.StatusForbidden, false},
	} {
		srv, _ := googleServer(t, tc.status,
			`{"error":{"code":7,"message":"denied","status":"PERMISSION_DENIED"}}`)

		_, err := googleAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
			Members: []Member{{Email: "a@example.com"}}, Consent: ConsentGranted,
		})
		if err == nil {
			t.Fatalf("status %d: expected an error", tc.status)
		}
		if IsRetryable(err) != tc.retryable {
			t.Errorf("status %d: retryable=%v; want %v", tc.status, IsRetryable(err), tc.retryable)
		}
	}
}

func TestGoogleErrorsNeverCarryTheAccessToken(t *testing.T) {
	srv, _ := googleServer(t, http.StatusForbidden,
		`{"error":{"code":7,"message":"denied","status":"PERMISSION_DENIED"}}`)

	_, err := googleAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		Members: []Member{{Email: "a@example.com"}}, Consent: ConsentGranted,
	})
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "GOOGLE-SECRET-TOKEN") {
		t.Errorf("the token reached the error message: %q", err)
	}
}

func TestGoogleRemoveUsesTheRemoveEndpoint(t *testing.T) {
	srv, seen := googleServer(t, http.StatusOK, `{}`)

	if err := googleAdapter(t, srv.URL).Remove(context.Background(), "userlist-42"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if (*seen)[0].path != "/v1/audienceMembers:remove" {
		t.Errorf("path = %s; want the remove endpoint", (*seen)[0].path)
	}
}

func TestGoogleFailsLoudlyWhenNothingIsUsable(t *testing.T) {
	srv, seen := googleServer(t, http.StatusOK, `{}`)

	_, err := googleAdapter(t, srv.URL).Sync(context.Background(), SyncRequest{
		Members: []Member{{Email: "nope"}, {}}, Consent: ConsentGranted,
	})
	if err == nil {
		t.Fatal("expected an error when nothing was usable")
	}
	if len(*seen) != 0 {
		t.Error("an empty upload was still sent")
	}
}
