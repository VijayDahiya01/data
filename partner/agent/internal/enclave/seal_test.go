package enclave

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	encasn1 "encoding/asn1"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/cryptobyte"
	"golang.org/x/crypto/cryptobyte/asn1"

	"github.com/oolix/partner-agent/internal/enclave/enclavetest"
)

// envelope builds what KMS answers for an enclave: CMS EnvelopedData, the
// content key wrapped with RSAES-OAEP/SHA-256, the content AES-256-CBC. The
// encrypted content is DER's primitive form, or BER's constructed one in
// two parts.
func envelope(t *testing.T, content []byte, to *rsa.PublicKey, constructed bool) []byte {
	t.Helper()
	cek, iv := make([]byte, 32), make([]byte, 16)
	_, _ = rand.Read(cek)
	_, _ = rand.Read(iv)
	pad := aes.BlockSize - len(content)%aes.BlockSize
	padded := append(append([]byte{}, content...), bytes.Repeat([]byte{byte(pad)}, pad)...)
	block, _ := aes.NewCipher(cek)
	ct := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ct, padded)
	ek, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, to, cek, nil)
	if err != nil {
		t.Fatal(err)
	}
	var b cryptobyte.Builder
	b.AddASN1(asn1.SEQUENCE, func(ci *cryptobyte.Builder) {
		ci.AddASN1ObjectIdentifier(oidEnvelopedData)
		ci.AddASN1(asn1.Tag(0).Constructed().ContextSpecific(), func(c *cryptobyte.Builder) {
			c.AddASN1(asn1.SEQUENCE, func(ed *cryptobyte.Builder) {
				ed.AddASN1Int64(2)
				ed.AddASN1(asn1.SET, func(ris *cryptobyte.Builder) {
					ris.AddASN1(asn1.SEQUENCE, func(ri *cryptobyte.Builder) {
						ri.AddASN1Int64(2)
						ri.AddASN1(asn1.Tag(0).ContextSpecific(), func(id *cryptobyte.Builder) { id.AddBytes([]byte("kid")) })
						ri.AddASN1(asn1.SEQUENCE, func(alg *cryptobyte.Builder) { alg.AddASN1ObjectIdentifier(oidRSAESOAEP) })
						ri.AddASN1OctetString(ek)
					})
				})
				ed.AddASN1(asn1.SEQUENCE, func(eci *cryptobyte.Builder) {
					eci.AddASN1ObjectIdentifier(encasn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 1})
					eci.AddASN1(asn1.SEQUENCE, func(alg *cryptobyte.Builder) {
						alg.AddASN1ObjectIdentifier(oidAES256CBC)
						alg.AddASN1OctetString(iv)
					})
					if constructed {
						eci.AddASN1(asn1.Tag(0).Constructed().ContextSpecific(), func(parts *cryptobyte.Builder) {
							parts.AddASN1OctetString(ct[:16])
							parts.AddASN1OctetString(ct[16:])
						})
					} else {
						eci.AddASN1(asn1.Tag(0).ContextSpecific(), func(ec *cryptobyte.Builder) { ec.AddBytes(ct) })
					}
				})
			})
		})
	})
	return b.BytesOrPanic()
}

func TestOpenEnvelope(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	secret := []byte("a 32-byte data key, more or less")
	for _, constructed := range []bool{false, true} {
		got, err := openEnvelope(envelope(t, secret, &key.PublicKey, constructed), key)
		if err != nil || !bytes.Equal(got, secret) {
			t.Errorf("constructed %v: %q %v", constructed, got, err)
		}
	}
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	if _, err := openEnvelope(envelope(t, secret, &other.PublicKey, false), key); err == nil {
		t.Error("an envelope for another key opened")
	}
	if _, err := openEnvelope([]byte("not CMS"), key); err == nil {
		t.Error("garbage opened")
	}
}

// fakeKMS does what KMS does for a key whose policy names one image: it
// wraps anything, and unwraps only for an attestation document from that
// image, encrypted to the document's public key.
type fakeKMS struct {
	t      *testing.T
	master cipher.AEAD
	nitro  *enclavetest.Nitro
	image  Measurements
}

func newFakeKMS(t *testing.T, nitro *enclavetest.Nitro, image Measurements) *fakeKMS {
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	return &fakeKMS{t: t, master: gcm, nitro: nitro, image: image}
}

func (k *fakeKMS) Encrypt(ctx context.Context, keyID string, plaintext []byte) ([]byte, error) {
	nonce := make([]byte, k.master.NonceSize())
	_, _ = rand.Read(nonce)
	return k.master.Seal(nonce, nonce, plaintext, []byte(keyID)), nil
}

func (k *fakeKMS) DecryptFor(ctx context.Context, ciphertext, attestation []byte) ([]byte, error) {
	doc, err := Verify(attestation, VerifyOptions{Roots: k.nitro.Roots, Expect: []Measurements{k.image}})
	if err != nil {
		return nil, errors.New("AccessDeniedException: " + err.Error())
	}
	n := k.master.NonceSize()
	plain, err := k.master.Open(nil, ciphertext[:n], ciphertext[n:], []byte("alias/oolix-agent"))
	if err != nil {
		return nil, err
	}
	pub, err := x509.ParsePKIXPublicKey(doc.PublicKey)
	if err != nil {
		return nil, err
	}
	return envelope(k.t, plain, pub.(*rsa.PublicKey), false), nil
}

