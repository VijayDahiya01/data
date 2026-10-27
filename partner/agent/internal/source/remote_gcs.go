package source

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// gcsStore reads a folder in a Google Cloud Storage bucket with a service
// account's key: the JSON file Google gives out, pasted on the setup page and
// kept sealed. Google's token exchange (a signed JWT for an access token) is
// done here, read-only scope, rather than through a client library.
type gcsStore struct {
	bucket, prefix string
	api            string // https://storage.googleapis.com, or a test server
	key            serviceAccount
	http           *http.Client

	mu      sync.Mutex
	token   string
	expires time.Time
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
	return &gcsStore{bucket: cfg.Bucket, prefix: strings.Trim(cfg.Path, "/"), api: api, key: sa,
		http: &http.Client{Timeout: 10 * time.Minute}}, nil
}

// accessToken exchanges a signed JWT for a short-lived token, kept until a
// minute before it expires.
func (s *gcsStore) accessToken(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token != "" && time.Now().Before(s.expires.Add(-time.Minute)) {
		return s.token, nil
	}
	now := time.Now()
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{
		"iss": s.key.ClientEmail, "scope": googleReadOnly, "aud": s.key.TokenURI,
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	unsigned := header + "." + enc.EncodeToString(claims)
	sum := sha256.Sum256([]byte(unsigned))
	sig, err := rsa.SignPKCS1v15(rand.Reader, s.key.rsa, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion": {unsigned + "." + enc.EncodeToString(sig)}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.key.TokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := s.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error_description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&tok); err != nil || tok.AccessToken == "" {
		return "", fmt.Errorf("Google refused the service account (%d): %s", res.StatusCode, tok.Error)
	}
	s.token, s.expires = tok.AccessToken, now.Add(time.Duration(tok.ExpiresIn)*time.Second)
	return s.token, nil
}

func (s *gcsStore) get(ctx context.Context, u string) (*http.Response, error) {
	token, err := s.accessToken(ctx)
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
