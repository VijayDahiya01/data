package source

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/netx"
)

// gcsStore reads a folder in a Google Cloud Storage bucket with a service
// account's key: the JSON file Google gives out, pasted on the setup page and
// kept sealed. Google's token exchange (a signed JWT for an access token) is
// done here, read-only scope, rather than through a client library.
type gcsStore struct {
	bucket, prefix string
	api            string // https://storage.googleapis.com, or a test server
	auth           *googleAuth
	http           *http.Client
}

type serviceAccount struct {
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
	rsa         *rsa.PrivateKey
}

// googleReadOnly is the only access the Agent asks for.
const googleReadOnly = "https://www.googleapis.com/auth/devstorage.read_only"

func parseServiceAccount(text string) (serviceAccount, error) {
	var sa serviceAccount
	if err := json.Unmarshal([]byte(text), &sa); err != nil || sa.ClientEmail == "" || sa.PrivateKey == "" {
		return sa, errors.New("paste the service account's JSON key, as Google gives it out")
	}
	block, _ := pem.Decode([]byte(sa.PrivateKey))
	if block == nil {
		return sa, errors.New("the service account key has no private key in it")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return sa, fmt.Errorf("the service account's private key could not be read: %w", err)
	}
	k, ok := key.(*rsa.PrivateKey)
	if !ok {
		return sa, errors.New("the service account's private key is not an RSA key")
	}
	sa.rsa = k
	if sa.TokenURI == "" {
		sa.TokenURI = "https://oauth2.googleapis.com/token"
	}
	return sa, nil
}

func openGCS(_ context.Context, cfg Config) (*gcsStore, error) {
	if cfg.Bucket == "" {
		return nil, errors.New("a Cloud Storage folder needs the bucket")
	}
	sa, err := parseServiceAccount(cfg.Password)
	if err != nil {
		return nil, err
	}
	api := "https://storage.googleapis.com"
	if cfg.Host != "" {
		api = strings.TrimRight(cfg.Host, "/")
	}
	client := netx.Client(10 * time.Minute)
	return &gcsStore{bucket: cfg.Bucket, prefix: strings.Trim(cfg.Path, "/"), api: api,
		auth: newGoogleAuth(sa, googleReadOnly, client), http: client}, nil
}

func (s *gcsStore) get(ctx context.Context, u string) (*http.Response, error) {
	token, err := s.auth.token(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		_ = res.Body.Close()
		return nil, fmt.Errorf("Cloud Storage answered %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	return res, nil
}

func (s *gcsStore) list(ctx context.Context) ([]remoteFile, error) {
	var out []remoteFile
	page := ""
	for {
		q := url.Values{"delimiter": {"/"}}
		if s.prefix != "" {
			q.Set("prefix", s.prefix+"/")
		}
		if page != "" {
			q.Set("pageToken", page)
		}
		res, err := s.get(ctx, s.api+"/storage/v1/b/"+url.PathEscape(s.bucket)+"/o?"+q.Encode())
		if err != nil {
			return nil, err
		}
		var body struct {
			Items []struct {
				Name    string `json:"name"`
				Size    string `json:"size"`
				Updated string `json:"updated"`
				Etag    string `json:"etag"`
			} `json:"items"`
			NextPageToken string `json:"nextPageToken"`
		}
		err = json.NewDecoder(res.Body).Decode(&body)
		_ = res.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("reading the bucket listing: %w", err)
		}
		for _, it := range body.Items {
			name := it.Name
			if s.prefix != "" {
				name = strings.TrimPrefix(name, s.prefix+"/")
			}
			var size int64
			fmt.Sscan(it.Size, &size)
			updated, _ := time.Parse(time.RFC3339, it.Updated)
			out = append(out, remoteFile{Name: name, Size: size, Modified: updated, Tag: it.Etag})
		}
		if body.NextPageToken == "" {
			return out, nil
		}
		page = body.NextPageToken
	}
}

func (s *gcsStore) fetch(ctx context.Context, name string, w io.Writer) error {
	res, err := s.get(ctx, s.api+"/storage/v1/b/"+url.PathEscape(s.bucket)+"/o/"+
		url.PathEscape(joinPrefix(s.prefix, name))+"?alt=media")
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, err = io.Copy(w, res.Body)
	return err
}

func (s *gcsStore) close() error { return nil }
