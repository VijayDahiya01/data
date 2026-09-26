package source

// Connectors against real databases. Each runs only when its connection
// string is set, so `go test ./...` stays self-contained on a laptop; CI sets
// all four (see the Partner Agent job in .github/workflows/ci.yml):
//
//	OOLIX_TEST_POSTGRES_URL   postgres://user:pass@host:5432/db
//	OOLIX_TEST_MYSQL_URL      user:pass@tcp(host:3306)/db
//	OOLIX_TEST_SQLSERVER_URL  sqlserver://user:pass@host:1433?database=db
//	OOLIX_TEST_MONGODB_URL    mongodb://user:pass@host:27017/?authSource=admin
//
// The tests create their own table, named awkwardly on purpose -- a column
// called "DOB", another called "Last Login" -- because quoting is exactly
// what breaks when a connector meets a real schema.

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// The same three customers, in every database.
var fixtureIDs = []string{"C1", "C2", "C3"}

func sqlFixture(t *testing.T, driver, dsn string, stmts ...string) {
	t.Helper()
	db, err := sql.Open(driver, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
}

func TestPostgresSource(t *testing.T) {
	url := os.Getenv("OOLIX_TEST_POSTGRES_URL")
	if url == "" {
		t.Skip("OOLIX_TEST_POSTGRES_URL not set")
	}
	sqlFixture(t, "pgx", url,
		`DROP TABLE IF EXISTS crm_customers`,
		`CREATE TABLE crm_customers (id text PRIMARY KEY, "DOB" text, sex text, "Last Login" timestamp,
		   signed_up timestamptz, email text)`,
		`INSERT INTO crm_customers VALUES
		   ('C1', '14/04/1992', 'M', '2026-09-01 10:30:00', '2024-01-01T00:00:00Z', 'a@example.com'),
		   ('C2', '14-04-1993', 'F', '2026-08-01 00:00:00', NULL, 'b@example.com'),
		   ('C3', NULL, NULL, NULL, NULL, NULL)`)
	checkSource(t, Config{Kind: Postgres, URI: url}, "crm_customers", "DOB", "Last Login")

	// The connection itself refuses writes, not just the queries we choose
	// to send: a login that could write still cannot, through the Agent.
	s, err := Open(context.Background(), Config{Kind: Postgres, URI: url})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	err = s.(*sqlSource).read(context.Background(), `UPDATE crm_customers SET sex = 'X' RETURNING id`,
		func(Row) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Errorf("a write went through the Agent's connection: %v", err)
	}
}

func TestMySQLSource(t *testing.T) {
	dsn := os.Getenv("OOLIX_TEST_MYSQL_URL")
	if dsn == "" {
		t.Skip("OOLIX_TEST_MYSQL_URL not set")
	}
	sqlFixture(t, "mysql", dsn,
		"DROP TABLE IF EXISTS crm_customers",
		"CREATE TABLE crm_customers (id VARCHAR(10) PRIMARY KEY, `DOB` VARCHAR(20), sex VARCHAR(8), "+
			"`Last Login` DATETIME NULL, signed_up TIMESTAMP NULL, email VARCHAR(80))",
		"INSERT INTO crm_customers VALUES "+
			"('C1','14/04/1992','M','2026-09-01 10:30:00','2024-01-01 05:30:00','a@example.com'),"+
			"('C2','14-04-1993','F','2026-08-01 00:00:00',NULL,'b@example.com'),"+
			"('C3',NULL,NULL,NULL,NULL,NULL)")
	checkSource(t, Config{Kind: MySQL, URI: dsn}, "crm_customers", "DOB", "Last Login")

	s, err := Open(context.Background(), Config{Kind: MySQL, URI: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	err = s.(*sqlSource).read(context.Background(), "UPDATE crm_customers SET sex = 'X'",
		func(Row) error { return nil })
	if err == nil {
		t.Error("a write went through the Agent's read-only transaction")
	}
}

func TestSQLServerSource(t *testing.T) {
	url := os.Getenv("OOLIX_TEST_SQLSERVER_URL")
	if url == "" {
		t.Skip("OOLIX_TEST_SQLSERVER_URL not set")
	}
	sqlFixture(t, "sqlserver", url,
		"IF OBJECT_ID('dbo.crm_customers') IS NOT NULL DROP TABLE dbo.crm_customers",
		"CREATE TABLE dbo.crm_customers (id VARCHAR(10) PRIMARY KEY, [DOB] VARCHAR(20), sex VARCHAR(8), "+
			"[Last Login] DATETIME2 NULL, signed_up DATETIMEOFFSET NULL, email VARCHAR(80))",
		"INSERT INTO dbo.crm_customers VALUES "+
			"('C1','14/04/1992','M','2026-09-01 10:30:00','2024-01-01 05:30:00 +05:30','a@example.com'),"+
			"('C2','14-04-1993','F','2026-08-01 00:00:00',NULL,'b@example.com'),"+
			"('C3',NULL,NULL,NULL,NULL,NULL)")
	checkSource(t, Config{Kind: SQLServer, URI: url}, "crm_customers", "DOB", "Last Login")
}

func TestMongoSource(t *testing.T) {
	uri := os.Getenv("OOLIX_TEST_MONGODB_URL")
	if uri == "" {
		t.Skip("OOLIX_TEST_MONGODB_URL not set")
	}
	ctx := context.Background()
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Disconnect(ctx)
	coll := client.Database("oolix_source_test").Collection("crm_customers")
	_ = coll.Drop(ctx)
	_, err = coll.InsertMany(ctx, []any{
		bson.D{{Key: "_id", Value: "C1"}, {Key: "profile", Value: bson.D{{Key: "DOB", Value: "14/04/1992"}}},
			{Key: "sex", Value: "M"}, {Key: "Last Login", Value: time.Date(2026, 9, 1, 5, 0, 0, 0, time.UTC)},
			{Key: "tags", Value: bson.A{"a", "b"}}, {Key: "email", Value: "a@example.com"}},
		bson.D{{Key: "_id", Value: "C2"}, {Key: "profile", Value: bson.D{{Key: "DOB", Value: "14-04-1993"}}},
			{Key: "sex", Value: "F"}, {Key: "Last Login", Value: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)}},
		bson.D{{Key: "_id", Value: "C3"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{Kind: MongoDB, URI: uri, Database: "oolix_source_test"}
	checkSource(t, cfg, "crm_customers", "profile.DOB", "Last Login")

	// Nested fields are paths; lists are not columns.
	s, _ := Open(ctx, cfg)
	defer s.Close()
	cols, _ := s.Columns(ctx, "crm_customers")
	for _, c := range cols {
		if c.Name == "tags" || c.Name == "profile" {
			t.Errorf("column %q should not be offered", c.Name)
		}
	}
}

// checkSource runs what every connector must do, the same way.
func checkSource(t *testing.T, cfg Config, table, dobCol, loginCol string) {
	t.Helper()
	ctx := context.Background()
	s, err := Open(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	tables, err := s.Tables(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, tb := range tables {
		if tb.Name == table {
			found = true
		}
	}
	if !found {
		t.Fatalf("%s not listed among %v", table, tables)
	}

	cols, err := s.Columns(ctx, table)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, c := range cols {
		names[c.Name] = true
		if (c.Name == "id" || c.Name == "_id") && !c.PrimaryKey {
			t.Errorf("%s: the key column is not marked as one", c.Name)
		}
	}
	for _, want := range []string{dobCol, loginCol, "sex"} {
		if !names[want] {
			t.Errorf("column %q missing from %v", want, cols)
		}
	}

	sample, err := s.Sample(ctx, table, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(sample[dobCol]) == 0 {
		t.Errorf("sample has no %s values: %v", dobCol, sample)
	}

	id := "id"
	if cfg.Kind == MongoDB {
		id = "_id"
	}
	var got []Row
	err = s.Stream(ctx, table, []string{id, dobCol, loginCol}, func(r Row) error {
		got = append(got, r)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(got, func(i, j int) bool { return got[i][id].(string) < got[j][id].(string) })
	if len(got) != len(fixtureIDs) {
		t.Fatalf("streamed %d rows, want %d", len(got), len(fixtureIDs))
	}
	if got[0][dobCol] != "14/04/1992" || got[2][dobCol] != nil {
		t.Errorf("dates of birth: %v / %v", got[0][dobCol], got[2][dobCol])
	}
	if _, leaked := got[0]["email"]; leaked {
		t.Error("a column that was not asked for was read")
	}
	// A time stored without a zone arrives as wall-clock text; one with a
	// zone arrives as a moment. Either way the cleaner reads 10:30 in India.
	switch v := got[0][loginCol].(type) {
	case string:
		if v != "2026-09-01 10:30:00" {
			t.Errorf("naive time: %q", v)
		}
	case time.Time:
		if !v.Equal(time.Date(2026, 9, 1, 5, 0, 0, 0, time.UTC)) {
			t.Errorf("moment: %v", v)
		}
	default:
		t.Errorf("last login came back as %T %v", v, v)
	}

	if _, err := s.Sample(ctx, "no_such_table", 5); !errors.Is(err, ErrUnknownTable) {
		t.Errorf("unknown table: %v", err)
	}

	// Reading from a date on: C1 logged in on 1 September, C2 on 1 August,
	// C3 never. The bound is a day or two generous, never more.
	for _, c := range cols {
		if c.Name == loginCol && !TimeType(c.Type) {
			t.Fatalf("%s is a %q column, not recognised as a date-time", loginCol, c.Type)
		}
	}
	ss, ok := s.(SinceStreamer)
	if !ok {
		t.Fatal("a database source cannot read from a date on")
	}
	var recent []string
	err = ss.StreamSince(ctx, table, []string{id}, loginCol, time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC),
		func(r Row) error {
			recent = append(recent, r[id].(string))
			return nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if len(recent) != 1 || recent[0] != "C1" {
		t.Errorf("rows since 15 August: %v", recent)
	}
}
