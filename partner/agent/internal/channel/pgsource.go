package channel

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Binding the export to the Partner's own Postgres.
//
// Kept apart from export.go so the query construction and the field mapping
// stay testable without a database. This file is the thin part that cannot be
// tested without one, and it deliberately contains no logic worth testing.

// PgMemberSource reads matching identifiers from the Partner's database.
type PgMemberSource struct {
	pool *pgxpool.Pool
	cfg  ExportConfig
}

// NewPgMemberSource validates the export configuration up front.
//
// Failing here means the Agent refuses to start with an external channel
// enabled but unreadable, rather than discovering it at the moment an upload
// was due.
func NewPgMemberSource(pool *pgxpool.Pool, cfg ExportConfig) (*PgMemberSource, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if pool == nil {
		return nil, fmt.Errorf("%w: no database pool for the member export", ErrNotConfigured)
	}
	return &PgMemberSource{pool: pool, cfg: cfg}, nil
}

func (s *PgMemberSource) Members(ctx context.Context, activationID string) ([]Member, error) {
	return ExportMembers(ctx, pgQuerier{s.pool}, s.cfg, activationID)
}

type pgQuerier struct{ pool *pgxpool.Pool }

func (q pgQuerier) Query(ctx context.Context, sql string, args ...any) (Rows, error) {
	rows, err := q.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgRows{rows}, nil
}

type pgRows struct {
	inner interface {
		Next() bool
		Scan(dest ...any) error
		Err() error
		Close()
	}
}

func (r pgRows) Next() bool             { return r.inner.Next() }
func (r pgRows) Scan(dest ...any) error { return r.inner.Scan(dest...) }
func (r pgRows) Err() error             { return r.inner.Err() }
func (r pgRows) Close()                 { r.inner.Close() }

// ExportConfigFromStrings turns the Partner's YAML field names into the typed
// map the exporter uses.
//
// An unrecognised key is an ERROR rather than something skipped. A Partner who
// writes `e-mail:` instead of `email:` has said what they meant; silently
// ignoring it would produce an upload missing the identifier that matters most,
// and the only symptom would be a poor match rate.
func ExportConfigFromStrings(identityTable, membersTable string, fields map[string]string) (ExportConfig, error) {
	known := map[string]Kind{
		"email":      KindEmail,
		"phone":      KindPhone,
		"first_name": KindFirstName,
		"last_name":  KindLastName,
		"country":    KindCountry,
		"zip":        KindZip,
		"mobile_id":  KindMobileID,
	}

	out := ExportConfig{
		IdentityTable: identityTable,
		MembersTable:  membersTable,
		Fields:        make(map[Kind]string, len(fields)),
	}
	for key, column := range fields {
		kind, ok := known[key]
		if !ok {
			return ExportConfig{}, fmt.Errorf(
				"channels.export.fields.%s is not a recognised identifier "+
					"(expected one of email, phone, first_name, last_name, country, zip, mobile_id)", key)
		}
		out.Fields[kind] = column
	}
	return out, nil
}
