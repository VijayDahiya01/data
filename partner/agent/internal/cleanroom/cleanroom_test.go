package cleanroom

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/oolix/partner-agent/internal/enclave"
	"github.com/oolix/partner-agent/internal/enclave/enclavetest"
)

// The same person, stored differently by two Partners, has the same keys.
func TestMatchKeysAgreeAcrossPartners(t *testing.T) {
	same := func(f func(string) (Key, bool), a, b string) {
		t.Helper()
		ka, oka := f(a)
		kb, okb := f(b)
		if !oka || !okb || ka != kb {
			t.Errorf("%q and %q: %v %v, keys equal %v", a, b, oka, okb, ka == kb)
		}
	}
	same(EmailKey, " Asha.Rao@Example.com ", "asha.rao@example.com")
	same(PhoneKey, "98765 43210", "+91 98765-43210")
	same(PhoneKey, "098765 43210", "919876543210")
	for _, bad := range []string{"", "not an email", "a@", "Asha <asha@example.com>"} {
		if _, ok := EmailKey(bad); ok {
			t.Errorf("email %q accepted", bad)
		}
	}
	for _, bad := range []string{"12345", "+91 12345 67890", "98765 4321x", "022 2345 6789"} {
		if _, ok := PhoneKey(bad); ok {
			t.Errorf("phone %q accepted", bad)
		}
	}
	if e, _ := EmailKey("9876543210@x.in"); func() bool { p, _ := PhoneKey("9876543210"); return p == e }() {
		t.Error("an email and a phone share a key")
	}
}

func TestSealOpensOnlyForItsKey(t *testing.T) {
	key, _ := ecdh.X25519().GenerateKey(rand.Reader)
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	sealed, err := Seal(key.PublicKey(), []byte("customers"))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := Open(key, sealed); err != nil || string(got) != "customers" {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := Open(other, sealed); err == nil {
		t.Error("opened with another key")
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := Open(key, sealed); err == nil {
		t.Error("opened after tampering")
	}
}

// people makes n customers from a range of numbers, each with an email
// and, for even numbers, a phone too.
func people(from, n int) []Customer {
	var out []Customer
	for i := from; i < from+n; i++ {
		e, _ := EmailKey(fmt.Sprintf("person%d@example.com", i))
		c := Customer{e}
		if i%2 == 0 {
			p, _ := PhoneKey(fmt.Sprintf("9%09d", i))
			c = append(c, p)
		}
		out = append(out, c)
	}
	return out
}

func TestOverlapCountsPeopleOnceAndHidesSmallOnes(t *testing.T) {
	a := people(0, 1000)
	b := people(500, 1000) // 500 shared, half of them by both keys
	c := people(1450, 100) // 50 shared with b: too few to tell
	got := Overlap(map[string][]Customer{"a": a, "b": b, "c": c})
	want := []Pair{{"a", "b", "100_TO_1K"}, {"a", "c", "UNDER_100"}, {"b", "c", "UNDER_100"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if n := matching(a, allKeys(b)); n != 500 {
		t.Errorf("shared customers counted %d, want 500 -- once each, whatever matched", n)
	}
	if _, n, ok := Joint(c, b); ok || n != 50 {
		t.Errorf("a joint audience of %d was handed over", n)
	}
	keys, n, ok := Joint(a, b)
	if !ok || n != 500 || len(keys) != 750 {
		t.Errorf("joint: %d customers, %d keys, %v", n, len(keys), ok)
	}
	round, err := DecodeCustomers(EncodeCustomers(a))
	if err != nil || len(round) != len(a) || round[2][1] != a[2][1] {
		t.Errorf("customers did not survive encoding: %v", err)
	}
}

// End to end: Agents check the clean room's attestation, seal to the key it
// names, and the answers verify against the key it names.
func TestTheCleanRoom(t *testing.T) {
	nitro := enclavetest.NewNitro(t)
	image := enclavetest.Image(5)
	svc, err := NewService(func(nonce, userData, publicKey []byte) ([]byte, error) {
		return nitro.Document(t, enclavetest.Doc{PCRs: image, Nonce: nonce, UserData: userData, PublicKey: publicKey}), nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(svc.Handler())
	defer srv.Close()

	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	res, err := http.Get(srv.URL + "/attestation?nonce=" + hex.EncodeToString(nonce))
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := io.ReadAll(res.Body)
	res.Body.Close()
	measured := enclave.Measurements{PCR0: hex.EncodeToString(image[0]), PCR1: hex.EncodeToString(image[1]),
		PCR2: hex.EncodeToString(image[2])}
	box, signer, err := Recipient(doc, enclave.VerifyOptions{Roots: nitro.Roots, Expect: []enclave.Measurements{measured},
		Nonce: nonce})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := Recipient(doc, enclave.VerifyOptions{Roots: nitro.Roots,
		Expect: []enclave.Measurements{{PCR0: "00", PCR1: "00", PCR2: "00"}}}); err == nil {
		t.Error("an unpublished clean room was trusted")
	}

	seal := func(partner string, customers []Customer) Input {
		sealed, err := Seal(box, EncodeCustomers(customers))
		if err != nil {
			t.Fatal(err)
		}
		return Input{Partner: partner, Sealed: sealed}
	}
	post := func(path string, body any) Signed {
		raw, _ := json.Marshal(body)
		res, err := http.Post(srv.URL+path, "application/json", bytes.NewReader(raw))
		if err != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("%s: %v %v", path, res.StatusCode, err)
		}
		defer res.Body.Close()
		var s Signed
		_ = json.NewDecoder(res.Body).Decode(&s)
		return s
	}

	answer := post("/v1/overlap", map[string]any{"run_id": "run-1",
		"inputs": []Input{seal("org-a", people(0, 1000)), seal("org-b", people(500, 1000))}})
	var overlap OverlapResult
	if err := VerifySigned(answer, signer, &overlap); err != nil {
		t.Fatal(err)
	}
	if overlap.RunID != "run-1" || len(overlap.Pairs) != 1 || overlap.Pairs[0].Band != "100_TO_1K" {
		t.Errorf("overlap: %+v", overlap)
	}
	answer.Payload[len(answer.Payload)-2] ^= 1
	if VerifySigned(answer, signer, &overlap) == nil {
		t.Error("a changed answer verified")
	}

	// A joint audience goes to the base Partner's Agent alone.
	agentKey, _ := ecdh.X25519().GenerateKey(rand.Reader)
	answer = post("/v1/joint", map[string]any{"run_id": "run-2", "base": seal("org-a", people(0, 1000)),
		"other": seal("org-b", people(500, 1000)), "recipient": agentKey.PublicKey().Bytes()})
	var joint JointResult
	if err := VerifySigned(answer, signer, &joint); err != nil {
		t.Fatal(err)
	}
	plain, err := Open(agentKey, joint.Sealed)
	if err != nil {
		t.Fatal(err)
	}
	keys, _ := DecodeKeys(plain)
	if joint.Band != "100_TO_1K" || len(keys) != 750 {
		t.Errorf("joint: band %s, %d keys", joint.Band, len(keys))
	}
}
