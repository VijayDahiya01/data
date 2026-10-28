package enclave

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rsa"
	"crypto/sha256"
	encasn1 "encoding/asn1"
	"errors"
	"fmt"

	"golang.org/x/crypto/cryptobyte"
	"golang.org/x/crypto/cryptobyte/asn1"
)

// What KMS returns for an enclave is CMS EnvelopedData (RFC 5652): the
// content key wrapped to the enclave's RSA key with RSAES-OAEP and SHA-256,
// and the content encrypted with AES-256-CBC. Only that combination is
// accepted.
var (
	oidEnvelopedData = encasn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 3}
	oidRSAESOAEP     = encasn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 7}
	oidAES256CBC     = encasn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 42}
)

// openEnvelope decrypts CMS EnvelopedData addressed to key.
func openEnvelope(der []byte, key *rsa.PrivateKey) ([]byte, error) {
	bad := func(what string) ([]byte, error) { return nil, fmt.Errorf("cms: %s", what) }
	in := cryptobyte.String(der)
	var contentInfo, content, env cryptobyte.String
	var oid encasn1.ObjectIdentifier
	if !in.ReadASN1(&contentInfo, asn1.SEQUENCE) || !contentInfo.ReadASN1ObjectIdentifier(&oid) {
		return bad("not a ContentInfo")
	}
	if !oid.Equal(oidEnvelopedData) {
		return bad("not EnvelopedData")
	}
	if !contentInfo.ReadASN1(&content, asn1.Tag(0).Constructed().ContextSpecific()) ||
		!content.ReadASN1(&env, asn1.SEQUENCE) {
		return bad("no EnvelopedData content")
	}
	var version int64
	if !env.ReadASN1Integer(&version) ||
		!env.SkipOptionalASN1(asn1.Tag(0).Constructed().ContextSpecific()) { // originatorInfo
		return bad("bad EnvelopedData header")
	}

	// The recipients: the one KeyTransRecipientInfo for our key.
	var recipients cryptobyte.String
	if !env.ReadASN1(&recipients, asn1.SET) {
		return bad("no recipients")
	}
	var encryptedKey []byte
	for !recipients.Empty() {
		var ri, alg cryptobyte.String
		if !recipients.ReadASN1(&ri, asn1.SEQUENCE) {
			break // not KeyTransRecipientInfo (those are tagged)
		}
		var riVersion int64
		var tag asn1.Tag
		var algOID encasn1.ObjectIdentifier
		var rid, ek cryptobyte.String
		if !ri.ReadASN1Integer(&riVersion) || !ri.ReadAnyASN1(&rid, &tag) ||
			!ri.ReadASN1(&alg, asn1.SEQUENCE) || !alg.ReadASN1ObjectIdentifier(&algOID) ||
			!ri.ReadASN1(&ek, asn1.OCTET_STRING) {
			return bad("bad KeyTransRecipientInfo")
		}
		if algOID.Equal(oidRSAESOAEP) {
			encryptedKey = ek
			break
		}
	}
	if encryptedKey == nil {
		return bad("no recipient with RSAES-OAEP")
	}
	cek, err := rsa.DecryptOAEP(sha256.New(), nil, key, encryptedKey, nil)
	if err != nil {
		return nil, fmt.Errorf("cms: unwrapping the content key: %w", err)
	}

	var eci, cea, iv cryptobyte.String
	var ctype, ceaOID encasn1.ObjectIdentifier
	if !env.ReadASN1(&eci, asn1.SEQUENCE) || !eci.ReadASN1ObjectIdentifier(&ctype) ||
		!eci.ReadASN1(&cea, asn1.SEQUENCE) || !cea.ReadASN1ObjectIdentifier(&ceaOID) {
		return bad("bad EncryptedContentInfo")
	}
	if !ceaOID.Equal(oidAES256CBC) || !cea.ReadASN1(&iv, asn1.OCTET_STRING) || len(iv) != aes.BlockSize {
		return bad("content not encrypted with AES-256-CBC")
	}
	ciphertext, ok := encryptedContent(&eci)
	if !ok {
		return bad("no encrypted content")
	}
	if len(cek) != 32 || len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return bad("bad content key or content length")
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	plain := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, ciphertext)
	return unpad(plain)
}

// encryptedContent reads [0] IMPLICIT OCTET STRING, in DER (primitive) or
// BER's constructed form (a run of OCTET STRINGs).
func encryptedContent(eci *cryptobyte.String) ([]byte, bool) {
	var prim, cons cryptobyte.String
	var present bool
	if !eci.ReadOptionalASN1(&prim, &present, asn1.Tag(0).ContextSpecific()) {
		return nil, false
	}
	if present {
		return prim, true
	}
	if !eci.ReadOptionalASN1(&cons, &present, asn1.Tag(0).Constructed().ContextSpecific()) || !present {
		return nil, false
	}
	var out []byte
	for !cons.Empty() {
		var part cryptobyte.String
		if !cons.ReadASN1(&part, asn1.OCTET_STRING) {
			return nil, false
		}
		out = append(out, part...)
	}
	return out, true
}

func unpad(b []byte) ([]byte, error) {
	n := int(b[len(b)-1])
	if n == 0 || n > aes.BlockSize || n > len(b) || !bytes.Equal(b[len(b)-n:], bytes.Repeat([]byte{byte(n)}, n)) {
		return nil, errors.New("cms: bad padding")
	}
	return b[:len(b)-n], nil
}
