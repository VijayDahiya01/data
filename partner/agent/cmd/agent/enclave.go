package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"

	"github.com/oolix/partner-agent/internal/enclave"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/netx"
	"github.com/oolix/partner-agent/internal/source"
)

// An Agent hosted by Oolix in an AWS Nitro Enclave (docs/DESIGN-PARTNER-DATA.md
// §4), for Partners with no servers of their own. The enclave image sets
// OOLIX_ENCLAVE=1; see partner/pack/enclave for the image and the host.

func enclaveMode() bool { return os.Getenv("OOLIX_ENCLAVE") == "1" }

// The vsock ports the host forwards from the internet: the setup page on
// 443, where ACME's TLS-ALPN challenge arrives too, and the private API.
const (
	enclaveSetupPort = 443
	enclaveAPIPort   = 8443
)

type hostedEnclave struct {
	host     *enclave.HostClient
	sealer   enclave.Sealer
	certs    *autocert.Manager
	hostname string
	stateDir string
	logger   *slog.Logger
}

// startEnclave sends every connection through the host and asks for TLS
// with the certificate checked on every database connection -- before
// anything connects anywhere.
//
// The sealing key and region are in the image's environment, set when it
// is built, so they are part of what attestation measures: a host that
// could name the key could name one it may decrypt with. The hostname comes
// from the host: a wrong one only fails.
func startEnclave(ctx context.Context, stateDir string, logger *slog.Logger) (*hostedEnclave, error) {
	port := uint32(8000)
	if v := os.Getenv("OOLIX_ENCLAVE_HOST_PORT"); v != "" {
		n, err := strconv.ParseUint(v, 10, 32)
		if err != nil {
			return nil, fmt.Errorf("OOLIX_ENCLAVE_HOST_PORT: %w", err)
		}
		port = uint32(n)
	}
	host := &enclave.HostClient{Open: func(ctx context.Context) (net.Conn, error) {
		return enclave.DialVsock(ctx, enclave.HostCID, port)
	}}
	netx.SetDial(enclave.Tunnel{Open: host.Open}.Dial)
	source.RequireVerifiedTLS.Store(true)

	e := &hostedEnclave{host: host, stateDir: stateDir, logger: logger}
	keyID, region := os.Getenv("OOLIX_ENCLAVE_KMS_KEY"), os.Getenv("OOLIX_ENCLAVE_REGION")
	if keyID == "" {
		return nil, errors.New("an enclave image needs OOLIX_ENCLAVE_KMS_KEY, set when it is built")
	}
	var err error
	if e.hostname, err = host.Hostname(ctx); err != nil {
		return nil, err
	}
	if region == "" {
		region = "ap-south-1"
	}
	e.sealer = enclave.Sealer{
		KMS:    enclave.AWSKMS{Region: region, Credentials: host.Credentials, HTTP: netx.Client(30 * time.Second)},
		KeyID:  keyID,
		Attest: enclave.Attest,
	}
	// The certificate is issued to a key made here, through the host, and
	// kept in the sealed state: the host never holds the key a Partner's
	// browser and backend trust.
	e.certs = &autocert.Manager{
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist(e.hostname),
		Cache:      autocert.DirCache(filepath.Join(stateDir, "certs")),
		Client:     &acme.Client{HTTPClient: netx.Client(time.Minute)},
		Email:      os.Getenv("OOLIX_ENCLAVE_ACME_EMAIL"),
	}
	return e, nil
}

// restore writes back the files of the sealed state -- the local store's
// key first among them, so its secrets read as before -- and returns the
// store's snapshot to restore once it is open. nil on the first start.
func (e *hostedEnclave) restore(ctx context.Context) (*localstore.Snapshot, error) {
	blob, err := e.host.GetState(ctx)
	if err != nil || blob == nil {
		return nil, err
	}
	plain, err := e.sealer.Unseal(ctx, blob)
	if err != nil {
		return nil, fmt.Errorf("unsealing the saved state: %w", err)
	}
	var st enclave.State
	if err := json.Unmarshal(plain, &st); err != nil {
		return nil, err
	}
	for name, data := range st.Files {
		path := filepath.Join(e.stateDir, filepath.FromSlash(name))
		if !strings.HasPrefix(path, filepath.Clean(e.stateDir)+string(filepath.Separator)) {
			return nil, fmt.Errorf("the saved state names a file outside the state folder: %s", name)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			return nil, err
		}
	}
	var snap localstore.Snapshot
	if err := json.Unmarshal(st.Store, &snap); err != nil {
		return nil, err
	}
	e.logger.Info("restored the sealed state", "files", len(st.Files), "settings", len(snap.Settings))
	return &snap, nil
}

// files are the state folder's files, by name relative to it.
func (e *hostedEnclave) files() (map[string][]byte, error) {
	out := map[string][]byte{}
	err := filepath.WalkDir(e.stateDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(e.stateDir, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = data
		return nil
	})
	return out, err
}

