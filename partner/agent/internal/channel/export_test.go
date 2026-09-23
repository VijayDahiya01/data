package channel

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The export is the only bulk read of customer PII in the Agent, so the tests
// are about what it refuses and what its SQL is restricted to -- not merely
// that it returns rows.

func goodConfig() ExportConfig {
	return ExportConfig{
		IdentityTable: "oolix_match_identities",
		Fields: map[Kind]string{
			KindEmail: "email_address",
			KindPhone: "phone_e164",
		},
	}
}

func TestExportRefusesWithoutAnIdentityTable(t *testing.T) {
	c := goodConfig()
	c.IdentityTable = ""
	if err := c.Validate(); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("expected ErrNotConfigured, got %v", err)
	}
}

func TestExportRefusesWhenNoFieldAreMapped(t *testing.T) {
	// The correct default for a Partner who has not opted into external
	// activation: nothing is readable, so nothing can be uploaded.
	c := goodConfig()
	c.Fields = nil
	err := c.Validate()
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("expected ErrNotConfigured, got %v", err)
	}
	if !strings.Contains(err.Error(), "no external upload is possible") {
		t.Errorf("error should say what the consequence is; got %q", err)
	}
}

func TestExportRejectsIdentifiersThatAreNotPlainNames(t *testing.T) {
	// These come from the Partner's own config rather than from Oolix, so this
	// is defence in depth rather than a remote injection path -- but a name
	// containing a quote would produce a confusing failure at best.
	for _, bad := range []string{
		"users; DROP TABLE oolix_audience_members",
		`users" WHERE 1=1 --`,
		"users'",
		"users table",
		"1users",
		"",
	} {
		c := goodConfig()
		c.IdentityTable = bad
		if err := c.Validate(); err == nil {
			t.Errorf("accepted an unsafe identity table %q", bad)
		}

		c = goodConfig()
		c.Fields = map[Kind]string{KindEmail: bad}
		if err := c.Validate(); err == nil {
			t.Errorf("accepted an unsafe column name %q", bad)
		}
	}
}

func TestExportAcceptsSchemaQualifiedNames(t *testing.T) {
	c := goodConfig()
	c.IdentityTable = "partner_private.match_identities"
	if err := c.Validate(); err != nil {
		t.Errorf("a schema-qualified table should be allowed: %v", err)
	}
}

// The most important test in this file.
func TestExportQueryIsScopedToOneActivationAndFreshMembership(t *testing.T) {
	sql, _, err := BuildExportQuery(goodConfig())
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	// Without the activation predicate this is a full export of the Partner's
	// contact database -- the single most dangerous query this codebase could
	// contain.
	if !strings.Contains(sql, "m.activation_id = $1") {
		t.Error("the export is not scoped to one activation")
	}
	// A stale materialization would upload people who have since dropped out
	// of the audience the Partner approved.
	if !strings.Contains(sql, "m.expires_at > NOW()") {
		t.Error("the export does not exclude an expired materialization")
	}
	// The activation id must be bound, never interpolated.
	if strings.Contains(sql, "'") {
		t.Errorf("the query contains a string literal: %s", sql)
	}
}

func TestExportSelectsOnlyMappedFields(t *testing.T) {
	// §47.9: "Agent selects only allowed matching fields." A field the Partner
	// did not map is one this code cannot read.
	c := goodConfig() // email and phone only
	sql, kinds, err := BuildExportQuery(c)
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	if !strings.Contains(sql, "i.email_address") || !strings.Contains(sql, "i.phone_e164") {
		t.Errorf("mapped columns missing from %s", sql)
	}
	for _, unmapped := range []string{"given_name", "family_name", "postal_code", "first_name"} {
		if strings.Contains(sql, unmapped) {
			t.Errorf("query reads an unmapped column %q", unmapped)
		}
	}
	if len(kinds) != 2 {
		t.Errorf("kinds = %v; want exactly the two mapped ones", kinds)
	}
}

func TestExportColumnOrderMatchesScanOrder(t *testing.T) {
	// A map has no order. If the SELECT list and the scan targets disagree, a
	// phone number lands in the email field -- which hashes cleanly and
	// matches nobody.
	c := ExportConfig{
		IdentityTable: "ids",
		Fields: map[Kind]string{
			KindZip:       "postal",
			KindEmail:     "mail",
			KindLastName:  "family",
			KindFirstName: "given",
		},
	}
	for i := 0; i < 20; i++ {
		sql, kinds, err := BuildExportQuery(c)
		if err != nil {
			t.Fatalf("build: %v", err)
		}
		// Stable across runs despite map iteration being randomised.
		if kinds[0] != KindEmail || kinds[len(kinds)-1] != KindZip {
			t.Fatalf("column order changed between builds: %v", kinds)
		}
		wantPrefix := "SELECT i.mail, i.given, i.family, i.postal"
		if !strings.HasPrefix(strings.Join(strings.Fields(sql), " "), wantPrefix) {
			t.Fatalf("SELECT order changed: %s", sql)
		}
	}
}

// --- a fake row source, so the read path is testable without Postgres -------

type fakeRows struct {
	data [][]string
	i    int
	err  error
}

func (r *fakeRows) Next() bool { r.i++; return r.i <= len(r.data) }
func (r *fakeRows) Err() error { return r.err }
func (r *fakeRows) Close()     {}
func (r *fakeRows) Scan(dest ...any) error {
	row := r.data[r.i-1]
	if len(dest) != len(row) {
		return errors.New("column count mismatch")
	}
	for i := range dest {
		p, ok := dest[i].(*string)
		if !ok {
			return errors.New("unexpected scan target")
		}
		*p = row[i]
	}
	return nil
}

type fakeDB struct {
	rows    *fakeRows
	gotSQL  string
	gotArgs []any
	err     error
}

func (d *fakeDB) Query(ctx context.Context, sql string, args ...any) (Rows, error) {
	d.gotSQL, d.gotArgs = sql, args
	if d.err != nil {
		return nil, d.err
	}
	return d.rows, nil
}

func TestExportMembersMapsColumnsToTheRightFields(t *testing.T) {
	db := &fakeDB{rows: &fakeRows{data: [][]string{
		{"a@example.com", "+15550102030"},
		{"b@example.com", "+15550102031"},
	}}}

	members, err := ExportMembers(context.Background(), db, goodConfig(), "act-1")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if len(members) != 2 {
		t.Fatalf("got %d members; want 2", len(members))
	}
	if members[0].Email != "a@example.com" || members[0].Phone != "+15550102030" {
		t.Errorf("first member mapped wrongly: %+v", members[0])
	}
	// The activation id is bound, not interpolated.
	if len(db.gotArgs) != 1 || db.gotArgs[0] != "act-1" {
		t.Errorf("args = %v; want the activation id bound as $1", db.gotArgs)
	}
}

func TestExportScanFailureDoesNotEchoTheValue(t *testing.T) {
	// A scan error can carry the value that failed, and that value is a
	// customer's contact detail.
	db := &fakeDB{rows: &fakeRows{data: [][]string{{"only-one-column"}}}}
	cfg := goodConfig() // expects two columns

	_, err := ExportMembers(context.Background(), db, cfg, "act-1")
	if err == nil {
		t.Fatal("expected a scan error")
	}
	if strings.Contains(err.Error(), "only-one-column") {
		t.Errorf("the error echoed row content: %q", err)
	}
}
