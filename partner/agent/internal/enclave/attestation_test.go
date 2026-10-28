package enclave

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/pem"
	"strings"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/enclave/enclavetest"
)

var image = enclavetest.Image

func measurementsOf(pcrs map[int][]byte) Measurements {
	return Measurements{PCR0: hex.EncodeToString(pcrs[0]), PCR1: hex.EncodeToString(pcrs[1]),
		PCR2: hex.EncodeToString(pcrs[2])}
}

func TestAVerifiedDocumentNamesTheImage(t *testing.T) {
	f := enclavetest.NewNitro(t)
	pcrs := image(7)
	nonce := []byte("a fresh nonce")
	for _, tagged := range []bool{false, true} {
		raw := f.Document(t, enclavetest.Doc{PCRs: pcrs, Nonce: nonce, UserData: []byte("tls key hash"), Tagged: tagged})
		d, err := Verify(raw, VerifyOptions{Roots: f.Roots, Expect: []Measurements{measurementsOf(pcrs)},
			Nonce: nonce, MaxAge: time.Minute})
		if err != nil {
			t.Fatalf("tagged %v: %v", tagged, err)
		}
		if string(d.UserData) != "tls key hash" || !bytes.Equal(d.PCRs[0], pcrs[0]) || d.ModuleID == "" {
			t.Errorf("document: %+v", d)
		}
	}
}

func TestDocumentsThatMustBeRefused(t *testing.T) {
	f := enclavetest.NewNitro(t)
	expect := []Measurements{measurementsOf(image(7))}
	doc := func(d enclavetest.Doc) []byte { return f.Document(t, d) }
	for _, c := range []struct {
		name string
		raw  []byte
		opts VerifyOptions
		want string
	}{
		{"signed by someone other than AWS", doc(enclavetest.Doc{PCRs: image(7)}),
			VerifyOptions{Expect: expect}, "certificate chain"},
		{"changed after signing", doc(enclavetest.Doc{PCRs: image(7), Tamper: true}),
			VerifyOptions{Roots: f.Roots}, "signature"},
		{"another image", doc(enclavetest.Doc{PCRs: image(9)}),
			VerifyOptions{Roots: f.Roots, Expect: expect}, "unknown image"},
		{"a replayed document", doc(enclavetest.Doc{PCRs: image(7), Nonce: []byte("old")}),
			VerifyOptions{Roots: f.Roots, Nonce: []byte("new")}, "nonce"},
		{"debug mode", doc(enclavetest.Doc{PCRs: image(0)}),
			VerifyOptions{Roots: f.Roots}, "debug mode"},
		{"certificates expired", doc(enclavetest.Doc{PCRs: image(7)}),
			VerifyOptions{Roots: f.Roots, Time: time.Now().Add(10 * time.Hour)}, "certificate chain"},
		{"too old", doc(enclavetest.Doc{PCRs: image(7), At: time.Now().Add(-10 * time.Minute)}),
			VerifyOptions{Roots: f.Roots, MaxAge: time.Minute}, "old"},
		{"not a document", []byte("hello"), VerifyOptions{Roots: f.Roots}, "COSE_Sign1"},
	} {
		_, err := Verify(c.raw, c.opts)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want an error about %q", c.name, err, c.want)
		}
	}
}

// The embedded root is AWS's, by the fingerprint AWS publishes.
func TestTheEmbeddedRootIsAWSs(t *testing.T) {
	NitroRoots() // panics if it does not parse
	block, _ := pem.Decode(nitroRootPEM)
	if block == nil {
		t.Fatal("no PEM block")
	}
	sum := sha256.Sum256(block.Bytes)
	want := "641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b"
	if hex.EncodeToString(sum[:]) != want {
		t.Errorf("fingerprint %x, want %s", sum, want)
	}
}
