//go:build linux

package enclave

import (
	"errors"
	"fmt"
	"os"

	"github.com/hf/nsm"
	"github.com/hf/nsm/request"
)

// InEnclave reports whether this process runs in a Nitro Enclave: only there
// does the Nitro Secure Module's device exist.
func InEnclave() bool {
	_, err := os.Stat("/dev/nsm")
	return err == nil
}

// Attest asks the Nitro Secure Module for an attestation document carrying
// a nonce, user data and a public key, each up to 1 KiB and each optional.
func Attest(nonce, userData, publicKey []byte) ([]byte, error) {
	sess, err := nsm.OpenDefaultSession()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotInEnclave, err)
	}
	defer sess.Close()
	res, err := sess.Send(&request.Attestation{Nonce: nonce, UserData: userData, PublicKey: publicKey})
	if err != nil {
		return nil, fmt.Errorf("attestation: %w", err)
	}
	if res.Error != "" {
		return nil, fmt.Errorf("attestation: %s", res.Error)
	}
	if res.Attestation == nil || len(res.Attestation.Document) == 0 {
		return nil, errors.New("attestation: the module returned no document")
	}
	return res.Attestation.Document, nil
}
