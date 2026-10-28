package enclave

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/oolix/partner-agent/internal/awssig"
)

// KMS is the part of AWS KMS that sealing uses.
type KMS interface {
	// Encrypt wraps a data key under the sealing key.
	Encrypt(ctx context.Context, keyID string, plaintext []byte) ([]byte, error)
	// DecryptFor unwraps it for an enclave: KMS checks the attestation
	// document against the key's policy -- which names the image -- and
	// returns the plaintext encrypted to the document's public key, as CMS
	// EnvelopedData that only the enclave can open.
	DecryptFor(ctx context.Context, ciphertext, attestation []byte) ([]byte, error)
}

// Credentials are temporary AWS credentials: the host's instance role,
// relayed into the enclave. They are no secret from the host, and need not
// be: the key's policy releases nothing without an attestation document.
type Credentials struct {
	AccessKeyID     string    `json:"AccessKeyId"`
	SecretAccessKey string    `json:"SecretAccessKey"`
	Token           string    `json:"Token"`
	Expiration      time.Time `json:"Expiration"`
}

// AWSKMS calls KMS's JSON API, signed with Signature Version 4.
type AWSKMS struct {
	Region      string
	Credentials func(ctx context.Context) (Credentials, error)
	HTTP        *http.Client
	// Endpoint overrides https://kms.<region>.amazonaws.com, for tests.
	Endpoint string
	Now      func() time.Time
}

func (k AWSKMS) Encrypt(ctx context.Context, keyID string, plaintext []byte) ([]byte, error) {
	var out struct {
		CiphertextBlob []byte `json:"CiphertextBlob"`
	}
	err := k.call(ctx, "Encrypt", map[string]any{"KeyId": keyID, "Plaintext": plaintext}, &out)
	return out.CiphertextBlob, err
}

func (k AWSKMS) DecryptFor(ctx context.Context, ciphertext, attestation []byte) ([]byte, error) {
	var out struct {
		CiphertextForRecipient []byte `json:"CiphertextForRecipient"`
	}
	err := k.call(ctx, "Decrypt", map[string]any{
		"CiphertextBlob": ciphertext,
		"Recipient": map[string]any{
			"KeyEncryptionAlgorithm": "RSAES_OAEP_SHA_256",
			"AttestationDocument":    attestation,
		},
	}, &out)
	if err == nil && len(out.CiphertextForRecipient) == 0 {
		err = errors.New("kms: no ciphertext for the enclave in the answer")
	}
	return out.CiphertextForRecipient, err
}

func (k AWSKMS) call(ctx context.Context, action string, body, out any) error {
	creds, err := k.Credentials(ctx)
	if err != nil {
		return fmt.Errorf("kms: credentials: %w", err)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	endpoint := k.Endpoint
	if endpoint == "" {
		endpoint = "https://kms." + k.Region + ".amazonaws.com/"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-amz-json-1.1")
	req.Header.Set("X-Amz-Target", "TrentService."+action)
	req.Header.Set("X-Amz-Content-Sha256", awssig.PayloadHash(raw))
	if creds.Token != "" {
		req.Header.Set("X-Amz-Security-Token", creds.Token)
	}
	now := time.Now
	if k.Now != nil {
		now = k.Now
	}
	awssig.Sign(req, k.Region, "kms", creds.AccessKeyID, creds.SecretAccessKey, now())
	res, err := k.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("kms %s: %w", action, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		var e struct {
			Type    string `json:"__type"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &e)
		return fmt.Errorf("kms %s answered %d: %s %s", action, res.StatusCode, e.Type, e.Message)
	}
	return json.Unmarshal(data, out)
}
