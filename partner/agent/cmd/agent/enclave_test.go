package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oolix/partner-agent/internal/enclave/enclavetest"
)

// -verify-enclave is what a Partner's security team runs against the Agent
// Oolix hosts for them: it must pass for the published image with TLS ending
// in the enclave, and fail otherwise.
func TestVerifyEnclave(t *testing.T) {
	nitro := enclavetest.NewNitro(t)
	published := enclavetest.Image(7)
	measurements := filepath.Join(t.TempDir(), "enclave-measurements.json")
	// The form nitro-cli build-enclave prints.
	if err := os.WriteFile(measurements, []byte(`{"Measurements": {"HashAlgorithm": "Sha384 { ... }", "PCR0": "`+
		hex.EncodeToString(published[0])+`", "PCR1": "`+hex.EncodeToString(published[1])+`", "PCR2": "`+
		hex.EncodeToString(published[2])+`"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	serve := func(pcrs map[int][]byte, bindOtherKey bool) *httptest.Server {
		var srv *httptest.Server
		srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nonce, _ := hex.DecodeString(r.URL.Query().Get("nonce"))
			binding := sha256.Sum256(srv.Certificate().RawSubjectPublicKeyInfo)
			if bindOtherKey {
				binding = sha256.Sum256([]byte("the enclave's own key, which a host in the middle does not have"))
			}
			_, _ = w.Write(nitro.Document(t, enclavetest.Doc{PCRs: pcrs, Nonce: nonce, UserData: binding[:]}))
		}))
		t.Cleanup(srv.Close)
		return srv
	}

	good := serve(published, false)
	if doc, err := verifyEnclave(good.URL, measurements, nitro.Roots, good.Client()); err != nil {
		t.Fatalf("the published image did not verify: %v", err)
	} else if doc.PCRs[0][0] != 7 {
		t.Errorf("document: %+v", doc)
	}

	for name, c := range map[string]struct {
		srv  *httptest.Server
		want string
	}{
		"TLS ended by the host": {serve(published, true), "TLS key"},
		"another image":         {serve(enclavetest.Image(9), false), "unknown image"},
	} {
		if _, err := verifyEnclave(c.srv.URL, measurements, nitro.Roots, c.srv.Client()); err == nil ||
			!strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want an error about %q", name, err, c.want)
		}
	}
}