func TestSealedStateOpensOnlyInTheSameImage(t *testing.T) {
	nitro := enclavetest.NewNitro(t)
	published := image(7)
	kms := newFakeKMS(t, nitro, measurementsOf(published))
	attestAs := func(pcrs map[int][]byte) func(nonce, userData, publicKey []byte) ([]byte, error) {
		return func(nonce, userData, publicKey []byte) ([]byte, error) {
			return nitro.Document(t, enclavetest.Doc{PCRs: pcrs, Nonce: nonce, UserData: userData, PublicKey: publicKey}), nil
		}
	}
	ctx := context.Background()
	s := Sealer{KMS: kms, KeyID: "alias/oolix-agent", Attest: attestAs(published)}
	blob, err := s.Seal(ctx, []byte(`{"settings":"secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte("secret")) {
		t.Fatal("the sealed state shows its content")
	}
	got, err := s.Unseal(ctx, blob)
	if err != nil || string(got) != `{"settings":"secret"}` {
		t.Fatalf("unsealed %q %v", got, err)
	}

	// Another image -- an Oolix build that is not the published one -- is
	// refused by the key's policy.
	other := Sealer{KMS: kms, KeyID: "alias/oolix-agent", Attest: attestAs(image(9))}
	if _, err := other.Unseal(ctx, blob); err == nil || !strings.Contains(err.Error(), "AccessDenied") {
		t.Errorf("another image unsealed: %v", err)
	}
}

// The host keeps the sealed state and relays credentials; the enclave asks
// over one stream per request.
func TestTheHostKeepsStateAndRelaysCredentials(t *testing.T) {
	calls := 0
	host := &Host{
		StatePath: filepath.Join(t.TempDir(), "agent.sealed"),
		Credentials: func(ctx context.Context) (Credentials, error) {
			calls++
			return Credentials{AccessKeyID: "AKIA", SecretAccessKey: "s", Token: "t",
				Expiration: time.Now().Add(time.Hour)}, nil
		},
	}
	l := listen(t)
	go host.Serve(l)
	client := &HostClient{Open: func(ctx context.Context) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", l.Addr().String())
	}}
	ctx := context.Background()

	if got, err := client.GetState(ctx); err != nil || got != nil {
		t.Fatalf("before any state: %q %v", got, err)
	}
	if err := client.PutState(ctx, []byte("sealed bytes")); err != nil {
		t.Fatal(err)
	}
	if got, err := client.GetState(ctx); err != nil || string(got) != "sealed bytes" {
		t.Fatalf("state: %q %v", got, err)
	}
	for i := 0; i < 2; i++ {
		creds, err := client.Credentials(ctx)
		if err != nil || creds.AccessKeyID != "AKIA" {
			t.Fatalf("credentials: %+v %v", creds, err)
		}
	}
	if calls != 1 {
		t.Errorf("credentials fetched %d times; they last an hour", calls)
	}
	if _, err := client.Hostname(ctx); err == nil {
		t.Error("a host with no hostname gave one")
	}
	host.Hostname = "acme.agents.oolix.in"
	if name, err := client.Hostname(ctx); err != nil || name != "acme.agents.oolix.in" {
		t.Errorf("hostname %q %v", name, err)
	}
}

func TestIMDSv2(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/latest/api/token":
			_, _ = w.Write([]byte("tok"))
		case r.Header.Get("X-aws-ec2-metadata-token") != "tok":
			w.WriteHeader(http.StatusUnauthorized)
		case r.URL.Path == "/latest/meta-data/iam/security-credentials/":
			_, _ = w.Write([]byte("oolix-enclave-host\n"))
		case r.URL.Path == "/latest/meta-data/iam/security-credentials/oolix-enclave-host":
			_, _ = w.Write([]byte(`{"AccessKeyId":"ASIA","SecretAccessKey":"s","Token":"t","Expiration":"2026-10-28T12:00:00Z"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	creds, err := IMDSCredentials(srv.Client(), srv.URL+"/latest")(context.Background())
	if err != nil || creds.AccessKeyID != "ASIA" || creds.Token != "t" {
		t.Errorf("%+v %v", creds, err)
	}
}

// The KMS call is signed and shaped as KMS wants it.
func TestAWSKMSRequests(t *testing.T) {
	var target, auth, token string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target, auth, token = r.Header.Get("X-Amz-Target"), r.Header.Get("Authorization"), r.Header.Get("X-Amz-Security-Token")
		if target == "TrentService.Decrypt" {
			_, _ = w.Write([]byte(`{"CiphertextForRecipient":"AQID"}`))
			return
		}
		_, _ = w.Write([]byte(`{"CiphertextBlob":"BAUG"}`))
	}))
	defer srv.Close()
	k := AWSKMS{Region: "ap-south-1", HTTP: srv.Client(), Endpoint: srv.URL,
		Credentials: func(ctx context.Context) (Credentials, error) {
			return Credentials{AccessKeyID: "ASIA", SecretAccessKey: "s", Token: "session"}, nil
		}}
	ct, err := k.Encrypt(context.Background(), "alias/x", []byte("k"))
	if err != nil || !bytes.Equal(ct, []byte{4, 5, 6}) || target != "TrentService.Encrypt" {
		t.Fatalf("encrypt: %v %v %s", ct, err, target)
	}
	if !strings.Contains(auth, "/ap-south-1/kms/aws4_request") || token != "session" {
		t.Errorf("signature %q, token %q", auth, token)
	}
	env, err := k.DecryptFor(context.Background(), []byte{1}, []byte{2})
	if err != nil || !bytes.Equal(env, []byte{1, 2, 3}) || target != "TrentService.Decrypt" {
		t.Errorf("decrypt: %v %v %s", env, err, target)
	}
}
