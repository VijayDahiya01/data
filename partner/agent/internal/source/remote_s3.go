package source

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/awssig"
	"github.com/oolix/partner-agent/internal/netx"
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
		key: cfg.User, secret: cfg.Password, http: netx.Client(10 * time.Minute), now: time.Now}
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
	u := s.base + "/" + awssig.Escape(key, true)
	if len(q) > 0 {
		u += "?" + awssig.Query(q)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Host = s.host
	awssig.Sign(req, s.region, "s3", s.key, s.secret, s.now())
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
