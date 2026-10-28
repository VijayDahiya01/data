package controlsync

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

// The calls behind help with unread values, against a fake Oolix that answers
// the way the API does: POSTs with 201.
func TestHelpWithUnreadValues(t *testing.T) {
	var shared []map[string]any
	var asked map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("POST /agent/v1/token", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "t", "expires_in": 3600})
	})
	mux.HandleFunc("POST /agent/v1/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"latest_agent_version":"1.4.0","suggestions_available":true}`))
	})
	mux.HandleFunc("POST /agent/v1/suggestions/codes", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer t" || r.Header.Get("X-Agent-Id") != "agent-1" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&asked)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"suggestions":[{"value":"Kurtis","code":"FASHION"},{"value":"Toys","code":null}]}`))
	})
	mux.HandleFunc("PUT /agent/v1/synonyms/contributions", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Answers []map[string]any `json:"answers"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		shared = body.Answers
		_, _ = w.Write([]byte(`{"shared":1,"skipped":0}`))
	})
	mux.HandleFunc("GET /agent/v1/synonyms", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":"2.1700000000000","synonyms":[` +
			`{"attribute_key":"purchase_category","value_key":"kurtis","code":"FASHION"},` +
			`{"attribute_key":"city","value_key":"bengaluru urban","code":"BENGALURU"}]}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	var latest string
	var available bool
	s := New(Options{
		APIBaseURL: srv.URL, AgentID: "agent-1", ClientID: "client-1", PartnerOrgID: testPartner,
		PrivateKey: priv, StaleGrace: time.Hour, HTTPClient: srv.Client(), Logger: quiet(),
		OnLatestVersion: func(v string) { latest = v },
		OnSuggestions:   func(on bool) { available = on },
	})
	ctx := context.Background()

	// The heartbeat's 201 is read: the update notice and the suggestions
	// button both depend on it.
	if err := s.sendHeartbeat(ctx); err != nil {
		t.Fatal(err)
	}
	if latest != "1.4.0" || !available {
		t.Errorf("heartbeat: latest %q, suggestions %v", latest, available)
	}

	codes, err := s.SuggestCodes(ctx, "purchase_category", []string{"Kurtis", "Toys"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(codes, map[string]string{"Kurtis": "FASHION"}) {
		t.Errorf("codes: %v", codes)
	}
	if asked["attribute_key"] != "purchase_category" {
		t.Errorf("asked: %v", asked)
	}

	if err := s.ShareAnswers(ctx, []SharedAnswer{{Attribute: "purchase_category", Value: "Kurtis", Code: "FASHION"}}); err != nil {
		t.Fatal(err)
	}
	if len(shared) != 1 || shared[0]["value"] != "Kurtis" || shared[0]["attribute_key"] != "purchase_category" {
		t.Errorf("shared: %v", shared)
	}
	// Withdrawing sends an empty list, not null.
	if err := s.ShareAnswers(ctx, nil); err != nil || shared == nil || len(shared) != 0 {
		t.Errorf("withdraw: %v %v", shared, err)
	}

	version, byAttr, err := s.SharedSynonyms(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if version != "2.1700000000000" || byAttr["city"]["bengaluru urban"] != "BENGALURU" ||
		byAttr["purchase_category"]["kurtis"] != "FASHION" {
		t.Errorf("synonyms %q: %v", version, byAttr)
	}
}

// Sealed customers go to Oolix in parts the API's 1 MB bodies take, the key
// for a joint audience's result with the last.
func TestCleanRoomInputGoesInParts(t *testing.T) {
	var got []map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("POST /agent/v1/token", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "t", "expires_in": 3600})
	})
	mux.HandleFunc("PUT /agent/v1/cleanroom/tasks/run-1/parts/{n}", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		body["n"] = r.PathValue("n")
		got = append(got, body)
		_, _ = w.Write([]byte(`{}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	s := New(Options{APIBaseURL: srv.URL, AgentID: "agent-1", ClientID: "client-1", PartnerOrgID: testPartner,
		PrivateKey: priv, StaleGrace: time.Hour, HTTPClient: srv.Client(), Logger: quiet()})
	sealed := make([]byte, 2*cleanRoomPart+10)
	if err := s.SubmitCleanRoomInput(context.Background(), "run-1", sealed, []byte("recipient-key-32-bytes-long....!")); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[2]["n"] != "2" || got[0]["parts"] != float64(3) {
		t.Fatalf("parts: %d", len(got))
	}
	if _, ok := got[0]["recipient"]; ok || got[2]["recipient"] == nil {
		t.Error("the recipient key belongs with the last part only")
	}
}
