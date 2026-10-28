package cleanroom

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"slices"
)

// Sealing to a recipient's X25519 key: an ephemeral key pair, the shared
// secret through HKDF-SHA256, AES-256-GCM. The sealed bytes are the
// ephemeral public key, the nonce and the ciphertext; only the holder of the
// recipient's private key -- the clean room, inside its enclave, or an Agent
// receiving a joint audience -- can open them.

const sealInfo = "oolix-cleanroom-v1"

// Seal encrypts plaintext to the recipient's public key.
func Seal(to *ecdh.PublicKey, plaintext []byte) ([]byte, error) {
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	gcm, err := sealCipher(eph, to, eph.PublicKey().Bytes(), to.Bytes())
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := append(append(eph.PublicKey().Bytes(), nonce...), gcm.Seal(nil, nonce, plaintext, nil)...)
	return out, nil
}

// Open decrypts what Seal made for key.
func Open(key *ecdh.PrivateKey, sealed []byte) ([]byte, error) {
	const pub, nonce = 32, 12
	if len(sealed) < pub+nonce+16 {
		return nil, errors.New("cleanroom: sealed data too short")
	}
	eph, err := ecdh.X25519().NewPublicKey(sealed[:pub])
	if err != nil {
		return nil, err
	}
	gcm, err := sealCipher(key, eph, sealed[:pub], key.PublicKey().Bytes())
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, sealed[pub:pub+nonce], sealed[pub+nonce:], nil)
	if err != nil {
		return nil, errors.New("cleanroom: the sealed data does not open with this key")
	}
	return plain, nil
}

func sealCipher(priv *ecdh.PrivateKey, pub *ecdh.PublicKey, ephPub, recipientPub []byte) (cipher.AEAD, error) {
	secret, err := priv.ECDH(pub)
	if err != nil {
		return nil, err
	}
	key, err := hkdf.Key(sha256.New, secret, append(slices.Clone(ephPub), recipientPub...), sealInfo, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
