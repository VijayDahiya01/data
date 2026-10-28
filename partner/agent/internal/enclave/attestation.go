// Package enclave runs the Agent inside an AWS Nitro Enclave, for Partners
// with no servers of their own (docs/DESIGN-PARTNER-DATA.md §4, phase 6).
//
// Oolix operates the machine, but the enclave has no network, no disk and no
// way in: every byte reaches it over a vsock through the host, TLS runs from
// inside it, and what it keeps outside is sealed to its own image. An
// attestation document, signed by AWS's Nitro hardware, names the image it
// runs -- so a Partner can check, rather than trust, that Oolix runs the
// published Agent and cannot read their data.
package enclave

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha512"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"crypto/x509"

	"github.com/fxamacker/cbor/v2"
)

// AWS's Nitro Enclaves root certificate (CN=aws.nitro-enclaves, valid to
// 2049), from https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip.
// Its SHA-256 fingerprint is 64:1A:03:21:A3:E2:44:EF:E4:56:46:31:95:D6:06:31:
// 7E:D7:CD:CC:3C:17:56:E0:98:93:F3:C6:8F:79:BB:5B, as AWS publishes it.
//
//go:embed nitro_root_g1.pem
var nitroRootPEM []byte

// NitroRoots is a pool holding only AWS's Nitro root.
func NitroRoots() *x509.CertPool {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(nitroRootPEM) {
		panic("enclave: the embedded Nitro root certificate does not parse")
	}
	return pool
}

// Document is an attestation document whose signature and certificate chain
// have been checked.
type Document struct {
	ModuleID  string
	Timestamp time.Time
	// PCRs are the platform configuration registers: 0 is the enclave
	// image, 1 the kernel and boot, 2 the application.
	PCRs      map[int][]byte
	PublicKey []byte
	UserData  []byte
	Nonce     []byte
}

// Measurements are the PCRs of one released enclave image, in hex, as
// nitro-cli build-enclave prints them.
type Measurements struct {
	PCR0 string `json:"PCR0"`
	PCR1 string `json:"PCR1"`
	PCR2 string `json:"PCR2"`
}

// Match reports whether a document was produced by this image.
func (m Measurements) Match(d *Document) bool {
	return m.PCR0 != "" && strings.EqualFold(hex.EncodeToString(d.PCRs[0]), m.PCR0) &&
		strings.EqualFold(hex.EncodeToString(d.PCRs[1]), m.PCR1) &&
		strings.EqualFold(hex.EncodeToString(d.PCRs[2]), m.PCR2)
}

// VerifyOptions are what a document is checked against.
type VerifyOptions struct {
	// Roots are the trusted roots; nil means AWS's Nitro root alone.
	Roots *x509.CertPool
	// Time is when the certificates must be valid; zero means now.
	Time time.Time
	// Expect are the images accepted -- any one of them. Empty accepts any
	// image, which only a test should do.
	Expect []Measurements
	// Nonce, when set, must be the document's: it proves the document is
	// fresh, made for this request.
	Nonce []byte
	// MaxAge, when set, is how old the document may be.
	MaxAge time.Duration
}

// The document as COSE_Sign1 (RFC 8152): signed by the enclave's leaf
// certificate with ECDSA P-384 and SHA-384.
type coseSign1 struct {
	_           struct{} `cbor:",toarray"`
	Protected   []byte
	Unprotected cbor.RawMessage
	Payload     []byte
	Signature   []byte
}

type payload struct {
	ModuleID    string         `cbor:"module_id"`
	Digest      string         `cbor:"digest"`
	Timestamp   uint64         `cbor:"timestamp"`
	PCRs        map[int][]byte `cbor:"pcrs"`
	Certificate []byte         `cbor:"certificate"`
	CABundle    [][]byte       `cbor:"cabundle"`
	PublicKey   []byte         `cbor:"public_key"`
	UserData    []byte         `cbor:"user_data"`
	Nonce       []byte         `cbor:"nonce"`
}

const algES384 = -35

