// Package awssig signs requests with AWS Signature Version 4, written out here
// rather than bringing in an SDK of a few hundred packages for a handful of
// calls: S3 reads (package source) and KMS (package enclave).
package awssig

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// EmptySHA256 is the SHA-256 of an empty body.
const EmptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// PayloadHash is a body's SHA-256 as the x-amz-content-sha256 header carries it.
func PayloadHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// Sign signs a request, signing the host and every x-amz-* and range header.
// The body's hash comes from x-amz-content-sha256, set here to that of an
// empty body when missing.
func Sign(req *http.Request, region, service, key, secret string, now time.Time) {
	amzDate := now.UTC().Format("20060102T150405Z")
	day := amzDate[:8]
	if req.Header.Get("x-amz-content-sha256") == "" {
		req.Header.Set("x-amz-content-sha256", EmptySHA256)
	}
	req.Header.Set("x-amz-date", amzDate)

	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	headers := map[string]string{"host": host}
	for name, values := range req.Header {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-amz-") || lower == "range" {
			headers[lower] = strings.TrimSpace(strings.Join(values, ","))
		}
	}
	names := make([]string, 0, len(headers))
	for n := range headers {
		names = append(names, n)
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, n := range names {
		canonHeaders.WriteString(n + ":" + headers[n] + "\n")
	}
	signed := strings.Join(names, ";")

	canonical := strings.Join([]string{
		req.Method,
		canonicalPath(req.URL.EscapedPath()),
		Query(req.URL.Query()),
		canonHeaders.String(),
		signed,
		req.Header.Get("x-amz-content-sha256"),
	}, "\n")
	scope := day + "/" + region + "/" + service + "/aws4_request"
	sum := sha256.Sum256([]byte(canonical))
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(sum[:])

	k := hmacSHA256([]byte("AWS4"+secret), day)
	k = hmacSHA256(k, region)
	k = hmacSHA256(k, service)
	k = hmacSHA256(k, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(k, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+key+"/"+scope+
		", SignedHeaders="+signed+", Signature="+signature)
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// Query sorts parameters and escapes them as SigV4 wants: RFC 3986, a space
// as %20.
func Query(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			parts = append(parts, Escape(k, false)+"="+Escape(v, false))
		}
	}
	return strings.Join(parts, "&")
}

func canonicalPath(p string) string {
	if p == "" {
		return "/"
	}
	return p
}

// Escape escapes per RFC 3986 as SigV4 wants: a key keeps its "/", a query
// parameter does not.
func Escape(s string, key bool) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9',
			c == '-', c == '_', c == '.', c == '~', c == '/' && key:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
