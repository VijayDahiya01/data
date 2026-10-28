package netx

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// A client made before the dialer changes still uses the new one: the
// enclave swaps it once, early, but some clients are made at package start.
func TestClientsFollowTheDialer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	client := Client(5 * time.Second)

	var used atomic.Int32
	SetDial(func(ctx context.Context, network, addr string) (net.Conn, error) {
		used.Add(1)
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	})
	t.Cleanup(func() { SetDial(nil) })

	res, err := client.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if used.Load() != 1 {
		t.Errorf("the replaced dialer was used %d times", used.Load())
	}

	if _, err := (Dialer{}).DialContext(context.Background(), "tcp", srv.Listener.Addr().String()); err != nil {
		t.Fatal(err)
	}
	if used.Load() != 2 {
		t.Errorf("Dialer did not go through Dial")
	}
}