// Verify checks an attestation document: its COSE signature, its certificate
// chain up to AWS's Nitro root, and then what opts asks -- the image, the
// nonce, the age. A document from an enclave started in debug mode is
// refused whatever opts says: its console is open to the host operator.
func Verify(raw []byte, opts VerifyOptions) (*Document, error) {
	var tag cbor.RawTag
	if cbor.Unmarshal(raw, &tag) == nil && tag.Number == 18 {
		raw = tag.Content
	}
	var msg coseSign1
	if err := cbor.Unmarshal(raw, &msg); err != nil {
		return nil, fmt.Errorf("attestation: not a COSE_Sign1 document: %w", err)
	}
	var header map[int]int
	if err := cbor.Unmarshal(msg.Protected, &header); err != nil || header[1] != algES384 {
		return nil, errors.New("attestation: not signed with ES384")
	}
	var p payload
	if err := cbor.Unmarshal(msg.Payload, &p); err != nil {
		return nil, fmt.Errorf("attestation: unreadable payload: %w", err)
	}
	if p.ModuleID == "" || p.Digest != "SHA384" || p.Timestamp == 0 || len(p.PCRs) == 0 ||
		len(p.Certificate) == 0 || len(p.CABundle) == 0 {
		return nil, errors.New("attestation: a required field is missing")
	}

	// The chain: cabundle starts at the root, then the intermediates; the
	// leaf signs the document.
	leaf, err := x509.ParseCertificate(p.Certificate)
	if err != nil {
		return nil, fmt.Errorf("attestation: leaf certificate: %w", err)
	}
	intermediates := x509.NewCertPool()
	for _, der := range p.CABundle[1:] {
		c, err := x509.ParseCertificate(der)
		if err != nil {
			return nil, fmt.Errorf("attestation: CA bundle: %w", err)
		}
		intermediates.AddCert(c)
	}
	roots := opts.Roots
	if roots == nil {
		roots = NitroRoots()
	}
	at := opts.Time
	if at.IsZero() {
		at = time.Now()
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, CurrentTime: at,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err != nil {
		return nil, fmt.Errorf("attestation: certificate chain: %w", err)
	}

	pub, ok := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok || len(msg.Signature) != 96 {
		return nil, errors.New("attestation: not an ECDSA P-384 signature")
	}
	toSign, err := cbor.Marshal([]any{"Signature1", msg.Protected, []byte{}, msg.Payload})
	if err != nil {
		return nil, err
	}
	digest := sha512.Sum384(toSign)
	r, s := new(big.Int).SetBytes(msg.Signature[:48]), new(big.Int).SetBytes(msg.Signature[48:])
	if !ecdsa.Verify(pub, digest[:], r, s) {
		return nil, errors.New("attestation: the signature does not match")
	}

	d := &Document{ModuleID: p.ModuleID, Timestamp: time.UnixMilli(int64(p.Timestamp)), PCRs: p.PCRs,
		PublicKey: p.PublicKey, UserData: p.UserData, Nonce: p.Nonce}
	if len(d.PCRs[0]) == 0 || bytes.Count(d.PCRs[0], []byte{0}) == len(d.PCRs[0]) {
		return nil, errors.New("attestation: the enclave runs in debug mode, which the host can watch")
	}
	if len(opts.Expect) > 0 {
		found := false
		for _, m := range opts.Expect {
			found = found || m.Match(d)
		}
		if !found {
			return nil, fmt.Errorf("attestation: the enclave runs an unknown image (PCR0 %s)",
				hex.EncodeToString(d.PCRs[0]))
		}
	}
	if opts.Nonce != nil && !bytes.Equal(opts.Nonce, d.Nonce) {
		return nil, errors.New("attestation: the nonce does not match: an old or replayed document")
	}
	if opts.MaxAge > 0 && at.Sub(d.Timestamp) > opts.MaxAge {
		return nil, fmt.Errorf("attestation: the document is %s old", at.Sub(d.Timestamp).Round(time.Second))
	}
	return d, nil
}
