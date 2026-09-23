// Package channel prepares and uploads audiences to external ad platforms.
//
// It lives in the Partner Agent, not in Oolix, and that placement is the whole
// design. Spec §17: "raw audience data and ingestion credentials execute
// inside Partner Agent; Oolix stores account IDs, authorization state,
// resource IDs and non-sensitive configuration." A customer identifier is
// readable here, hashed here, and sent from here straight to the platform.
// It never travels via Oolix, which is what lets the product keep saying that
// Oolix does not hold customer data even while Meta and Google are in use.
//
// # Normalization is not cosmetic
//
// Both platforms match on the SHA-256 of a normalized identifier. If the
// normalization is wrong the hash is wrong, the match silently fails, and the
// campaign under-delivers with no error anywhere: the upload succeeds, the
// audience is simply small. That failure mode is why the rules below are
// spelled out per platform rather than shared, and why the tests assert exact
// digests rather than "it returned something".
//
// The two platforms genuinely differ. Meta wants phone numbers as bare digits
// including country code; Google wants E.164 with the leading plus. Sharing
// one normalizer would mean being wrong for one of them.
//
// # Verify before a real upload
//
// §48.2 says plainly: "verify current official documentation during connector
// implementation". These rules follow the documented behaviour at the time of
// writing. Re-check them against the live docs before the first production
// upload, because a normalization change is invisible until match rates drop.
package channel

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"unicode"
)

// Provider is an external ad platform.
type Provider string

const (
	ProviderMeta   Provider = "META"
	ProviderGoogle Provider = "GOOGLE"
)

// Kind is a category of matching identifier.
type Kind string

const (
	KindEmail     Kind = "email"
	KindPhone     Kind = "phone"
	KindFirstName Kind = "first_name"
	KindLastName  Kind = "last_name"
	KindCountry   Kind = "country"
	KindZip       Kind = "zip"
	// KindMobileID is an advertising id (IDFA/AAID). Platforms take these raw,
	// NOT hashed -- hashing one produces a value that matches nothing.
	KindMobileID Kind = "mobile_id"
)

// Normalize prepares a raw value for hashing, per the platform's rules.
//
// The second return is false when the value cannot be used at all. A caller
// must drop such a record rather than upload an empty or partial hash: a hash
// of "" is a perfectly valid-looking digest that matches nobody, and enough of
// them look like a working upload with a poor audience.
func Normalize(p Provider, k Kind, raw string) (string, bool) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", false
	}

	switch k {
	case KindEmail:
		return normalizeEmail(v)
	case KindPhone:
		return normalizePhone(p, v)
	case KindFirstName, KindLastName:
		return normalizeName(v)
	case KindCountry:
		return normalizeCountry(v)
	case KindZip:
		return normalizeZip(p, v)
	case KindMobileID:
		// Lower-cased but otherwise untouched, and never hashed downstream.
		return strings.ToLower(v), true
	default:
		return "", false
	}
}

// Hash returns the lower-case hex SHA-256 both platforms expect.
//
// It refuses an empty input rather than returning the well-known digest of the
// empty string, which is the single easiest way to upload a large audience
// that matches nobody.
func Hash(normalized string) (string, bool) {
	if normalized == "" {
		return "", false
	}
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:]), true
}

// NormalizeAndHash is the pairing every caller actually wants.
//
// Mobile advertising ids are returned normalized but UNHASHED, because that is
// what both platforms accept for them. Hashing an IDFA is a silent no-match.
func NormalizeAndHash(p Provider, k Kind, raw string) (string, bool) {
	n, ok := Normalize(p, k, raw)
	if !ok {
		return "", false
	}
	if k == KindMobileID {
		return n, true
	}
	return Hash(n)
}

// normalizeEmail: trim and lower-case.
//
// Deliberately no provider-specific mailbox rewriting -- no stripping dots
// from gmail addresses, no cutting at a plus sign. Those transformations are
// folklore that outlived the documentation, and applying one unilaterally
// changes the digest away from what the platform computes for the same person.
func normalizeEmail(v string) (string, bool) {
	e := strings.ToLower(v)
	at := strings.IndexByte(e, '@')
	// A minimal sanity check. Something with no @ is not an address, and
	// hashing it wastes a slot in the upload.
	if at <= 0 || at == len(e)-1 {
		return "", false
	}
	return e, true
}

// normalizePhone keeps digits, then applies the platform's own convention.
//
//	Meta:   digits only, country code included, no plus.
//	Google: E.164, which means a leading plus.
//
// A number with no country code cannot be made into either, and guessing one
// from the Partner's locale would silently mis-match every customer who
// happens to be abroad.
func normalizePhone(p Provider, v string) (string, bool) {
	var digits strings.Builder
	for _, r := range v {
		if unicode.IsDigit(r) {
			digits.WriteRune(r)
		}
	}
	d := digits.String()

	// Shortest plausible international number is 8 digits; longest is 15
	// (E.164). Outside that range it is an extension, an internal id, or junk.
	if len(d) < 8 || len(d) > 15 {
		return "", false
	}

	if p == ProviderGoogle {
		return "+" + d, true
	}
	return d, true
}

// normalizeName: lower-case, punctuation removed, whitespace collapsed.
//
// Accents are LEFT ALONE. Stripping them would turn "José" into "jose", which
// matches only if the platform did the same thing -- and both document
// keeping the character as written.
func normalizeName(v string) (string, bool) {
	var b strings.Builder
	lastWasSpace := false
	for _, r := range strings.ToLower(v) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
			lastWasSpace = false
		case unicode.IsSpace(r):
			if !lastWasSpace && b.Len() > 0 {
				b.WriteRune(' ')
				lastWasSpace = true
			}
		default:
			// Punctuation dropped: "o'brien" and "obrien" must agree.
		}
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return "", false
	}
	return out, true
}

// normalizeCountry: the two-letter ISO 3166-1 alpha-2 code, lower-cased.
func normalizeCountry(v string) (string, bool) {
	c := strings.ToLower(strings.TrimSpace(v))
	if len(c) != 2 {
		return "", false
	}
	for _, r := range c {
		if !unicode.IsLetter(r) {
			return "", false
		}
	}
	return c, true
}

// normalizeZip: lower-cased, spaces and hyphens removed.
//
// US ZIP+4 is cut back to the leading five digits, which is what both
// platforms match on; keeping the +4 produces a digest that matches nothing.
// Non-US postcodes are left whole, because their length is not a suffix
// convention and truncating them would corrupt them.
func normalizeZip(p Provider, v string) (string, bool) {
	var b strings.Builder
	for _, r := range strings.ToLower(v) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	z := b.String()
	if z == "" {
		return "", false
	}

	// A 9-digit all-numeric value is ZIP+4.
	if len(z) == 9 && allDigits(z) {
		return z[:5], true
	}
	return z, true
}

func allDigits(s string) bool {
	for _, r := range s {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}
