package source

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// The example in AWS's own Signature Version 4 documentation ("GET Object"):
// if this signature matches, S3 accepts what the Agent signs.
func TestSignatureV4MatchesAWSExample(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	req.Header.Set("Range", "bytes=0-9")
	signV4(req, "us-east-1", "s3", "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
		"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
		"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := req.Header.Get("Authorization"); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

const remoteCSV = "id,city\nC1,Mumbai\nC2,Pune\n"

// readAll reads the newest daily export through a remote source.
func readRemote(t *testing.T, st remoteStore) {
	t.Helper()
	ctx := context.Background()
	cache := t.TempDir()
	s := &remoteSource{store: st, cache: cache, files: &fileSource{folder: cache}, downloaded: map[string]string{}}
	tables, err := s.Tables(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) != 1 || tables[0].Name != "customers_*.csv" {
		t.Fatalf("tables: %+v", tables)
	}
	var cities []any
	if err := s.Stream(ctx, "customers_*.csv", []string{"id", "city"}, func(r Row) error {
		cities = append(cities, r["city"])
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(cities) != 2 || cities[0] != "Mumbai" {
		t.Errorf("read %v", cities)
	}
}

func TestS3Folder(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=AKID/") {
			http.Error(w, "unsigned", http.StatusForbidden)
			return
		}
		switch {
		case r.URL.Path == "/shop-exports/" && r.URL.Query().Get("list-type") == "2":
			if r.URL.Query().Get("prefix") != "daily/" {
				t.Errorf("prefix %q", r.URL.Query().Get("prefix"))
			}
			fmt.Fprint(w, `<ListBucketResult><Contents><Key>daily/customers_2026-10-26.csv</Key><Size>10</Size><ETag>"a"</ETag></Contents>`+
				`<Contents><Key>daily/customers_2026-10-27.csv</Key><Size>29</Size><ETag>"b"</ETag></Contents>`+
				`<IsTruncated>false</IsTruncated></ListBucketResult>`)
		case r.URL.Path == "/shop-exports/daily/customers_2026-10-27.csv":
			fmt.Fprint(w, remoteCSV)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	st, err := openS3(Config{Kind: S3, Host: srv.URL, Bucket: "shop-exports", Path: "daily", User: "AKID", Password: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	readRemote(t, st)
}

func TestAzureFolder(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("sig") != "abc" {
			http.Error(w, "no SAS", http.StatusForbidden)
			return
		}
		switch {
		case r.URL.Query().Get("comp") == "list":
			fmt.Fprint(w, `<EnumerationResults><Blobs><Blob><Name>customers_2026-10-27.csv</Name><Properties>`+
				`<Content-Length>29</Content-Length><Etag>e1</Etag></Properties></Blob>`+
				`<Blob><Name>customers_2026-10-25.csv</Name><Properties><Etag>e0</Etag></Properties></Blob></Blobs>`+
				`<NextMarker/></EnumerationResults>`)
		case r.URL.Path == "/exports/customers_2026-10-27.csv":
			fmt.Fprint(w, remoteCSV)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	if _, err := openAzure(Config{URI: srv.URL + "/exports"}); err == nil {
		t.Error("a link without a signature was accepted")
	}
	st, err := openAzure(Config{URI: srv.URL + "/exports?sv=2022-11-02&sp=rl&sig=abc"})
	if err != nil {
		t.Fatal(err)
	}
	st.http = srv.Client()
	readRemote(t, st)
}

func TestCloudStorageFolder(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/token":
			_ = r.ParseForm()
			parts := strings.Split(r.PostForm.Get("assertion"), ".")
			if len(parts) != 3 || r.PostForm.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
				http.Error(w, "bad assertion", http.StatusBadRequest)
				return
			}
			fmt.Fprint(w, `{"access_token":"tok","expires_in":3600}`)
		case r.Header.Get("Authorization") != "Bearer tok":
			http.Error(w, "no token", http.StatusUnauthorized)
		case r.URL.Path == "/storage/v1/b/exports/o" && r.URL.Query().Get("alt") == "":
			fmt.Fprint(w, `{"items":[{"name":"daily/customers_2026-10-27.csv","size":"29","etag":"x"},`+
				`{"name":"daily/customers_2026-10-20.csv","size":"9","etag":"y"}]}`)
		case r.URL.Query().Get("alt") == "media" && strings.HasSuffix(r.URL.Path, "customers_2026-10-27.csv"):
			fmt.Fprint(w, remoteCSV)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	sa, _ := json.Marshal(map[string]string{"client_email": "agent@p.iam.gserviceaccount.com",
		"private_key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"token_uri":   srv.URL + "/token"})
	st, err := openGCS(context.Background(), Config{Bucket: "exports", Path: "daily", Password: string(sa), Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	readRemote(t, st)
}

// An SFTP server in the test: password sign-in, the export folder served.
func sftpServer(t *testing.T, dir string, hostKey ssh.Signer) string {
	t.Helper()
	conf := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
		if c.User() == "partner" && string(pass) == "s3cret" {
			return nil, nil
		}
		return nil, errors.New("no")
	}}
	conf.AddHostKey(hostKey)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(nc, conf)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nch := range chans {
					ch, requests, err := nch.Accept()
					if err != nil {
						return
					}
					go func() {
						for req := range requests {
							ok := req.Type == "subsystem" && bytes.Equal(req.Payload[4:], []byte("sftp"))
							_ = req.Reply(ok, nil)
							if ok {
								server, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(dir), sftp.ReadOnly())
								if err == nil {
									_ = server.Serve()
								}
								_ = ch.Close()
							}
						}
					}()
				}
			}()
		}
	}()
	return ln.Addr().String()
}

func TestSFTPFolderPinsTheServerKey(t *testing.T) {
	dir := t.TempDir()
	exports := filepath.Join(dir, "exports")
	_ = os.MkdirAll(exports, 0o755)
	for name, body := range map[string]string{"customers_2026-10-27.csv": remoteCSV, "customers_2026-10-24.csv": "id,city\nC9,Agra\n"} {
		if err := os.WriteFile(filepath.Join(exports, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(priv)
	addr := sftpServer(t, dir, signer)
	host, port, _ := net.SplitHostPort(addr)
	var p int
	fmt.Sscan(port, &p)
	ctx := context.Background()
	cfg := Config{Kind: SFTP, Host: host, Port: p, User: "partner", Password: "s3cret", Path: "exports"}

	// First connection: the key is recorded.
	st, err := openSFTP(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if st.SeenHostKey != ssh.FingerprintSHA256(signer.PublicKey()) {
		t.Errorf("seen key %q", st.SeenHostKey)
	}
	readRemote(t, st)
	_ = st.close()

	// The same key again: fine. Another: refused before the password is sent.
	cfg.HostKey = ssh.FingerprintSHA256(signer.PublicKey())
	st, err = openSFTP(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	_ = st.close()
	cfg.HostKey = "SHA256:someone-else"
	if _, err := openSFTP(ctx, cfg); err == nil || !errors.Is(err, ErrHostKeyChanged) && !strings.Contains(err.Error(), "changed") {
		t.Errorf("a different server key: %v", err)
	}
	cfg.HostKey, cfg.Password = "", "wrong"
	if _, err := openSFTP(ctx, cfg); err == nil {
		t.Error("a wrong password signed in")
	}
}
