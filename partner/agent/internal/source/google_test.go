package source

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// googleFake serves Google's token exchange and hands the rest to api.
func googleFake(t *testing.T, api http.HandlerFunc) (*httptest.Server, string) {
	t.Helper()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			fmt.Fprint(w, `{"access_token":"tok","expires_in":3600}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "no token", http.StatusUnauthorized)
			return
		}
		api(w, r)
	}))
	t.Cleanup(srv.Close)
	sa, _ := json.Marshal(map[string]string{"client_email": "agent@p.iam.gserviceaccount.com",
		"private_key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"token_uri":   srv.URL + "/token"})
	return srv, string(sa)
}

func TestBigQueryDataset(t *testing.T) {
	const base = "/bigquery/v2/projects/p1/datasets/shop"
	fields := `{"fields":[{"name":"id","type":"STRING"},{"name":"profile","type":"RECORD","fields":[{"name":"dob","type":"DATE"}]},` +
		`{"name":"last_login","type":"TIMESTAMP"},{"name":"tags","type":"STRING","mode":"REPEATED"},{"name":"email","type":"STRING"}]}`
	row := func(id, dob, micros string) string {
		return `{"f":[{"v":"` + id + `"},{"v":{"f":[{"v":"` + dob + `"}]}},{"v":"` + micros + `"},{"v":[{"v":"gold"}]},{"v":"x@y"}]}`
	}
	srv, sa := googleFake(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == base:
			fmt.Fprint(w, `{}`)
		case r.URL.Path == base+"/tables":
			fmt.Fprint(w, `{"tables":[{"tableReference":{"tableId":"customers"}},{"tableReference":{"tableId":"active_view"}}]}`)
		case r.URL.Path == base+"/tables/customers":
			fmt.Fprint(w, `{"type":"TABLE","schema":`+fields+`}`)
		case r.URL.Path == base+"/tables/active_view":
			fmt.Fprint(w, `{"type":"VIEW","schema":`+fields+`}`)
		case r.URL.Path == base+"/tables/customers/data":
			if sel := r.URL.Query().Get("selectedFields"); sel == "id,profile,last_login" && r.URL.Query().Get("pageToken") == "" {
				fmt.Fprint(w, `{"rows":[`+row("C1", "1992-04-14", "1756708200000000")+`],"pageToken":"p2"}`)
			} else if r.URL.Query().Get("pageToken") == "p2" {
				fmt.Fprint(w, `{"rows":[`+row("C2", "1990-01-01", "1754000000000000")+`]}`)
			} else {
				fmt.Fprint(w, `{"rows":[`+row("C1", "1992-04-14", "1756708200000000")+`]}`)
			}
		case r.URL.Path == "/bigquery/v2/projects/p1/queries" && r.Method == http.MethodPost:
			fmt.Fprint(w, `{"jobComplete":true,"jobReference":{"jobId":"j1","location":"asia-south1"},"rows":[`+
				row("V1", "1985-05-05", "1756708200000000")+`]}`)
		default:
			http.NotFound(w, r)
		}
	})
	ctx := context.Background()
	src, err := Open(ctx, Config{Kind: BigQuery, Database: "p1", Path: "shop", Password: sa, Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	cols, err := src.Columns(ctx, "customers")
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]string{}
	for _, c := range cols {
		have[c.Name] = c.Type
	}
	if have["profile.dob"] != "date" || !TimeType(have["last_login"]) || have["tags"] == "" {
		t.Errorf("columns: %v", have)
	}
	var rows []Row
	if err := src.Stream(ctx, "customers", []string{"id", "profile.dob", "last_login"}, func(r Row) error {
		rows = append(rows, r)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0]["profile.dob"] != "1992-04-14" ||
		!rows[0]["last_login"].(time.Time).Equal(time.UnixMicro(1756708200000000)) {
		t.Errorf("rows: %v", rows)
	}
	if _, leaked := rows[0]["email"]; leaked {
		t.Error("a column nobody chose was read")
	}
	var view []Row
	if err := src.Stream(ctx, "active_view", []string{"id"}, func(r Row) error {
		view = append(view, r)
		return nil
	}); err != nil || len(view) != 1 || view[0]["id"] != "V1" {
		t.Errorf("a view is read through a query: %v %v", view, err)
	}
	if _, err := src.Columns(ctx, "INFORMATION_SCHEMA"); err == nil {
		t.Error("an unlisted table was read")
	}
}

func TestGoogleSheet(t *testing.T) {
	srv, sa := googleFake(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v4/spreadsheets/sheet123" && strings.Contains(r.URL.RawQuery, "fields"):
			fmt.Fprint(w, `{"sheets":[{"properties":{"title":"Customers","gridProperties":{"rowCount":3}}}]}`)
		case r.URL.Path == "/v4/spreadsheets/sheet123/values/'Customers'":
			fmt.Fprint(w, `{"values":[["id","dob","city"],["C1","14/04/1992","Mumbai"],["C2"]]}`)
		default:
			http.NotFound(w, r)
		}
	})
	ctx := context.Background()
	src, err := Open(ctx, Config{Kind: GoogleSheets, Password: sa, Host: srv.URL,
		Database: "https://docs.google.com/spreadsheets/d/sheet123/edit#gid=0"})
	if err != nil {
		t.Fatal(err)
	}
	tables, _ := src.Tables(ctx)
	if len(tables) != 1 || tables[0].Name != "Customers" || tables[0].Rows != 2 {
		t.Errorf("tables: %+v", tables)
	}
	var rows []Row
	if err := src.Stream(ctx, "Customers", []string{"id", "dob"}, func(r Row) error {
		rows = append(rows, r)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0]["dob"] != "14/04/1992" || rows[1]["dob"] != nil || rows[0]["city"] != nil {
		t.Errorf("rows: %v", rows)
	}
}
