package setupui

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/oolix/partner-agent/internal/managed"
)

// A customer split over three tables: users, profiles, and WordPress-style
// key-value rows. The Partner adds the two extra tables on the setup page;
// the matches find age, gender and city in them; the copy holds all three.
func TestMoreTablesJoinedOnTheSetupPage(t *testing.T) {
	dsn := os.Getenv("OOLIX_TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("OOLIX_TEST_POSTGRES_URL not set")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, st := range []string{
		`DROP TABLE IF EXISTS shop_users, shop_profiles, shop_usermeta`,
		`CREATE TABLE shop_users (id integer PRIMARY KEY, email text, opted_in boolean)`,
		`CREATE TABLE shop_profiles (user_id integer, dob text)`,
		`CREATE TABLE shop_usermeta (umeta_id serial PRIMARY KEY, user_id integer, meta_key text, meta_value text)`,
		`INSERT INTO shop_users VALUES (1, 'a@x', true), (2, 'b@x', true), (3, 'c@x', false)`,
		`INSERT INTO shop_profiles VALUES (1, '14/04/1992'), (2, '01/05/1990'), (3, '02/02/1991')`,
		`INSERT INTO shop_usermeta (user_id, meta_key, meta_value) VALUES
		   (1, 'gender', 'F'), (1, 'billing_city', 'Bombay'), (1, 'nickname', 'a'),
		   (2, 'gender', 'M'), (2, 'billing_city', 'Pune')`,
	} {
		if _, err := db.Exec(st); err != nil {
			t.Fatal(err)
		}
	}

	h := newHarness(t)
	ctx := context.Background()
	h.post("/login", url.Values{"password": {"correct horse battery"}})
	csrf := h.csrf()
	h.post("/register", url.Values{"csrf": {csrf}, "code": {"one-time-code"}})
	if _, at, body := h.post("/source", url.Values{"csrf": {csrf}, "kind": {"postgres"}, "uri": {dsn},
		"location": {"Asia/Kolkata"}}); at != "/table?notice=connected" {
		t.Fatalf("source ended at %s: %s", at, body)
	}
	h.post("/table", url.Values{"csrf": {csrf}, "table": {"shop_users"}})
	h.post("/review", url.Values{"csrf": {csrf}, "id_column": {"id"}, "action": {"check"}})

	if _, body := h.get("/joins"); !strings.Contains(body, `<option value="shop_profiles">`) {
		t.Fatal("the other tables should be offered")
	}
	if _, at, _ := h.post("/joins", url.Values{"csrf": {csrf}, "action": {"choose"}, "table": {"shop_usermeta"}}); at != "/joins?table=shop_usermeta" {
		t.Fatalf("choose ended at %s", at)
	}
	_, body := h.get("/joins?table=shop_usermeta")
	for _, want := range []string{`<option value="user_id" selected>`, `<option value="meta_key" selected>`,
		`<option value="meta_value" selected>`, `value="billing_city"`} {
		if !strings.Contains(body, want) {
			t.Errorf("the key-value table's form lacks %q", want)
		}
	}

	for _, form := range []url.Values{
		{"table": {"shop_profiles"}, "key": {"user_id"}, "kind": {"one"}},
		{"table": {"shop_usermeta"}, "key": {"user_id"}, "kind": {"kv"}, "name_column": {"meta_key"},
			"value_column": {"meta_value"}, "fields": {"gender", "billing_city"}},
	} {
		form.Set("csrf", csrf)
		form.Set("action", "add")
		if _, at, _ := h.post("/joins", form); at != "/review?notice=joined" {
			t.Fatalf("adding %s ended at %s", form.Get("table"), at)
		}
	}
	draft, _ := managed.Settings{Store: h.store}.Draft(ctx)
	for key, col := range map[string]string{"age": "shop_profiles.dob", "gender": "shop_usermeta.gender",
		"city": "shop_usermeta.billing_city"} {
		if draft.Attributes[key].Column != col {
			t.Errorf("%s matched to %q, want %q", key, draft.Attributes[key].Column, col)
		}
	}
	if _, body := h.get("/review"); !strings.Contains(body, "Add more tables</a> (2 added)") {
		t.Error("the review page should count the added tables")
	}

	// The matches as suggested, then publish and copy.
	form := url.Values{"csrf": {csrf}, "id_column": {"id"}, "action": {"next"}}
	for key, am := range draft.Attributes {
		form.Set("col_"+key, am.Column)
		form.Set("publish_"+key, "on")
	}
	form.Set("order_age", "day")
	if _, at, _ := h.post("/review", form); at != "/activity" {
		t.Fatalf("review ended at %s", at)
	}
	if _, at, body := h.post("/consent", url.Values{"csrf": {csrf}, "consent_column": {"opted_in"}, "web": {"on"},
		"sync_hour": {"3"}, "action": {"publish"}}); at != "/?notice=publishing" {
		t.Fatalf("publish ended at %s: %s", at, body)
	}
	rep, err := h.runner.SyncOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Customers != 2 || rep.Attributes["age"].Filled != 2 || rep.Attributes["gender"].Filled != 2 ||
		rep.Attributes["city"].Filled != 2 {
		t.Errorf("sync: %+v", rep)
	}
	var city string
	_ = h.store.Pool.QueryRow(ctx, `SELECT city FROM oolix_audience_attributes WHERE partner_user_id = $1`,
		h.store.ScrambleID("1")).Scan(&city)
	if city != "MUMBAI" {
		t.Errorf("customer 1's city from the key-value table: %q", city)
	}
}
