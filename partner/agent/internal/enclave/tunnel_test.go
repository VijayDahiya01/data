package enclave

import (
	"context"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"testing"
)

func listen(t *testing.T) net.Listener {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	return l
}

// echo answers every connection with what it is sent.
func echo(t *testing.T) (net.Listener, int) {
	l := listen(t)
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	return l, l.Addr().(*net.TCPAddr).Port
}

func roundTrip(t *testing.T, c net.Conn) {
	t.Helper()
	defer c.Close()
	if _, err := c.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "hello" {
		t.Fatalf("got %q %v", buf, err)
	}
}

// The enclave reaches a database through its host, which resolves the name
// and checks the address -- and refuses Oolix's own network.
func TestTheEnclaveReachesOutOnlyThroughThePolicy(t *testing.T) {
	_, dbPort := echo(t)
	names := map[string]string{"db.partner.test": "127.0.0.1", "metadata.test": "169.254.169.254",
		"internal.test": "10.0.3.7"}
	host := listen(t)
	eg := &Host{
		Policy: Policy{Ports: []int{dbPort, 443}, Allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}},
		Resolve: func(ctx context.Context, name string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr(names[name])}, nil
		},
	}
	go eg.Serve(host)
	tunnel := Tunnel{Open: func(ctx context.Context) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", host.Addr().String())
	}}
	ctx := context.Background()

	c, err := tunnel.Dial(ctx, "tcp", "db.partner.test:"+strconv.Itoa(dbPort))
	if err != nil {
		t.Fatal(err)
	}
	roundTrip(t, c)

	for addr, want := range map[string]string{
		"metadata.test:443":                "not a public address",
		"internal.test:443":                "not a public address",
		"db.partner.test:6379":             "port 6379",
		"[::1]:443":                        "", // loopback stays inside: dialled directly, and nothing listens
		"10.0.3.7:" + strconv.Itoa(dbPort): "not a public address",
	} {
		_, err := tunnel.Dial(ctx, "tcp", addr)
		if err == nil || (want != "" && !strings.Contains(err.Error(), want)) {
			t.Errorf("%s: got %v, want an error about %q", addr, err, want)
		}
	}
}

func TestThePolicy(t *testing.T) {
	p := Policy{}
	for addr, ok := range map[string]bool{
		"8.8.8.8": true, "2001:4860:4860::8888": true,
		"10.1.2.3": false, "172.16.0.1": false, "192.168.1.1": false, "169.254.169.254": false,
		"100.64.1.1": false, "127.0.0.1": false, "::1": false, "fd00::1": false, "0.0.0.0": false,
		"::ffff:10.1.2.3": false,
	} {
		if err := p.allowed(netip.MustParseAddr(addr), 5432); (err == nil) != ok {
			t.Errorf("%s: allowed %v, want %v (%v)", addr, err == nil, ok, err)
		}
	}
	if p.allowed(netip.MustParseAddr("8.8.8.8"), 25) == nil {
		t.Error("port 25 allowed")
	}
	withLink := Policy{Allow: []netip.Prefix{netip.MustParsePrefix("10.20.0.0/16")}}
	if err := withLink.allowed(netip.MustParseAddr("10.20.1.5"), 5432); err != nil {
		t.Errorf("an allowed private link: %v", err)
	}
}

// Inbound: a connection to the host reaches the enclave.
func TestForwardReachesTheEnclave(t *testing.T) {
	inner, _ := echo(t)
	outer := listen(t)
	go Forward(outer, func(ctx context.Context) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", inner.Addr().String())
	}, nil)
	c, err := net.Dial("tcp", outer.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	roundTrip(t, c)
}
