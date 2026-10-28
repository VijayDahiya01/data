package enclave

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// ErrNotInEnclave is returned for what only an enclave can do.
var ErrNotInEnclave = errors.New("not running in a Nitro Enclave")

// The host carries every connection the enclave makes. The enclave opens a
// stream to the host and names the destination in one line,
//
//	CONNECT db.partner.example:5432
//
// and the host answers "OK" -- after which the stream is the connection --
// or "ERR <reason>". The host learns where the Agent connects, never what it
// says: TLS runs end to end, from inside the enclave (source.RequireVerifiedTLS).

// Tunnel is the enclave's side: a dialer for netx.SetDial.
type Tunnel struct {
	// Open opens a stream to the host: a vsock in an enclave, TCP in tests.
	Open func(ctx context.Context) (net.Conn, error)
}

// Dial opens a connection through the host. Loopback stays inside the
// enclave, where the local store runs.
func (t Tunnel) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if host == "localhost" {
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}
	if ip, err := netip.ParseAddr(host); err == nil && ip.IsLoopback() {
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}
	if !strings.HasPrefix(network, "tcp") {
		return nil, fmt.Errorf("enclave: only TCP leaves the enclave, not %s", network)
	}
	conn, err := t.Open(ctx)
	if err != nil {
		return nil, fmt.Errorf("enclave: reaching the host: %w", err)
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(30 * time.Second)
	}
	_ = conn.SetDeadline(deadline)
	if _, err := io.WriteString(conn, "CONNECT "+addr+"\n"); err != nil {
		conn.Close()
		return nil, err
	}
	reply, err := readLine(conn)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("enclave: the host did not answer: %w", err)
	}
	if reply != "OK" {
		conn.Close()
		return nil, fmt.Errorf("enclave: the host refused %s: %s", addr, strings.TrimPrefix(reply, "ERR "))
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

// readLine reads up to a newline a byte at a time, so nothing after it --
// the start of the connection itself -- is consumed.
func readLine(r io.Reader) (string, error) {
	var b strings.Builder
	one := make([]byte, 1)
	for b.Len() < 512 {
		if _, err := io.ReadFull(r, one); err != nil {
			return "", err
		}
		if one[0] == '\n' {
			return b.String(), nil
		}
		b.WriteByte(one[0])
	}
	return "", errors.New("line too long")
}

// Forward carries connections from outside to the enclave: each one accepted
// on l is joined to a new stream from open. TLS terminates inside the
// enclave, so the host carries ciphertext only.
func Forward(l net.Listener, open func(ctx context.Context) (net.Conn, error), logger *slog.Logger) error {
	for {
		c, err := l.Accept()
		if err != nil {
			return err
		}
		go func() {
			defer c.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			inner, err := open(ctx)
			cancel()
			if err != nil {
				if logger != nil {
					logger.Warn("the enclave did not take a connection", "error", err.Error())
				}
				return
			}
			defer inner.Close()
			pipe(c, inner)
		}()
	}
}

// pipe copies both ways until either side is done.
func pipe(a, b net.Conn) {
	var once sync.Once
	done := make(chan struct{})
	finish := func() { once.Do(func() { close(done) }) }
	go func() { _, _ = io.Copy(a, b); finish() }()
	go func() { _, _ = io.Copy(b, a); finish() }()
	<-done
	_ = a.Close()
	_ = b.Close()
}
