package channel

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

// The failure this file exists to prevent is silent.
//
// A wrong normalization still produces a valid SHA-256, the upload still
// succeeds, and the platform simply matches fewer people. Nothing errors.
// So these tests pin exact digests rather than asserting "a hash came back",
// and they check the two platforms separately because their rules differ.

func sha256hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestEmailNormalizationMatchesTheDocumentedRule(t *testing.T) {
	cases := []struct{ in, want string }{
		{"  Person@Example.COM  ", "person@example.com"},
		{"PERSON@EXAMPLE.COM", "person@example.com"},
		{"person@example.com", "person@example.com"},
	}
	for _, c := range cases {
		got, ok := Normalize(ProviderMeta, KindEmail, c.in)
		if !ok || got != c.want {
			t.Errorf("Normalize(%q) = %q,%v; want %q", c.in, got, ok, c.want)
		}
	}
}

func TestEmailMailboxIsNotRewritten(t *testing.T) {
	// Stripping dots from gmail, or cutting at a plus, is folklore that
	// outlived the documentation. Doing it unilaterally moves our digest away
	// from the one the platform computes for the same person.
	for _, in := range []string{"first.last@gmail.com", "user+tag@gmail.com"} {
		got, ok := Normalize(ProviderGoogle, KindEmail, in)
		if !ok {
			t.Fatalf("Normalize(%q) rejected a valid address", in)
		}
		if got != strings.ToLower(in) {
			t.Errorf("Normalize(%q) rewrote the mailbox to %q", in, got)
		}
	}
}

func TestUnusableValuesAreRejectedRatherThanHashedEmpty(t *testing.T) {
	// The single easiest way to upload a large audience that matches nobody is
	// to hash the empty string. It is a perfectly valid-looking digest.
	emptyDigest := sha256hex("")

	for _, tc := range []struct {
		kind Kind
		in   string
	}{
		{KindEmail, ""},
		{KindEmail, "   "},
		{KindEmail, "not-an-address"},
		{KindEmail, "@example.com"},
		{KindEmail, "person@"},
		{KindPhone, "12345"},            // too short to be international
		{KindPhone, "1234567890123456"}, // longer than E.164 allows
		{KindPhone, "ext. 4021"},
		{KindCountry, "GBR"},
		{KindCountry, "12"},
		{KindFirstName, "!!!"},
	} {
		if got, ok := NormalizeAndHash(ProviderMeta, tc.kind, tc.in); ok {
			t.Errorf("NormalizeAndHash(%s,%q) accepted it and returned %q", tc.kind, tc.in, got)
			if got == emptyDigest {
				t.Errorf("  and it was the empty-string digest")
			}
		}
	}

	if _, ok := Hash(""); ok {
		t.Error("Hash(\"\") must refuse rather than return the empty-string digest")
	}
}

func TestPhoneConventionDiffersByPlatform(t *testing.T) {
	// Meta wants bare digits with the country code; Google wants E.164 with a
	// leading plus. One shared normalizer would be wrong for one of them, and
	// the symptom would only be a lower match rate.
	const raw = "+1 (555) 010-2030"

	meta, ok := Normalize(ProviderMeta, KindPhone, raw)
	if !ok || meta != "15550102030" {
		t.Errorf("Meta phone = %q,%v; want 15550102030", meta, ok)
	}

	google, ok := Normalize(ProviderGoogle, KindPhone, raw)
	if !ok || google != "+15550102030" {
		t.Errorf("Google phone = %q,%v; want +15550102030", google, ok)
	}

	if sha256hex(meta) == sha256hex(google) {
		t.Error("the two platforms must not produce the same digest for a phone number")
	}
}

func TestNamePunctuationIsRemovedButAccentsSurvive(t *testing.T) {
	got, ok := Normalize(ProviderMeta, KindFirstName, "  O'Brien-Smith  ")
	if !ok || got != "obriensmith" {
		t.Errorf("name = %q,%v; want obriensmith", got, ok)
	}

	// Stripping the accent would only match if the platform did the same, and
	// both document keeping the character as written.
	accented, ok := Normalize(ProviderMeta, KindFirstName, "José")
	if !ok || accented != "josé" {
		t.Errorf("accented name = %q,%v; want josé", accented, ok)
	}
}

func TestZipPlusFourIsTruncatedButOtherPostcodesAreNot(t *testing.T) {
	got, ok := Normalize(ProviderMeta, KindZip, "94103-1234")
	if !ok || got != "94103" {
		t.Errorf("ZIP+4 = %q,%v; want 94103", got, ok)
	}

	// A UK postcode is not a suffix convention. Truncating it corrupts it.
	uk, ok := Normalize(ProviderMeta, KindZip, "SW1A 1AA")
	if !ok || uk != "sw1a1aa" {
		t.Errorf("UK postcode = %q,%v; want sw1a1aa", uk, ok)
	}
}

func TestMobileAdvertisingIdsAreNeverHashed(t *testing.T) {
	// Hashing an IDFA produces a value that matches nothing at either
	// platform, and the upload still succeeds.
	const idfa = "6D92078A-8246-4BA4-AE5B-76104861E7DC"

	got, ok := NormalizeAndHash(ProviderMeta, KindMobileID, idfa)
	if !ok {
		t.Fatal("mobile id was rejected")
	}
	if got != strings.ToLower(idfa) {
		t.Errorf("mobile id = %q; want the lower-cased id itself, unhashed", got)
	}
	if got == sha256hex(strings.ToLower(idfa)) {
		t.Error("mobile id was hashed")
	}
}

func TestHashIsLowerCaseHexSHA256(t *testing.T) {
	// Both platforms specify lower-case hex. Upper-case hex is a different
	// string and therefore a different match key.
	n, _ := Normalize(ProviderMeta, KindEmail, "Person@Example.com")
	got, ok := Hash(n)
	if !ok {
		t.Fatal("hash refused a valid value")
	}
	if got != sha256hex("person@example.com") {
		t.Errorf("digest = %q; want the SHA-256 of the normalized value", got)
	}
	if got != strings.ToLower(got) {
		t.Error("digest must be lower-case hex")
	}
	if len(got) != 64 {
		t.Errorf("digest length = %d; want 64", len(got))
	}
}

func TestNormalizationIsStableAcrossEquivalentInputs(t *testing.T) {
	// Two records that describe the same person must produce the same digest,
	// or the audience double-counts and matches at half the rate it should.
	variants := []string{
		"Person@Example.com",
		"  person@example.com  ",
		"PERSON@EXAMPLE.COM",
	}
	first, _ := NormalizeAndHash(ProviderMeta, KindEmail, variants[0])
	for _, v := range variants[1:] {
		got, _ := NormalizeAndHash(ProviderMeta, KindEmail, v)
		if got != first {
			t.Errorf("%q produced a different digest from %q", v, variants[0])
		}
	}
}
