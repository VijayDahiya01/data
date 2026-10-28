//go:build !linux

package enclave

import (
	"context"
	"net"
)

// HostCID is the parent instance's address as an enclave sees it.
const HostCID = 3

// ListenVsock needs Linux.
func ListenVsock(port uint32) (net.Listener, error) { return nil, ErrNotInEnclave }

// DialVsock needs Linux.
func DialVsock(ctx context.Context, cid, port uint32) (net.Conn, error) { return nil, ErrNotInEnclave }
