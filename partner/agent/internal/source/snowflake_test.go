package source

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSnowflakeTables(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	var polled atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A key-pair JWT for user READER.
		parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
		if len(parts) != 3 || r.Header.Get("X-Snowflake-Authorization-Token-Type") != "KEYPAIR_JWT" {
			http.Error(w, `{"message":"no token"}`, http.StatusUnauthorized)
			return
		}
		claims, _ := base64.RawURLEncoding.DecodeString(parts[1])
		var c map[string]any
		_ = json.Unmarshal(claims, &c)
		if !strings.HasSuffix(fmt.Sprint(c["sub"]), ".READER") || !strings.Contains(fmt.Sprint(c["iss"]), ".READER.SHA256:") {
			http.Error(w, `{"message":"bad claims"}`, http.StatusUnauthorized)
			return
		}
		meta := func(cols string, parts int) string {
			p := strings.Repeat(`{},`, parts)
			return `"resultSetMetaData":{"partitionInfo":[` + strings.TrimSuffix(p, ",") + `],"rowType":[` + cols + `]}`
		}
		if r.Method == http.MethodGet {
			switch {
			case strings.HasSuffix(r.URL.Path, "/slow") && !polled.Load():
				polled.Store(true)
				fmt.Fprint(w, `{"statementHandle":"slow",`+meta(`{"name":"1","type":"fixed"}`, 1)+`,"data":[["1"]]}`)
			case r.URL.Query().Get("partition") == "1":
				fmt.Fprint(w, `{"data":[["C2","7305","1754000000.000000000",null]]}`)
			}
			return
		}
		var body struct {
			Statement string `json:"statement"`
			Database  string `json:"database"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch {
		case body.Statement == "SELECT 1":
			// Still running at first: the Agent asks again.
			w.WriteHeader(http.StatusAccepted)
			fmt.Fprint(w, `{"statementHandle":"slow","statementStatusUrl":"/api/v2/statements/slow"}`)
		case strings.Contains(body.Statement, "information_schema.tables"):
			fmt.Fprint(w, `{"statementHandle":"t",`+meta(`{"name":"TABLE_SCHEMA","type":"text"},{"name":"TABLE_NAME","type":"text"},{"name":"R","type":"fixed"}`, 1)+
				`,"data":[["CRM","CUSTOMERS","2"]]}`)
		case strings.Contains(body.Statement, `FROM "CRM"."CUSTOMERS"`):
			fmt.Fprint(w, `{"statementHandle":"h1",`+meta(`{"name":"ID","type":"text"},{"name":"DOB","type":"date"},{"name":"LAST_LOGIN","type":"timestamp_ntz"},{"name":"SEEN","type":"timestamp_tz"}`, 2)+
				`,"data":[["C1","8139","1756722600.500000000","1756708200.000000000 1770"]]}`)
		default:
			http.Error(w, `{"message":"unexpected"}`, http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	ctx := context.Background()
	src, err := Open(ctx, Config{Kind: Snowflake, Host: srv.URL, User: "reader", Password: pemKey, Database: "SHOP"})
	if err != nil {
		t.Fatal(err)
	}
	var rows []Row
	if err := src.Stream(ctx, "CRM.CUSTOMERS", []string{"ID", "DOB", "LAST_LOGIN", "SEEN"}, func(r Row) error {
		rows = append(rows, r)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows from both partitions: %v", rows)
	}
	// 8139 days after 1970 is 14 April 1992; a timestamp without a zone is
	// wall-clock text; one with a zone is a moment.
	if rows[0]["DOB"] != "1992-04-14" || rows[0]["LAST_LOGIN"] != "2025-09-01 10:30:00" ||
		!rows[0]["SEEN"].(time.Time).Equal(time.Unix(1756708200, 0)) || rows[1]["SEEN"] != nil {
		t.Errorf("values: %v", rows)
	}
	if _, err := src.Columns(ctx, "CRM.NOT_LISTED"); err == nil {
		t.Error("an unlisted table was read")
	}
}
