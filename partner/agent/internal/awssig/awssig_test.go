package awssig

import (
	"net/http"
	"testing"
	"time"
)

// The example in AWS's own Signature Version 4 documentation ("GET Object"):
// if this signature matches, AWS accepts what the Agent signs.
func TestSignatureMatchesAWSExample(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	req.Header.Set("Range", "bytes=0-9")
	Sign(req, "us-east-1", "s3", "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
		"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
		"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := req.Header.Get("Authorization"); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestEscape(t *testing.T) {
	if got := Escape("exports/2026 10/a+b.csv", true); got != "exports/2026%2010/a%2Bb.csv" {
		t.Errorf("key: %s", got)
	}
	if got := Escape("a/b", false); got != "a%2Fb" {
		t.Errorf("query value: %s", got)
	}
}
