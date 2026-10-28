// Package netx is how the Agent reaches the network. Every connection it
// opens -- to the Partner's database, to Oolix, to a file store -- goes
// through Dial, so an Agent running in an enclave, which has no network of
// its own, can send them all through its host instead (see package enclave).
package netx

import (
	"context"
	"net"
	"net/http"
	"sync/atomic"
	"time"
)

// DialFunc opens a connection, as net.Dialer.DialContext does.
type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

var current atomic.Pointer[DialFunc]

var direct = &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}

// Dial opens a connection the way this Agent reaches the network.
func Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	if d := current.Load(); d != nil {
		return (*d)(ctx, network, addr)
	}
	return direct.DialContext(ctx, network, addr)
}

// SetDial replaces how connections are opened, for every client made before
// or after; nil restores the direct dialer.
func SetDial(f DialFunc) {
	if f == nil {
		current.Store(nil)
		return
	}
	current.Store(&f)
}

// Dialer is Dial as a value, for drivers that take one.
type Dialer struct{}

func (Dialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	return Dial(ctx, network, addr)
}

// Transport is an HTTP transport that dials through Dial.
func Transport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.DialContext = Dial
	return t
}

// Client is an HTTP client that dials through Dial.
func Client(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: Transport()}
}
