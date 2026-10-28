package managed

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/source"
)

// The conformance kit (docs/DESIGN-PARTNER-DATA.md §3.3): one deliberately
// messy customer table, loaded into every kind of database the Agent reads,
// must come out as the same cleaned copy. A new connector is trusted when it
// passes this, without re-testing everything downstream. Each database runs
// when its OOLIX_TEST_*_URL is set; CI sets them all.

var conformanceRows = [][]string{
	// customer_id, dob, sex, city, tier, last_login (wall clock in India), opted_in
	{"C1", "14/04/1992", "F", "Bombay", "Gold", "2026-09-01 10:30:00", "yes"},
	{"C2", "1993-04-14", "male", "bangalore", "Silver", "2026-08-01 00:00:00", "Y"},
	{"C3", "01/01/2015", "M", "Mumbai", "Gold", "2026-09-01 10:00:00", "yes"}, // a child: left out
	{"C4", "", "2", "Pune", "", "", "no"},                                     // did not agree
	{"C5", "31-12-1990", "F", "Gurgaon", "Platinum", "2026-09-20 09:00:00", "1"},
}

type conformanceKind struct {
	kind  source.Kind
	env   string
	table func(dsn string) string
	load  func(t *testing.T, dsn string)
}

func sqlLoad(driver string, ddl []string, insert func(r []string) string) func(*testing.T, string) {
	return func(t *testing.T, dsn string) {
		t.Helper()
		db, err := sql.Open(driver, dsn)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		for _, st := range ddl {
			if _, err := db.Exec(st); err != nil {
				t.Fatalf("%s: %v", st, err)
			}
		}
		for _, r := range conformanceRows {
			if _, err := db.Exec(insert(r)); err != nil {
				t.Fatalf("insert %s: %v", r[0], err)
			}
		}
	}
}

// lit writes a text value, or NULL for an empty one.
func lit(v string) string {
	if v == "" {
		return "NULL"
	}
	return "'" + strings.ReplaceAll(v, "'", "''") + "'"
}

