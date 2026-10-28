// Command cleanroom is the cross-Partner clean room (docs/DESIGN-PARTNER-DATA.md
// §9, phase 7): it counts the customers Partners share without anyone --
// Partners or Oolix -- seeing another's. It runs in an AWS Nitro Enclave,
// reached through enclave-host like a hosted Agent; inside one it listens on
// a vsock port, and elsewhere (development) on TCP. Its requests and answers
// are sealed and signed with keys its attestation names, so the transport
// needs no TLS of its own.
package main

import (
	"errors"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/oolix/partner-agent/internal/cleanroom"
	"github.com/oolix/partner-agent/internal/enclave"
)

func main() {
	port := flag.Uint("vsock-port", 5000, "in an enclave: the vsock port to listen on")
	listen := flag.String("listen", "127.0.0.1:5000", "outside an enclave (development): the TCP address")
	flag.Parse()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	svc, err := cleanroom.NewService(enclave.Attest, logger)
	if err != nil {
		logger.Error("starting the clean room", "error", err.Error())
		os.Exit(1)
	}
	var l net.Listener
	if enclave.InEnclave() {
		l, err = enclave.ListenVsock(uint32(*port))
	} else {
		logger.Warn("not in an enclave: attestation will fail, so no Agent will send anything")
		l, err = net.Listen("tcp", *listen)
	}
	if err != nil {
		logger.Error("listening", "error", err.Error())
		os.Exit(1)
	}
	srv := &http.Server{Handler: svc.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 10 * time.Minute,
		WriteTimeout: 10 * time.Minute}
	logger.Info("clean room listening", "addr", l.Addr().String())
	if err := srv.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("clean room stopped", "error", err.Error())
		os.Exit(1)
	}
}
