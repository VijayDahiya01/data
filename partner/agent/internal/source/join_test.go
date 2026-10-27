package source

import (
	"context"
	"os"
	"testing"
)

// A customer split over four tables, read as one row each.
func TestJoinedTablesReadAsOneRow(t *testing.T) {
	url := os.Getenv("OOLIX_TEST_POSTGRES_URL")
	if url == "" {
		t.Skip("OOLIX_TEST_POSTGRES_URL not set")
	}
	sqlFixture(t, "pgx", url,
		`DROP TABLE IF EXISTS join_users, join_profiles, join_addresses, join_usermeta`,
		`CREATE TABLE join_users (id integer PRIMARY KEY, email text)`,
		`CREATE TABLE join_profiles (user_id integer, dob text)`,
		`CREATE TABLE join_addresses (user_id integer, city text, updated_at timestamp)`,
		`CREATE TABLE join_usermeta (umeta_id serial PRIMARY KEY, user_id integer, meta_key text, meta_value text)`,
		`INSERT INTO join_users VALUES (1, 'a@x'), (2, 'b@x'), (3, 'c@x')`,
		`INSERT INTO join_profiles VALUES (1, '14/04/1992'), (2, '1990-05-01')`,
		`INSERT INTO join_addresses VALUES (1, 'Pune', '2025-01-01'), (1, 'Mumbai', '2026-01-01'), (3, 'Delhi', '2024-01-01')`,
		`INSERT INTO join_usermeta (user_id, meta_key, meta_value) VALUES
		   (1, 'billing_city', 'Thane'), (1, 'gender', 'F'), (2, 'gender', 'M'), (2, 'nickname', 'b')`)

	ctx := context.Background()
	src, err := Open(ctx, Config{Kind: Postgres, URI: url})
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	src.(*sqlSource).pageSize = 2

	joins := []Join{
		{Table: "join_profiles", Key: "user_id"},
		{Table: "join_addresses", Key: "user_id", Latest: "updated_at"},
		{Table: "join_usermeta", Key: "user_id", NameColumn: "meta_key", ValueColumn: "meta_value",
			Fields: []string{"gender", "billing_city"}},
	}
	got := map[any]Row{}
	err = StreamJoined(ctx, src, "join_users", "id",
		[]string{"id", "join_profiles.dob", "join_addresses.city", "join_usermeta.gender"}, joins,
		func(r Row) error {
			got[r["id"]] = r
			return nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("rows: %v", got)
	}
	for id, want := range map[int64]map[string]any{
		1: {"join_profiles.dob": "14/04/1992", "join_addresses.city": "Mumbai", "join_usermeta.gender": "F"},
		2: {"join_profiles.dob": "1990-05-01", "join_addresses.city": nil, "join_usermeta.gender": "M"},
		3: {"join_profiles.dob": nil, "join_addresses.city": "Delhi", "join_usermeta.gender": nil},
	} {
		for col, v := range want {
			if got[id][col] != v {
				t.Errorf("customer %d %s = %v, want %v", id, col, got[id][col], v)
			}
		}
	}

	sample, err := SampleJoined(ctx, src, "join_users", "id", joins, 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, col := range []string{"email", "join_profiles.dob", "join_addresses.city", "join_addresses.updated_at",
		"join_usermeta.billing_city"} {
		if _, ok := sample[col]; !ok {
			t.Errorf("sample lacks %s: %v", col, sample)
		}
	}
	if _, ok := sample["join_usermeta.nickname"]; ok {
		t.Error("a key-value field nobody chose was read")
	}
}
