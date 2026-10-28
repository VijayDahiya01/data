// Package cleanroom matches customers across Partners without either Partner,
// or Oolix, seeing the other's customers (docs/DESIGN-PARTNER-DATA.md §9,
// phase 7).
//
// Each Agent turns the email and phone of customers who agreed to
// cross-Partner matching into match keys -- SHA-256 of a normalised form,
// the same on every Partner -- and seals them to the clean room: a service
// running in an AWS Nitro Enclave whose key the Agent checks by attestation
// before sending. Oolix carries the sealed keys and never holds a key that
// opens them. The clean room counts the overlap and answers in size bands
// only, with small overlaps suppressed, signed with a key its attestation
// names.
package cleanroom

import (
	"crypto/sha256"
	"net/mail"
	"strings"
	"unicode"
)

// Key is a match key: SHA-256 of a normalised email or phone.
type Key [32]byte

// EmailKey is the key of an email address: trimmed and lower-cased, as
// advertising platforms normalise it, so Partners who stored it differently
// still match. ok is false for what is not an address.
func EmailKey(raw string) (Key, bool) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" || !strings.Contains(s, "@") {
		return Key{}, false
	}
	if a, err := mail.ParseAddress(s); err != nil || a.Address != s {
		return Key{}, false
	}
	return sha256.Sum256([]byte("email:" + s)), true
}

// PhoneKey is the key of a phone number in E.164 form, Indian numbers by
// default: 98765 43210, 098765-43210, +91 98765 43210 and 919876543210 are
// all +919876543210. ok is false for what is not a mobile number.
func PhoneKey(raw string) (Key, bool) {
	var digits strings.Builder
	plus := false
	for i, r := range strings.TrimSpace(raw) {
		switch {
		case unicode.IsDigit(r):
			digits.WriteRune(r)
		case r == '+' && i == 0:
			plus = true
		case r == ' ' || r == '-' || r == '(' || r == ')' || r == '.':
		default:
			return Key{}, false
		}
	}
	d := digits.String()
	switch {
	case plus && strings.HasPrefix(d, "91") && len(d) == 12:
	case plus && len(d) >= 8 && len(d) <= 15 && !strings.HasPrefix(d, "91"):
		// Another country's number, already in E.164.
	case !plus && len(d) == 10:
		d = "91" + d
	case !plus && len(d) == 11 && d[0] == '0':
		d = "91" + d[1:]
	case !plus && len(d) == 12 && strings.HasPrefix(d, "91"):
	default:
		return Key{}, false
	}
	if strings.HasPrefix(d, "91") && (len(d) != 12 || d[2] < '6') {
		return Key{}, false // Indian mobile numbers start with 6 to 9
	}
	return sha256.Sum256([]byte("phone:+" + d)), true
}
