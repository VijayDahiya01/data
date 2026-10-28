//go:build !linux

package enclave

// InEnclave is false: Nitro Enclaves run Linux.
func InEnclave() bool { return false }

// Attest is only possible inside a Nitro Enclave.
func Attest(nonce, userData, publicKey []byte) ([]byte, error) { return nil, ErrNotInEnclave }