var conformanceKinds = []conformanceKind{
	{kind: source.Postgres, env: "OOLIX_TEST_POSTGRES_URL", table: func(string) string { return "conf_customers" },
		load: sqlLoad("pgx", []string{`DROP TABLE IF EXISTS conf_customers`,
			`CREATE TABLE conf_customers (customer_id text PRIMARY KEY, dob text, sex text, city text, tier text,
			   last_login timestamp, opted_in text)`},
			func(r []string) string {
				return fmt.Sprintf(`INSERT INTO conf_customers VALUES (%s,%s,%s,%s,%s,%s,%s)`,
					lit(r[0]), lit(r[1]), lit(r[2]), lit(r[3]), lit(r[4]), lit(r[5]), lit(r[6]))
			})},
	{kind: source.MySQL, env: "OOLIX_TEST_MYSQL_URL", table: func(string) string { return "conf_customers" },
		load: sqlLoad("mysql", []string{"DROP TABLE IF EXISTS conf_customers",
			"CREATE TABLE conf_customers (customer_id VARCHAR(10) PRIMARY KEY, dob VARCHAR(20), sex VARCHAR(8), " +
				"city VARCHAR(40), tier VARCHAR(20), last_login DATETIME NULL, opted_in VARCHAR(8))"},
			func(r []string) string {
				return fmt.Sprintf("INSERT INTO conf_customers VALUES (%s,%s,%s,%s,%s,%s,%s)",
					lit(r[0]), lit(r[1]), lit(r[2]), lit(r[3]), lit(r[4]), lit(r[5]), lit(r[6]))
			})},
	{kind: source.SQLServer, env: "OOLIX_TEST_SQLSERVER_URL", table: func(string) string { return "dbo.conf_customers" },
		load: sqlLoad("sqlserver", []string{"IF OBJECT_ID('dbo.conf_customers') IS NOT NULL DROP TABLE dbo.conf_customers",
			"CREATE TABLE dbo.conf_customers (customer_id VARCHAR(10) PRIMARY KEY, dob VARCHAR(20), sex VARCHAR(8), " +
				"city VARCHAR(40), tier VARCHAR(20), last_login DATETIME2 NULL, opted_in VARCHAR(8))"},
			func(r []string) string {
				return fmt.Sprintf("INSERT INTO dbo.conf_customers VALUES (%s,%s,%s,%s,%s,%s,%s)",
					lit(r[0]), lit(r[1]), lit(r[2]), lit(r[3]), lit(r[4]), lit(r[5]), lit(r[6]))
			})},
	{kind: source.Oracle, env: "OOLIX_TEST_ORACLE_URL",
		table: func(dsn string) string {
			u, _ := url.Parse(dsn)
			return strings.ToUpper(u.User.Username()) + ".conf_customers"
		},
		load: sqlLoad("oracle", []string{
			`BEGIN EXECUTE IMMEDIATE 'DROP TABLE "conf_customers"'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
			`CREATE TABLE "conf_customers" ("customer_id" VARCHAR2(10) PRIMARY KEY, "dob" VARCHAR2(20), "sex" VARCHAR2(8),
			   "city" VARCHAR2(40), "tier" VARCHAR2(20), "last_login" TIMESTAMP, "opted_in" VARCHAR2(8))`},
			func(r []string) string {
				login := "NULL"
				if r[5] != "" {
					login = "TIMESTAMP '" + r[5] + "'"
				}
				return fmt.Sprintf(`INSERT INTO "conf_customers" VALUES (%s,%s,%s,%s,%s,%s,%s)`,
					lit(r[0]), lit(r[1]), lit(r[2]), lit(r[3]), lit(r[4]), login, lit(r[6]))
			})},
	{kind: source.MongoDB, env: "OOLIX_TEST_MONGODB_URL", table: func(string) string { return "conf_customers" },
		load: func(t *testing.T, dsn string) {
			t.Helper()
			ctx := context.Background()
			client, err := mongo.Connect(options.Client().ApplyURI(dsn))
			if err != nil {
				t.Fatal(err)
			}
			defer client.Disconnect(ctx)
			coll := client.Database("oolix_source_test").Collection("conf_customers")
			_ = coll.Drop(ctx)
			for _, r := range conformanceRows {
				doc := bson.D{{Key: "_id", Value: r[0]}}
				for i, k := range []string{"dob", "sex", "city", "tier"} {
					if r[i+1] != "" {
						doc = append(doc, bson.E{Key: k, Value: r[i+1]})
					}
				}
				if r[5] != "" {
					// A BSON date is a moment: 10:30 in India.
					t0, _ := time.ParseInLocation("2006-01-02 15:04:05", r[5], clean.India)
					doc = append(doc, bson.E{Key: "last_login", Value: t0})
				}
				doc = append(doc, bson.E{Key: "opted_in", Value: r[6]})
				if _, err := coll.InsertOne(ctx, doc); err != nil {
					t.Fatal(err)
				}
			}
		}},
}

type copied struct {
	DOB, DOBHi, Seen any
	Gender, City     any
	Tier             any
}

func readCopy(t *testing.T, ctx context.Context, store interface {
	ScrambleID(string) string
}, q func(string, ...any) ([][]any, error)) map[string]copied {
	t.Helper()
	rows, err := q(`SELECT partner_user_id, dob, dob_hi, gender, city, loyalty_tier, last_seen_at
		FROM oolix_audience_attributes`)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for _, r := range conformanceRows {
		ids[store.ScrambleID(r[0])] = r[0]
	}
	out := map[string]copied{}
	for _, r := range rows {
		out[ids[r[0].(string)]] = copied{DOB: r[1], DOBHi: r[2], Gender: r[3], City: r[4], Tier: r[5], Seen: r[6]}
	}
	return out
}

func TestEveryConnectorMakesTheSameCopy(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	mapping := func(table, id string) Mapping {
		return Mapping{Table: table, IDColumn: id, Location: "Asia/Kolkata",
			Attributes: map[string]AttributeMapping{
				"age":              {Column: "dob", Order: clean.DayFirst, Publish: true},
				"gender":           {Column: "sex", Publish: true},
				"city":             {Column: "city", Publish: true},
				"loyalty_tier":     {Column: "tier", Publish: true},
				"active_user_days": {Column: "last_login", Publish: true},
			},
			Consent: ConsentMapping{Column: "opted_in"}}
	}
	query := func(sqlText string, args ...any) ([][]any, error) {
		rows, err := store.Pool.Query(ctx, sqlText, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out [][]any
		for rows.Next() {
			v, err := rows.Values()
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, rows.Err()
	}

	// The baseline: the same table as a CSV export.
	dir := t.TempDir()
	var b strings.Builder
	b.WriteString("customer_id,dob,sex,city,tier,last_login,opted_in\n")
	for _, r := range conformanceRows {
		b.WriteString(strings.Join(r, ",") + "\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "conf.csv"), []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	src, err := source.Open(ctx, source.Config{Kind: source.File, Folder: dir})
	if err != nil {
		t.Fatal(err)
	}
	rep, err := Sync(ctx, src, store, mapping("conf.csv", "customer_id"), now)
	_ = src.Close()
	if err != nil {
		t.Fatal(err)
	}
	if rep.Customers != 3 || rep.UnderAge != 1 || rep.NotConsented != 1 {
		t.Fatalf("baseline: %+v", rep)
	}
	want := readCopy(t, ctx, store, query)

	for _, k := range conformanceKinds {
		t.Run(string(k.kind), func(t *testing.T) {
			dsn := os.Getenv(k.env)
			if dsn == "" {
				t.Skip(k.env + " not set")
			}
			k.load(t, dsn)
			if k.kind == source.Postgres {
				// Locally this database is shared with the API's own suites,
				// whose privacy checks look for customer-ID columns.
				t.Cleanup(func() {
					if db, err := sql.Open("pgx", dsn); err == nil {
						_, _ = db.Exec(`DROP TABLE IF EXISTS conf_customers`)
						_ = db.Close()
					}
				})
			}
			cfg := source.Config{Kind: k.kind, URI: dsn, Location: "Asia/Kolkata"}
			if k.kind == source.MongoDB {
				cfg.Database = "oolix_source_test"
			}
			src, err := source.Open(ctx, cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer src.Close()
			id := "customer_id"
			if k.kind == source.MongoDB {
				id = "_id"
			}
			rep, err := Sync(ctx, src, store, mapping(k.table(dsn), id), now)
			if err != nil {
				t.Fatal(err)
			}
			if rep.Customers != 3 || rep.UnderAge != 1 || rep.NotConsented != 1 {
				t.Errorf("sync: %+v", rep)
			}
			got := readCopy(t, ctx, store, query)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("the copy differs from the CSV's:\n got  %+v\n want %+v", got, want)
			}
		})
	}
}
