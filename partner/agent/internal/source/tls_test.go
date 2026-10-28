package source

import (
	"net/url"
	"strings"
	"testing"
)

// An Agent hosted in an enclave connects to databases only with the server's
// certificate checked: its host carries the bytes and must see only
// ciphertext.
func TestVerifiedTLSIsForcedWhereRequired(t *testing.T) {
	for _, c := range []struct {
		cfg     Config
		ok      bool
		wantTLS string
	}{
		{Config{Kind: Postgres, Host: "db", TLS: "prefer"}, true, "verify"},
		{Config{Kind: MySQL, Host: "db", TLS: "disable"}, true, "verify"},
		{Config{Kind: SQLServer, Host: "db", TLS: "require"}, true, "verify"},
		{Config{Kind: Oracle, Host: "db"}, true, "verify"},
		{Config{Kind: MongoDB, Host: "db"}, true, "verify"},
		{Config{Kind: Postgres, URI: "postgres://u:p@db/x?sslmode=disable"}, false, ""},
		{Config{Kind: MongoDB, URI: "mongodb://db:27017"}, false, ""},
		{Config{Kind: MongoDB, URI: "mongodb+srv://cluster.example.net/?tlsInsecure=true"}, false, ""},
		{Config{Kind: MongoDB, URI: "mongodb+srv://cluster.example.net/"}, true, ""},
		{Config{Kind: S3, Host: "s3.amazonaws.com"}, true, ""}, // HTTPS already
	} {
		got, err := verifiedTLS(c.cfg)
		if (err == nil) != c.ok {
			t.Errorf("%s %q: error %v", c.cfg.Kind, c.cfg.URI, err)
			continue
		}
		if err == nil && got.TLS != c.wantTLS {
			t.Errorf("%s: TLS %q, want %q", c.cfg.Kind, got.TLS, c.wantTLS)
		}
	}

	pg, _ := url.Parse(postgresURL(Config{Kind: Postgres, Host: "db", TLS: "verify"}))
	if pg.Query().Get("sslmode") != "verify-full" {
		t.Errorf("postgres: %s", pg)
	}
	ms := sqlServerURL(Config{Kind: SQLServer, Host: "db", TLS: "verify"})
	if !strings.Contains(ms, "encrypt=true") || !strings.Contains(ms, "TrustServerCertificate=false") {
		t.Errorf("sql server: %s", ms)
	}
	// go-ora writes its option names as they are, space and all.
	if o := oracleURL(Config{Kind: Oracle, Host: "db", Database: "FREEPDB1", TLS: "verify"}); !strings.Contains(
		strings.ToUpper(o), "SSL VERIFY=TRUE") {
		t.Errorf("oracle: %s", o)
	}
}
