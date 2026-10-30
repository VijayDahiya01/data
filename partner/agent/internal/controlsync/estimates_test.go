package controlsync

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The API holds the estimate poll until a Buyer asks, for up to the wait the
// Agent names -- longer than every other call to Oolix may take. A poll cut
// off by the shorter timeout fails, and the Agent pauses before asking again,
// so a Buyer's estimate waited for the pause instead of arriving at once.
func TestAHeldEstimatePollIsNotCutOff(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /agent/v1/token", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "t", "expires_in": 3600})
	})
	mux.HandleFunc("GET /agent/v1/audience/estimate-requests", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("wait") != "20" {
			t.Errorf("wait %q", r.URL.Query().Get("wait"))
		}
		// Nobody asked: held, then answered with nothing.
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte(`{"items":[]}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	// Every other call gives up well before the poll is answered.
	client := srv.Client()
	client.Timeout = 100 * time.Millisecond
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	s := New(Options{
		APIBaseURL: srv.URL, AgentID: "agent-1", ClientID: "client-1", PartnerOrgID: testPartner,
		PrivateKey: priv, StaleGrace: time.Hour, HTTPClient: client, Logger: quiet(),
	})

	queue, err := s.pullEstimateRequests(context.Background(), estimateWait)
	if err != nil {
		t.Fatalf("a held poll was cut off: %v", err)
	}
	if len(queue.Items) != 0 {
		t.Errorf("items: %+v", queue.Items)
	}
	if client.Timeout != 100*time.Millisecond {
		t.Error("the poll changed the timeout every other call uses")
	}
}
