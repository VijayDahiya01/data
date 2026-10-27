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
)

// azureStore reads a folder in an Azure Blob container through a SAS link
// the Partner creates with read and list rights only -- the container's URL
// with a signature, so no account key is ever handed over. The link is a
// secret and is kept sealed, like a password.
type azureStore struct {
	container *url.URL // without the SAS
	sas       url.Values
	prefix    string
	http      *http.Client
}

func openAzure(cfg Config) (*azureStore, error) {
	u, err := url.Parse(strings.TrimSpace(cfg.URI))
	if err != nil || u.Scheme != "https" || u.Query().Get("sig") == "" {
		return nil, fmt.Errorf("paste the container's SAS URL: https://ACCOUNT.blob.core.windows.net/CONTAINER?sv=...&sig=...")
	}
	sas := u.Query()
	u.RawQuery = ""
	return &azureStore{container: u, sas: sas, prefix: strings.Trim(cfg.Path, "/"),
		http: &http.Client{Timeout: 10 * time.Minute}}, nil
}

type azureList struct {
	Blobs struct {
		Blob []struct {
			Name       string `xml:"Name"`
			Properties struct {
				LastModified  string `xml:"Last-Modified"`
				ContentLength int64  `xml:"Content-Length"`
				Etag          string `xml:"Etag"`
			} `xml:"Properties"`
		} `xml:"Blob"`
	} `xml:"Blobs"`
	NextMarker string `xml:"NextMarker"`
}

func (s *azureStore) list(ctx context.Context) ([]remoteFile, error) {
	var out []remoteFile
	marker := ""
	for {
		q := url.Values{"restype": {"container"}, "comp": {"list"}, "delimiter": {"/"}}
		if s.prefix != "" {
			q.Set("prefix", s.prefix+"/")
		}
		if marker != "" {
			q.Set("marker", marker)
		}
		res, err := s.get(ctx, s.container.String(), q)
		if err != nil {
			return nil, err
		}
		var page azureList
		err = xml.NewDecoder(res.Body).Decode(&page)
		_ = res.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("reading the container listing: %w", err)
		}
		for _, b := range page.Blobs.Blob {
			name := b.Name
			if s.prefix != "" {
				name = strings.TrimPrefix(name, s.prefix+"/")
			}
			modified, _ := time.Parse(time.RFC1123, b.Properties.LastModified)
			out = append(out, remoteFile{Name: name, Size: b.Properties.ContentLength, Modified: modified,
				Tag: b.Properties.Etag})
		}
		if page.NextMarker == "" {
			return out, nil
		}
		marker = page.NextMarker
	}
}

func (s *azureStore) fetch(ctx context.Context, name string, w io.Writer) error {
	blob := *s.container
	blob.Path = strings.TrimRight(blob.Path, "/") + "/" + joinPrefix(s.prefix, name)
	res, err := s.get(ctx, blob.String(), nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, err = io.Copy(w, res.Body)
	return err
}

func (s *azureStore) close() error { return nil }

func (s *azureStore) get(ctx context.Context, base string, q url.Values) (*http.Response, error) {
	all := url.Values{}
	for k, v := range s.sas {
		all[k] = v
	}
	for k, v := range q {
		all[k] = v
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"?"+all.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-ms-version", "2021-12-02")
	res, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		_ = res.Body.Close()
		return nil, fmt.Errorf("Azure answered %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	return res, nil
}