// keepSealed seals the settings and the state folder whenever they change,
// and hands them to the host to keep.
func (e *hostedEnclave) keepSealed(ctx context.Context, store *localstore.Store) {
	var last [32]byte
	for {
		if err := e.sealOnce(ctx, store, &last); err != nil && ctx.Err() == nil {
			e.logger.Warn("sealing the state failed; trying again shortly", "error", err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
	}
}

func (e *hostedEnclave) sealOnce(ctx context.Context, store *localstore.Store, last *[32]byte) error {
	snap, err := store.Snapshot(ctx)
	if err != nil {
		return err
	}
	files, err := e.files()
	if err != nil {
		return err
	}
	rawStore, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	plain, err := json.Marshal(enclave.State{Files: files, Store: rawStore})
	if err != nil {
		return err
	}
	if sum := sha256.Sum256(plain); sum == *last {
		return nil
	} else {
		blob, err := e.sealer.Seal(ctx, plain)
		if err != nil {
			return err
		}
		if err := e.host.PutState(ctx, blob); err != nil {
			return err
		}
		*last = sum
	}
	return nil
}

// listen is a TLS listener on one of the enclave's vsock ports.
func (e *hostedEnclave) listen(port uint32) (net.Listener, error) {
	l, err := enclave.ListenVsock(port)
	if err != nil {
		return nil, err
	}
	return tls.NewListener(l, e.certs.TLSConfig()), nil
}

// withAttestation serves GET /.well-known/oolix-attestation?nonce=<hex>
// beside the setup page: a document from the Nitro hardware naming this
// image and binding the TLS key the page is served with. -verify-enclave
// checks it.
func (e *hostedEnclave) withAttestation(next http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", next)
	mux.HandleFunc("GET /.well-known/oolix-attestation", func(w http.ResponseWriter, r *http.Request) {
		nonce, err := hex.DecodeString(r.URL.Query().Get("nonce"))
		if err != nil || len(nonce) < 16 || len(nonce) > 64 {
			http.Error(w, "send a nonce of 16 to 64 bytes, in hex", http.StatusBadRequest)
			return
		}
		cert, err := e.certs.GetCertificate(&tls.ClientHelloInfo{ServerName: e.hostname})
		if err != nil {
			http.Error(w, "no certificate yet", http.StatusServiceUnavailable)
			return
		}
		leaf, err := x509.ParseCertificate(cert.Certificate[0])
		if err != nil {
			http.Error(w, "unreadable certificate", http.StatusInternalServerError)
			return
		}
		binding := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
		doc, err := enclave.Attest(nonce, binding[:], nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/cbor")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(doc)
	})
	return mux
}

// verifyEnclave checks an Agent hosted by Oolix the way a Partner's
// security team would: it asks for a fresh attestation document over the
// Agent's own TLS connection, checks it was signed by AWS's Nitro hardware
// for a published image, and that the TLS key it spoke to is the one the
// document names -- so the enclave, not the host, ended the connection.
func verifyEnclave(base, measurementsPath string, roots *x509.CertPool, client *http.Client) (*enclave.Document, error) {
	expect, err := readMeasurements(measurementsPath)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	var peer *x509.Certificate
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	transport, _ := client.Transport.(*http.Transport)
	if transport == nil {
		transport = http.DefaultTransport.(*http.Transport).Clone()
	} else {
		transport = transport.Clone()
	}
	if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{}
	}
	transport.TLSClientConfig.VerifyConnection = func(cs tls.ConnectionState) error {
		if len(cs.PeerCertificates) > 0 {
			peer = cs.PeerCertificates[0]
		}
		return nil
	}
	c := *client
	c.Transport = transport
	res, err := c.Get(strings.TrimRight(base, "/") + "/.well-known/oolix-attestation?nonce=" + hex.EncodeToString(nonce))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the Agent answered %d: %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	doc, err := enclave.Verify(raw, enclave.VerifyOptions{Roots: roots, Expect: expect, Nonce: nonce,
		MaxAge: 5 * time.Minute})
	if err != nil {
		return nil, err
	}
	if peer == nil {
		return nil, errors.New("no TLS certificate was seen")
	}
	if binding := sha256.Sum256(peer.RawSubjectPublicKeyInfo); string(doc.UserData) != string(binding[:]) {
		return nil, errors.New("the TLS key is not the one the enclave attests: something between you and " +
			"the enclave ended the connection")
	}
	return doc, nil
}

// readMeasurements reads a published image's PCRs: nitro-cli's output
// ({"Measurements": {...}}), one set, or a list of sets.
func readMeasurements(path string) ([]enclave.Measurements, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var wrapped struct {
		Measurements *enclave.Measurements `json:"Measurements"`
	}
	if json.Unmarshal(raw, &wrapped) == nil && wrapped.Measurements != nil && wrapped.Measurements.PCR0 != "" {
		return []enclave.Measurements{*wrapped.Measurements}, nil
	}
	var one enclave.Measurements
	if json.Unmarshal(raw, &one) == nil && one.PCR0 != "" {
		return []enclave.Measurements{one}, nil
	}
	var list []enclave.Measurements
	if err := json.Unmarshal(raw, &list); err != nil || len(list) == 0 || list[0].PCR0 == "" {
		return nil, fmt.Errorf("%s holds no PCR0, PCR1 and PCR2", path)
	}
	return list, nil
}
