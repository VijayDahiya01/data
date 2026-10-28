// Package enclavetest stands in for AWS's Nitro hardware in tests: a root,
// an intermediate and a leaf certificate, all P-384 as AWS's are, and
// attestation documents signed the way the Nitro Secure Module signs them.
package enclavetest

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha512"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
)

// Nitro is a fake Nitro PKI.
type Nitro struct {
	// Roots trusts this fake's root, in place of AWS's.
	Roots                      *x509.CertPool
	rootDER, interDER, leafDER []byte
	leafKey                    *ecdsa.PrivateKey
}

// NewNitro makes certificates valid from an hour ago for three hours, as a
// Nitro leaf certificate is short-lived.
func NewNitro(t testing.TB) *Nitro {
	t.Helper()
	now := time.Now()
	issue := func(cn string, parent *x509.Certificate, parentKey *ecdsa.PrivateKey, ca bool) (*x509.Certificate, []byte, *ecdsa.PrivateKey) {
		key, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		tmpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: cn},
			NotBefore: now.Add(-time.Hour), NotAfter: now.Add(3 * time.Hour), IsCA: ca, BasicConstraintsValid: true,
			KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign}
		if parent == nil {
			parent, parentKey = tmpl, key
		}
		der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, &key.PublicKey, parentKey)
		if err != nil {
			t.Fatal(err)
		}
		cert, _ := x509.ParseCertificate(der)
		return cert, der, key
	}
	root, rootDER, rootKey := issue("fake.nitro-enclaves", nil, nil, true)
	inter, interDER, interKey := issue("fake.zonal", root, rootKey, true)
	_, leafDER, leafKey := issue("fake.enclave", inter, interKey, false)
	n := &Nitro{Roots: x509.NewCertPool(), rootDER: rootDER, interDER: interDER, leafDER: leafDER, leafKey: leafKey}
	n.Roots.AddCert(root)
	return n
}

// Doc is what a document carries.
type Doc struct {
	PCRs                       map[int][]byte
	Nonce, UserData, PublicKey []byte
	// At is when it was made; zero means now.
	At time.Time
	// Tagged wraps it in CBOR tag 18, as COSE allows.
	Tagged bool
	// Tamper changes PCR0 after signing, as a host passing off another
	// image would.
	Tamper bool
}

// Image is a set of PCRs, all bytes b, b+1 and b+2: Image(0) is debug mode.
func Image(b byte) map[int][]byte {
	return map[int][]byte{0: bytes.Repeat([]byte{b}, 48), 1: bytes.Repeat([]byte{b + 1}, 48),
		2: bytes.Repeat([]byte{b + 2}, 48), 3: make([]byte, 48)}
}

// Document signs an attestation document.
func (n *Nitro) Document(t testing.TB, d Doc) []byte {
	t.Helper()
	if d.At.IsZero() {
		d.At = time.Now()
	}
	enc := func(v any) []byte {
		b, err := cbor.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	body := func() []byte {
		return enc(map[string]any{
			"module_id": "i-0123456789abcdef0-enc0123456789abcd", "digest": "SHA384",
			"timestamp": uint64(d.At.UnixMilli()), "pcrs": d.PCRs, "certificate": n.leafDER,
			"cabundle": [][]byte{n.rootDER, n.interDER}, "public_key": d.PublicKey, "user_data": d.UserData,
			"nonce": d.Nonce,
		})
	}
	payload := body()
	protected := enc(map[int]int{1: -35}) // ES384
	digest := sha512.Sum384(enc([]any{"Signature1", protected, []byte{}, payload}))
	r, s, err := ecdsa.Sign(rand.Reader, n.leafKey, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig := make([]byte, 96)
	r.FillBytes(sig[:48])
	s.FillBytes(sig[48:])
	if d.Tamper {
		d.PCRs[0] = bytes.Repeat([]byte{0x42}, 48)
		payload = body()
	}
	msg := []any{protected, map[int]any{}, payload, sig}
	if d.Tagged {
		return enc(cbor.Tag{Number: 18, Content: msg})
	}
	return enc(msg)
}
