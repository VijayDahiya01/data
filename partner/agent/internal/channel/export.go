package channel

import (
	"context"
	"fmt"
	"strings"
	"unicode"
)

// Reading matching identifiers out of the Partner's own database -- §47.8,
// §47.9, §48.7.
//
// This is the only bulk read of customer PII anywhere in the Agent, and it is
// deliberately a separate configuration surface from everything else.
//
// # Why it is not the attribute table
//
// `oolix_audience_attributes` holds TARGETING attributes -- age band, city
// code, loyalty tier. It deliberately holds no contact details, because the
// ad-decision path never needs them and a table that does not contain an email
// address cannot leak one. Matching identifiers live somewhere else, and a
// Partner has to name that place explicitly before any external upload can
// happen at all.
//
// # Only what was allowed
//
// §47.9: "Agent selects only allowed matching fields." The field map below is
// the whole permission model. A field the Partner did not map is a field this
// code cannot read -- not one it chooses not to send. An empty map means no
// external upload is possible, which is the correct default for a Partner who
// has not opted into one.
//
// # Column names are interpolated, so they are validated
//
// Table and column names cannot be bound as parameters in SQL. They come from
// the Partner's own config file rather than from Oolix, so this is not a
// remote injection path -- but a typo that happened to contain a quote would
// still produce a confusing failure, and defence in depth costs one function.

// ExportConfig names where matching identifiers live and which may be read.
type ExportConfig struct {
	// IdentityTable is keyed by partner_user_id.
	IdentityTable string
	// MembersTable is the materialized membership index (§11).
	MembersTable string
	// Fields maps an identifier kind to the Partner's own column name. Only
	// mapped kinds are ever selected.
	Fields map[Kind]string
}

// Validate refuses a configuration that cannot produce a safe query.
func (c ExportConfig) Validate() error {
	if c.IdentityTable == "" {
		return fmt.Errorf("%w: no identity table configured for external export", ErrNotConfigured)
	}
	if len(c.Fields) == 0 {
		return fmt.Errorf(
			"%w: no matching fields are mapped, so no external upload is possible", ErrNotConfigured)
	}
	if err := validateIdentifier(c.IdentityTable); err != nil {
		return fmt.Errorf("identity table: %w", err)
	}
	if c.MembersTable != "" {
		if err := validateIdentifier(c.MembersTable); err != nil {
			return fmt.Errorf("members table: %w", err)
		}
	}
	for kind, column := range c.Fields {
		if err := validateIdentifier(column); err != nil {
			return fmt.Errorf("column for %s: %w", kind, err)
		}
	}
	return nil
}

// exportKindOrder fixes the column order so the scan targets line up.
//
// A map has no order, and scanning into the wrong field would put a phone
// number where an email belongs -- which hashes cleanly and matches nobody.
var exportKindOrder = []Kind{
	KindEmail, KindPhone, KindFirstName, KindLastName, KindCountry, KindZip, KindMobileID,
}

// BuildExportQuery returns the SQL and the kinds each column corresponds to.
//
// Separated from execution so the generated SQL can be asserted in a test
// without a database, which is the only practical way to pin the shape of a
// query that reads customer data.
func BuildExportQuery(c ExportConfig) (sql string, kinds []Kind, err error) {
	if err := c.Validate(); err != nil {
		return "", nil, err
	}

	members := c.MembersTable
	if members == "" {
		members = "oolix_audience_members"
	}

	var cols []string
	for _, k := range exportKindOrder {
		col, ok := c.Fields[k]
		if !ok {
			continue
		}
		cols = append(cols, "i."+col)
		kinds = append(kinds, k)
	}

	// The join restricts the read to the materialized membership of ONE
	// activation. Without it this becomes a full export of the Partner's
	// contact database, which is the single most dangerous query this codebase
	// could contain.
	//
	// `expires_at > NOW()` matters as much: a stale materialization would
	// upload people who have since dropped out of the audience the Partner
	// approved.
	sql = fmt.Sprintf(
		`SELECT %s
		   FROM %s AS m
		   JOIN %s AS i ON i.partner_user_id = m.partner_user_id
		  WHERE m.activation_id = $1
		    AND m.expires_at > NOW()`,
		strings.Join(cols, ", "), members, c.IdentityTable)

	return sql, kinds, nil
}

// validateIdentifier accepts only a plain SQL identifier, optionally
// schema-qualified.
//
// Letters, digits and underscores, starting with a letter or underscore. No
// quotes, no spaces, no semicolons -- so nothing that could terminate the
// statement or open a string.
func validateIdentifier(name string) error {
	if name == "" {
		return fmt.Errorf("is empty")
	}
	for _, part := range strings.Split(name, ".") {
		if part == "" {
			return fmt.Errorf("%q has an empty path segment", name)
		}
		for i, r := range part {
			switch {
			case r == '_':
			case unicode.IsLetter(r):
			case unicode.IsDigit(r) && i > 0:
			default:
				return fmt.Errorf(
					"%q is not a plain SQL identifier (offending character %q)", name, r)
			}
		}
	}
	return nil
}

// RowScanner is the narrow slice of a database this package needs.
//
// An interface rather than a *pgxpool.Pool so the export can be tested without
// standing up Postgres, and so nothing here can accidentally reach for a
// capability beyond reading rows.
type RowScanner interface {
	Query(ctx context.Context, sql string, args ...any) (Rows, error)
}

// Rows is the subset of pgx.Rows used here.
type Rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close()
}

// ExportMembers reads the matching identifiers for one activation.
//
// The returned slice holds RAW customer identifiers. It goes straight to an
// adapter, which hashes on the way out; it is never logged, never written to
// disk, and never returned across a process boundary.
func ExportMembers(
	ctx context.Context,
	db RowScanner,
	cfg ExportConfig,
	activationID string,
) ([]Member, error) {
	sql, kinds, err := BuildExportQuery(cfg)
	if err != nil {
		return nil, err
	}

	rows, err := db.Query(ctx, sql, activationID)
	if err != nil {
		return nil, fmt.Errorf("export members: %w", err)
	}
	defer rows.Close()

	var out []Member
	for rows.Next() {
		values := make([]*string, len(kinds))
		dest := make([]any, len(kinds))
		for i := range values {
			values[i] = new(string)
			dest[i] = values[i]
		}
		if err := rows.Scan(dest...); err != nil {
			// The error is returned bare. A scan failure can carry the value
			// that failed, and that value is a customer's contact detail.
			return nil, fmt.Errorf("export members: scan failed for one row")
		}

		var m Member
		for i, k := range kinds {
			assign(&m, k, *values[i])
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("export members: %w", err)
	}
	return out, nil
}

func assign(m *Member, k Kind, v string) {
	switch k {
	case KindEmail:
		m.Email = v
	case KindPhone:
		m.Phone = v
	case KindFirstName:
		m.FirstName = v
	case KindLastName:
		m.LastName = v
	case KindCountry:
		m.Country = v
	case KindZip:
		m.Zip = v
	case KindMobileID:
		m.MobileID = v
	}
}
