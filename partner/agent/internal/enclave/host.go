package enclave

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Host is the parent instance's side of an enclave: everything the enclave
// asks of the outside world arrives on one vsock port, one request per
// stream, named in its first line:
//
//	CONNECT host:port   open a connection, if Policy allows it
//	STATE GET           the sealed state, as "<n>" and n bytes ("0": none)
//	STATE PUT <n>       keep n bytes of sealed state
//	CREDENTIALS         the instance role's temporary credentials, as JSON
//	CONFIG              the hostname the Partner reaches the enclave by
//
// None of it gives the host the Partner's data: connections carry TLS made
// inside the enclave, the state is sealed to the enclave's image, and the
// credentials open nothing without the enclave's attestation.
type Host struct {
	Policy Policy
	// StatePath is the file holding the sealed state.
	StatePath string
	// Credentials fetches the instance role's credentials (IMDSCredentials).
	Credentials func(ctx context.Context) (Credentials, error)
	// Hostname is the name the Partner reaches this enclave by. It is the
	// one setting the host gives: a wrong one fails TLS and attestation,
	// and gives away nothing. What matters -- the sealing key, Oolix's
	// address -- is in the measured image.
	Hostname string
	Logger   *slog.Logger
	// Dial and Resolve are injectable for tests.
	Dial    func(ctx context.Context, network, addr string) (net.Conn, error)
	Resolve func(ctx context.Context, host string) ([]netip.Addr, error)
}

// Policy is what an enclave may reach. The Agent's code is published and
// measured, but the hosts it is asked to reach are typed by Partners, so the
// host refuses what would turn the Agent into a way into Oolix's own
// network: private and link-local addresses -- the cloud's metadata service
// among them -- unless allowed by name.
type Policy struct {
	// Ports may be connected to; empty means DefaultPorts.
	Ports []int
	// Allow are private networks reachable all the same: a Partner's
	// database behind a private link.
	Allow []netip.Prefix
}

// DefaultPorts are HTTPS and the databases the Agent reads.
var DefaultPorts = []int{443, 5432, 3306, 1433, 1521, 2484, 27017, 22}

var sharedSpace = netip.MustParsePrefix("100.64.0.0/10") // carrier-grade NAT, private in practice

func (p Policy) allowed(addr netip.Addr, port int) error {
	ports := p.Ports
	if len(ports) == 0 {
		ports = DefaultPorts
	}
	if !slices.Contains(ports, port) {
		return fmt.Errorf("port %d is not one the Agent uses", port)
	}
	addr = addr.Unmap()
	for _, pre := range p.Allow {
		if pre.Contains(addr) {
			return nil
		}
	}
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || sharedSpace.Contains(addr) {
		return fmt.Errorf("%s is not a public address", addr)
	}
	return nil
}

// MaxState bounds the sealed state: settings and a few keys, not data.
const MaxState = 16 << 20

// Serve answers the enclave on l until it is closed.
func (h *Host) Serve(l net.Listener) error {
	for {
		c, err := l.Accept()
		if err != nil {
			return err
		}
		go h.handle(c)
	}
}

func (h *Host) handle(c net.Conn) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(20 * time.Second))
	line, err := readLine(c)
	if err != nil {
		return
	}
	switch verb, arg, _ := strings.Cut(line, " "); {
	case verb == "CONNECT":
		h.connect(c, arg)
	case line == "STATE GET":
		data, err := os.ReadFile(h.StatePath)
		if os.IsNotExist(err) {
			data, err = nil, nil
		}
		if err != nil {
			h.warn("reading the sealed state failed", err)
			_, _ = io.WriteString(c, "ERR cannot read the state\n")
			return
		}
		_, _ = fmt.Fprintf(c, "%d\n", len(data))
		_, _ = c.Write(data)
	case verb == "STATE" && strings.HasPrefix(arg, "PUT "):
		n, err := strconv.Atoi(strings.TrimPrefix(arg, "PUT "))
		if err != nil || n <= 0 || n > MaxState {
			_, _ = io.WriteString(c, "ERR bad length\n")
			return
		}
		data := make([]byte, n)
		if _, err := io.ReadFull(c, data); err != nil {
			return
		}
		if err := writeFileAtomic(h.StatePath, data); err != nil {
			h.warn("keeping the sealed state failed", err)
			_, _ = io.WriteString(c, "ERR cannot keep the state\n")
			return
		}
		_, _ = io.WriteString(c, "OK\n")
	case line == "CONFIG":
		raw, _ := json.Marshal(map[string]string{"hostname": h.Hostname})
		_, _ = c.Write(append(raw, '\n'))
	case line == "CREDENTIALS":
		if h.Credentials == nil {
			_, _ = io.WriteString(c, "ERR no credentials on this host\n")
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		creds, err := h.Credentials(ctx)
		if err != nil {
			h.warn("fetching credentials failed", err)
			_, _ = io.WriteString(c, "ERR cannot fetch credentials\n")
			return
		}
		raw, _ := json.Marshal(creds)
		_, _ = c.Write(append(raw, '\n'))
	default:
		_, _ = io.WriteString(c, "ERR unknown request\n")
	}
}

// connect opens a connection for the enclave and joins the two.
func (h *Host) connect(c net.Conn, target string) {
	refuse := func(why string) {
		_, _ = io.WriteString(c, "ERR "+why+"\n")
		if h.Logger != nil {
			h.Logger.Warn("enclave connection refused", "to", target, "why", why)
		}
	}
	host, portText, err := net.SplitHostPort(target)
	port, perr := strconv.Atoi(portText)
	if err != nil || perr != nil {
		refuse("not host:port")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var addrs []netip.Addr
	if ip, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{ip}
	} else if addrs, err = h.resolve(ctx, host); err != nil || len(addrs) == 0 {
		refuse("cannot resolve " + host)
		return
	}
	// Every address is checked and then dialled as resolved, so a name that
	// resolves differently the second time cannot slip past the policy.
	var upstream net.Conn
	var lastErr error
	for _, a := range addrs {
		if err := h.Policy.allowed(a, port); err != nil {
			lastErr = err
			continue
		}
		if upstream, lastErr = h.dial(ctx, "tcp", netip.AddrPortFrom(a.Unmap(), uint16(port)).String()); lastErr == nil {
			break
		}
	}
	if upstream == nil {
		refuse(lastErr.Error())
		return
	}
	defer upstream.Close()
	if _, err := io.WriteString(c, "OK\n"); err != nil {
		return
	}
	_ = c.SetDeadline(time.Time{})
	pipe(c, upstream)
}

func (h *Host) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	if h.Dial != nil {
		return h.Dial(ctx, network, addr)
	}
	return (&net.Dialer{}).DialContext(ctx, network, addr)
}

func (h *Host) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if h.Resolve != nil {
		return h.Resolve(ctx, host)
	}
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

func (h *Host) warn(msg string, err error) {
	if h.Logger != nil {
		h.Logger.Warn(msg, "error", err.Error())
	}
}

func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
