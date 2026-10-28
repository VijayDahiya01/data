package enclave

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"
)

// Sealer keeps secrets outside the enclave that only the same image can read
// back. Each seal wraps a fresh data key with KMS; unsealing asks KMS to
// unwrap it for an attestation document, which KMS checks against the key's
// policy -- the image's measurement -- and answers encrypted to a key made
// for the occasion inside the enclave. The host holds the sealed bytes, the
// credentials and the network, and still cannot open them.
type Sealer struct {
	KMS   KMS
	KeyID string
	// Attest makes an attestation document: Attest in an enclave.
	Attest func(nonce, userData, publicKey []byte) ([]byte, error)
}

type sealed struct {
	Version int    `json:"v"`
	Key     []byte `json:"key"`
	Nonce   []byte `json:"nonce"`
	Data    []byte `json:"data"`
}

var sealAAD = []byte("oolix-agent sealed state v1")

// Seal encrypts plaintext for this image alone.
func (s Sealer) Seal(ctx context.Context, plaintext []byte) ([]byte, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	wrapped, err := s.KMS.Encrypt(ctx, s.KeyID, key)
	if err != nil {
		return nil, err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return json.Marshal(sealed{Version: 1, Key: wrapped, Nonce: nonce, Data: gcm.Seal(nil, nonce, plaintext, sealAAD)})
}

// Unseal opens what Seal made, if this enclave runs an image the key's
// policy names.
func (s Sealer) Unseal(ctx context.Context, blob []byte) ([]byte, error) {
	var b sealed
	if err := json.Unmarshal(blob, &b); err != nil || b.Version != 1 {
		return nil, errors.New("seal: not sealed state")
	}
	recipient, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	pub, err := x509.MarshalPKIXPublicKey(&recipient.PublicKey)
	if err != nil {
		return nil, err
	}
	doc, err := s.Attest(nil, nil, pub)
	if err != nil {
		return nil, err
	}
	envelope, err := s.KMS.DecryptFor(ctx, b.Key, doc)
	if err != nil {
		return nil, err
	}
	key, err := openEnvelope(envelope, recipient)
	if err != nil {
		return nil, err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, b.Nonce, b.Data, sealAAD)
	if err != nil {
		return nil, errors.New("seal: the state does not open with its key")
	}
	return plain, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// State is what a hosted Agent keeps across restarts: its settings, and the
// few files of its state folder -- the local store's key and the Agent's
// private key. The copy of the Partner's customers is not in it: that lives
// in the enclave's memory only, and a restart refreshes it from the
// Partner's database.
type State struct {
	Files map[string][]byte `json:"files"`
	// Store is the local store's snapshot (localstore.Snapshot).
	Store json.RawMessage `json:"store"`
}

// HostClient asks the host for what only it can give: the sealed state it
// keeps, and credentials. Open is the stream to the host (DialVsock to
// HostCID in an enclave).
type HostClient struct {
	Open func(ctx context.Context) (net.Conn, error)

	mu    sync.Mutex
	creds Credentials
}

func (h *HostClient) request(ctx context.Context, line string, body []byte) (net.Conn, error) {
	c, err := h.Open(ctx)
	if err != nil {
		return nil, fmt.Errorf("enclave: reaching the host: %w", err)
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(30 * time.Second)
	}
	_ = c.SetDeadline(deadline)
	if _, err := c.Write(append([]byte(line+"\n"), body...)); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// GetState is the sealed state the host keeps, or nil before the first.
func (h *HostClient) GetState(ctx context.Context) ([]byte, error) {
	c, err := h.request(ctx, "STATE GET", nil)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	line, err := readLine(c)
	if err != nil {
		return nil, err
	}
	n, err := strconv.Atoi(line)
	if err != nil || n < 0 || n > MaxState {
		return nil, fmt.Errorf("enclave: the host answered %q", line)
	}
	data := make([]byte, n)
	if _, err := io.ReadFull(c, data); err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, nil
	}
	return data, nil
}

// PutState hands the host new sealed state to keep.
func (h *HostClient) PutState(ctx context.Context, blob []byte) error {
	c, err := h.request(ctx, "STATE PUT "+strconv.Itoa(len(blob)), blob)
	if err != nil {
		return err
	}
	defer c.Close()
	if line, err := readLine(c); err != nil || line != "OK" {
		return fmt.Errorf("enclave: the host did not keep the state: %q %v", line, err)
	}
	return nil
}

// Hostname is the name the Partner reaches the enclave by, as the host says.
func (h *HostClient) Hostname(ctx context.Context) (string, error) {
	c, err := h.request(ctx, "CONFIG", nil)
	if err != nil {
		return "", err
	}
	defer c.Close()
	line, err := readLine(c)
	if err != nil {
		return "", err
	}
	var cfg struct {
		Hostname string `json:"hostname"`
	}
	if err := json.Unmarshal([]byte(line), &cfg); err != nil || cfg.Hostname == "" {
		return "", fmt.Errorf("enclave: the host gave no hostname: %s", line)
	}
	return cfg.Hostname, nil
}

// Credentials are the host's instance-role credentials, fetched again five
// minutes before they expire.
func (h *HostClient) Credentials(ctx context.Context) (Credentials, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.creds.AccessKeyID != "" && time.Until(h.creds.Expiration) > 5*time.Minute {
		return h.creds, nil
	}
	c, err := h.request(ctx, "CREDENTIALS", nil)
	if err != nil {
		return Credentials{}, err
	}
	defer c.Close()
	line, err := readLine(c)
	if err != nil {
		return Credentials{}, err
	}
	var creds Credentials
	if err := json.Unmarshal([]byte(line), &creds); err != nil || creds.AccessKeyID == "" {
		return Credentials{}, fmt.Errorf("enclave: no credentials from the host: %s", line)
	}
	h.creds = creds
	return creds, nil
}
