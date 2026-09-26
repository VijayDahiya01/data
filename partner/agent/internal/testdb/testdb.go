// Package testdb gives each test package its own PostgreSQL database for the
// local-store tests, so packages that `go test ./...` runs in parallel never
// share -- or empty -- each other's tables.
package testdb

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// URL returns a connection string for a database named after the package,
// created on first use from OOLIX_TEST_LOCALSTORE_URL. Without that variable
// the test is skipped, so `go test ./...` stays self-contained on a laptop.
func URL(t testing.TB, name string) string {
	t.Helper()
	base := os.Getenv("OOLIX_TEST_LOCALSTORE_URL")
	if base == "" {
		t.Skip("OOLIX_TEST_LOCALSTORE_URL not set")
	}
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("OOLIX_TEST_LOCALSTORE_URL: %v", err)
	}
	db := "oolix_agent_test_" + name

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{db}.Sanitize())
	var pgErr *pgconn.PgError
	if err != nil && !(errors.As(err, &pgErr) && pgErr.Code == "42P04") { // duplicate_database
		t.Fatal(err)
	}
	u.Path = "/" + db
	return u.String()
}
