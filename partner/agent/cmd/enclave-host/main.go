// Command enclave-host runs on the parent instance beside an Agent that Oolix
// hosts in an AWS Nitro Enclave (docs/DESIGN-PARTNER-DATA.md §4). It is the
// enclave's only door: it forwards connections from the internet in, opens
// the enclave's connections out under a policy, keeps its sealed state, and
// relays the instance role's credentials -- and can read none of it. TLS
// ends inside the enclave, the state is sealed to the enclave's image, and
// the credentials open nothing without the enclave's attestation.
//
// One host process per enclave. See docs/DEPLOY-ENCLAVE.md.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/oolix/partner-agent/internal/enclave"
)

func main() {
	cid := flag.Uint("cid", 16, "the enclave's CID, as given to nitro-cli run-enclave --enclave-cid")
	port := flag.Uint("port", 8000, "the vsock port the enclave asks its host on")
	forwards := flag.String("forward", "443:443,8443:8443",
		"connections to carry in, as tcp-port:enclave-vsock-port pairs: the setup page, the private API")
	state := flag.String("state", "/var/lib/oolix-enclave/agent.sealed", "the file that keeps the sealed state")
	allow := flag.String("allow", "",
		"private networks the enclave may reach, as comma-separated CIDRs: a Partner's database behind a private link")
	hostname := flag.String("hostname", "", "the name the Partner reaches this enclave by, e.g. acme.agents.oolix.in")
	flag.Parse()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if *hostname == "" {
		logger.Error("-hostname is required")
		os.Exit(2)
	}
	if err := run(uint32(*cid), uint32(*port), *forwards, *state, *allow, *hostname, logger); err != nil {
		logger.Error("enclave host stopped", "error", err.Error())
		os.Exit(1)
	}
}

func run(cid, port uint32, forwards, state, allow, hostname string, logger *slog.Logger) error {
	policy := enclave.Policy{}
	for _, cidr := range strings.Split(allow, ",") {
		if cidr = strings.TrimSpace(cidr); cidr == "" {
			continue
		}
		p, err := netip.ParsePrefix(cidr)
		if err != nil {
			return fmt.Errorf("-allow: %w", err)
		}
		policy.Allow = append(policy.Allow, p)
	}
	host := &enclave.Host{
		Policy:      policy,
		StatePath:   state,
		Credentials: enclave.IMDSCredentials(&http.Client{Timeout: 5 * time.Second}, "http://169.254.169.254/latest"),
		Hostname:    hostname,
		Logger:      logger,
	}
	l, err := enclave.ListenVsock(port)
	if err != nil {
		return fmt.Errorf("listening for the enclave on vsock port %d: %w", port, err)
	}
	defer l.Close()
	errs := make(chan error, 8)
	go func() { errs <- host.Serve(l) }()

	for _, pair := range strings.Split(forwards, ",") {
		tcpPort, vsockPort, ok := strings.Cut(strings.TrimSpace(pair), ":")
		inner, err := strconv.ParseUint(vsockPort, 10, 32)
		if !ok || err != nil {
			return fmt.Errorf("-forward %q: want tcp-port:vsock-port", pair)
		}
		tl, err := net.Listen("tcp", ":"+tcpPort)
		if err != nil {
			return err
		}
		defer tl.Close()
		target := uint32(inner)
		go func() {
			errs <- enclave.Forward(tl, func(ctx context.Context) (net.Conn, error) {
				return enclave.DialVsock(ctx, cid, target)
			}, logger)
		}()
		logger.Info("forwarding to the enclave", "tcp", tcpPort, "cid", cid, "vsock", target)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-stop:
		return nil
	case err := <-errs:
		return err
	}
}
