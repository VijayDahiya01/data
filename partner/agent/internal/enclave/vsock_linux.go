//go:build linux

package enclave

import (
	"context"
	"net"

	"github.com/mdlayher/vsock"
)

// HostCID is the parent instance's address as an enclave sees it.
const HostCID = 3

// ListenVsock listens on a vsock port: in the enclave for the host's
// forwards, on the host for the enclave's tunnel.
func ListenVsock(port uint32) (net.Listener, error) { return vsock.Listen(port, nil) }

// DialVsock opens a stream to a vsock address: CID 3 is the host; each
// enclave has the CID it was started with.
func DialVsock(ctx context.Context, cid, port uint32) (net.Conn, error) {
	type result struct {
		c   net.Conn
		err error
	}
	done := make(chan result, 1)
	go func() {
		c, err := vsock.Dial(cid, port, nil)
		done <- result{c, err}
	}()
	select {
	case r := <-done:
		return r.c, r.err
	case <-ctx.Done():
		go func() {
			if r := <-done; r.c != nil {
				r.c.Close()
			}
		}()
		return nil, ctx.Err()
	}
}
