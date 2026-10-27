package source

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// s3Store reads a folder in an S3 bucket -- or any store that speaks the S3
// API (MinIO, Cloudflare R2, Wasabi), through Host as the endpoint. Requests
// are signed with AWS Signature Version 4, written out here rather than
// bringing in an SDK of a few hundred packages for two calls.
type s3Store struct {
	base           string // https://bucket.s3.region.amazonaws.com, or endpoint/bucket
	host           string
	pathStyle      bool
	bucket, prefix string
	region         string
	key, secret    string
	http           *http.Client
	now            func() time.Time
}

func openS3(cfg Config) (*s3Store, error) {
	if cfg.Bucket == "" || cfg.User == "" || cfg.Password == "" {
		return nil, fmt.Errorf("an S3 folder needs the bucket, an access key ID and its secret")
	}
	region := cfg.Region
	if region == "" {
		region = "ap-south-1"
	}
	st := &s3Store{bucket: cfg.Bucket, prefix: strings.Trim(cfg.Path, "/"), region: region,
		key: cfg.User, secret: cfg.Password, http: &http.Client{Timeout: 10 * time.Minute}, now: time.Now}
	if cfg.Host != "" {
		// An S3-compatible endpoint: path-style addressing.
		endpoint := strings.TrimRight(cfg.Host, "/")
		if !strings.Contains(endpoint, "://") {
			endpoint = "https://" + endpoint
		}
		u, err := url.Parse(endpoint)
		if err != nil {
			return nil, fmt.Errorf("the endpoint is not a URL: %w", err)
		}
		st.base, st.host, st.pathStyle = endpoint+"/"+cfg.Bucket, u.Host, true
	} else {
		st.host = cfg.Bucket + ".s3." + region + ".amazonaws.com"
		st.base = "https://" + st.host
	}
	return st, nil
}

type s3List struct {
	Contents []struct {
		Key          string    `xml:"Key"`
		LastModified time.Time `xml:"LastModified"`
		ETag         string    `xml:"ETag"`
		Size         int64     `xml:"Size"`
	} `xml:"Contents"`
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
}

func (s *s3Store) list(ctx context.Context) ([]remoteFile, error) {
	var out []remoteFile
	token := ""
	for {
		q := url.Values{"list-type": {"2"}, "delimiter": {"/"}}
		if s.prefix != "" {
			q.Set("prefix", s.prefix+"/")
		}
		if token != "" {
			q.Set("continuation-token", token)
		}
		res, err := s.do(ctx, "", q)
		if err != nil {
			return nil, err
		}
		var page s3List
		err = xml.NewDecoder(res.Body).Decode(&page)
		_ = res.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("reading the bucket listing: %w", err)
		}
		for _, c := range page.Contents {
			name := strings.TrimPrefix(c.Key, s.prefix+"/")
			if s.prefix == "" {
				name = c.Key
			}
			if name == "" || strings.HasSuffix(name, "/") {
				continue
			}
			out = append(out, remoteFile{Name: name, Size: c.Size, Modified: c.LastModified, Tag: c.ETag})
		}
		if !page.IsTruncated || page.NextContinuationToken == "" {
			return out, nil
		}
		token = page.NextContinuationToken
	}
}

func (s *s3Store) fetch(ctx context.Context, name string, w io.Writer) error {
	res, err := s.do(ctx, joinPrefix(s.prefix, name), nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, err = io.Copy(w, res.Body)
	return err
}

func (s *s3Store) close() error { return nil }

// do sends a signed GET for an object key ("" for the bucket itself).
func (s *s3Store) do(ctx context.Context, key string, q url.Values) (*http.Response, error) {
	u := s.base + "/" + awsEscape(key, true)
	if len(q) > 0 {
		u += "?" + canonicalQuery(q)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Host = s.host
	signV4(req, s.region, "s3", s.key, s.secret, s.now())
	res, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		_ = res.Body.Close()
		return nil, fmt.Errorf("S3 answered %d: %s", res.StatusCode, s3Message(body))
	}
	return res, nil
}

func s3Message(body []byte) string {
	var e struct {
		Code    string `xml:"Code"`
		Message string `xml:"Message"`
	}
	if xml.Unmarshal(body, &e) == nil && e.Code != "" {
		return e.Code + ": " + e.Message
	}
	return strings.TrimSpace(string(body))
}

// emptySHA256 is the SHA-256 of an empty body: every request here is a GET.
const emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// signV4 signs a request with AWS Signature Version 4, signing the host and
// every x-amz-* and range header.
func signV4(req *http.Request, region, service, key, secret string, now time.Time) {
	amzDate := now.UTC().Format("20060102T150405Z")
	day := amzDate[:8]
	if req.Header.Get("x-amz-content-sha256") == "" {
		req.Header.Set("x-amz-content-sha256", emptySHA256)
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
		canonicalQuery(req.URL.Query()),
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

// canonicalQuery sorts parameters and escapes them as SigV4 wants: RFC 3986,
// a space as %20.
func canonicalQuery(q url.Values) string {
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
			parts = append(parts, awsEscape(k, false)+"="+awsEscape(v, false))
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

// awsEscape escapes per RFC 3986 as SigV4 wants: a key keeps its "/", a query
// parameter does not.
func awsEscape(s string, key bool) string {
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
