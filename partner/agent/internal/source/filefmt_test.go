package source

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestJSONLinesAndDailyExports(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"customers_2026-10-26.csv": "id,city\nC1,Pune\n",
		"customers_2026-10-27.csv": "id,city\nC1,Mumbai\nC2,Delhi\n",
		"customers_20261025.csv":   "id,city\nC0,Chennai\n",
		"report_2026-10-27.csv":    "x\n1\n",
		"events.jsonl": `{"id": "E1", "profile": {"dob": "14/04/1992"}, "orders": 3, "addresses": [{"city": "Pune"}, {"city": "Mumbai", "is_default": true}]}
{"id": "E2", "app_user": true}

{"id": "E3", "tags": ["gold", "early"]}
`,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	src, err := Open(ctx, Config{Kind: File, Folder: dir})
	if err != nil {
		t.Fatal(err)
	}
	tables, err := src.Tables(ctx)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tb := range tables {
		names[tb.Name] = true
	}
	// Three daily exports are one table; a lone dated report stays itself.
	if !names["customers_*.csv"] || names["customers_2026-10-27.csv"] || !names["report_2026-10-27.csv"] ||
		!names["events.jsonl"] {
		t.Fatalf("tables: %v", names)
	}

	var cities []any
	if err := src.Stream(ctx, "customers_*.csv", []string{"id", "city"}, func(r Row) error {
		cities = append(cities, r["city"])
		return nil
	}); err != nil || len(cities) != 2 || cities[0] != "Mumbai" {
		t.Errorf("the newest export should be read: %v %v", cities, err)
	}

	cols, err := src.Columns(ctx, "events.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, c := range cols {
		have[c.Name] = true
	}
	for _, want := range []string{"id", "profile.dob", "orders", "addresses.city", "app_user", "tags"} {
		if !have[want] {
			t.Errorf("JSON lines lack column %s: %v", want, have)
		}
	}
	rows := map[any]Row{}
	if err := src.Stream(ctx, "events.jsonl", []string{"id", "profile.dob", "orders", "addresses.city", "tags"},
		func(r Row) error {
			rows[r["id"]] = r
			return nil
		}); err != nil {
		t.Fatal(err)
	}
	if r := rows["E1"]; r["profile.dob"] != "14/04/1992" || r["orders"] != "3" || r["addresses.city"] != "Mumbai" {
		t.Errorf("E1: %v", r)
	}
	if rows["E3"]["tags"] != "gold" {
		t.Errorf("E3: %v", rows["E3"])
	}
}
