package source

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"

	_ "github.com/sijms/go-ora/v2" // registers the "oracle" driver for the fixture
)

// Oracle, in CI (see the Partner Agent job): the same three customers, and a
// connection that refuses writes.
//
//	OOLIX_TEST_ORACLE_URL  oracle://user:pass@host:1521/SERVICE
func TestOracleSource(t *testing.T) {
	dsn := os.Getenv("OOLIX_TEST_ORACLE_URL")
	if dsn == "" {
		t.Skip("OOLIX_TEST_ORACLE_URL not set")
	}
	sqlFixture(t, "oracle", dsn,
		`BEGIN EXECUTE IMMEDIATE 'DROP TABLE "crm_customers"'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
		`CREATE TABLE "crm_customers" ("id" VARCHAR2(10) PRIMARY KEY, "DOB" VARCHAR2(20), "sex" VARCHAR2(8),
		   "Last Login" TIMESTAMP, "signed_up" TIMESTAMP WITH TIME ZONE, "email" VARCHAR2(80))`,
		`INSERT INTO "crm_customers" VALUES ('C1', '14/04/1992', 'M', TIMESTAMP '2026-09-01 10:30:00',
		   TIMESTAMP '2024-01-01 00:00:00 +00:00', 'a@example.com')`,
		`INSERT INTO "crm_customers" VALUES ('C2', '14-04-1993', 'F', TIMESTAMP '2026-08-01 00:00:00', NULL,
		   'b@example.com')`,
		`INSERT INTO "crm_customers" VALUES ('C3', NULL, NULL, NULL, NULL, NULL)`)

	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := strings.ToUpper(u.User.Username())
	checkSource(t, Config{Kind: Oracle, URI: dsn, Location: "Asia/Kolkata"}, schema+".crm_customers", "DOB", "Last Login")

	s, err := Open(context.Background(), Config{Kind: Oracle, URI: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	err = s.(*sqlSource).read(context.Background(), `UPDATE "crm_customers" SET "sex" = 'X'`,
		func(Row) error { return nil })
	if err == nil {
		t.Error("a write went through the Agent's read-only transaction")
	}
}
