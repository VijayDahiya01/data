package managed

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/standard"
)

// AttributeReport is how one attribute fared in a sync.
type AttributeReport struct {
	// Filled counts customers in the copy with a usable value.
	Filled int `json:"filled"`
	// Unreadable counts values present but not usable.
	Unreadable int `json:"unreadable"`
	// Unrecognised are list values that matched no code, most common first.
	Unrecognised []detect.ValueCount `json:"unrecognised,omitempty"`
}

// Sync modes.
const (
	ModeFull        = "FULL"
	ModeIncremental = "INCREMENTAL"
)

// Report is what one sync did. Counts only: it goes on the status page, and
// nothing in it is sent to Oolix but the percentages in a Quality report.
type Report struct {
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	// Mode is FULL, or INCREMENTAL when only changed customers were read.
	Mode string `json:"mode"`
	// RowsRead counts rows read from the Partner's customer table.
	RowsRead int `json:"rows_read"`
	// Customers counts customers now in the copy: adults who agreed to
	// marketing.
	Customers int `json:"customers"`
	// Changed counts the customers an incremental sync added, updated or
	// removed.
	Changed int `json:"changed,omitempty"`
	// WithoutID counts rows skipped for having no customer id.
	WithoutID int `json:"without_id"`
	// Duplicates counts extra rows for a customer listed more than once.
	Duplicates int `json:"duplicates"`
	// UnderAge counts customers left out for being younger than 18.
	UnderAge int `json:"under_age"`
	// NotConsented counts customers left out because the table does not
	// record their agreement to marketing, or records it withdrawn.
	NotConsented int                        `json:"not_consented"`
	Attributes   map[string]AttributeReport `json:"attributes"`
	// Activity is what was read from the orders and bookings tables.
	Activity map[string]ActivityReport `json:"activity,omitempty"`
	// Watermark is the latest change time read from the updated-at column.
	Watermark *time.Time `json:"watermark,omitempty"`
	// Fingerprint identifies the choices the sync was made with.
	Fingerprint string `json:"fingerprint,omitempty"`
	Error       string `json:"error,omitempty"`
}

const (
	stagingAttributes = "oolix_sync_attributes"
	stagingConsent    = "oolix_sync_consent"
	nextAttributes    = "oolix_next_attributes"
	nextConsent       = "oolix_next_consent"
	batchSize         = 5000
	policyVersion     = "managed"
)

// cleaner turns one mapped attribute's raw value into its stored value.
type cleaner struct {
	attr  standard.Attribute
	col   string
	opts  clean.DateOptions
	enums *clean.EnumMapper
}

func newCleaner(a standard.Attribute, am AttributeMapping, loc *time.Location) (cleaner, error) {
	c := cleaner{attr: a, col: am.Column, opts: clean.DateOptions{Order: am.Order, Location: loc}}
	if a.Kind == standard.KindEnum {
		e, err := clean.NewEnumMapper(a, am.Overrides)
		if err != nil {
			return c, err
		}
		c.enums = e
	}
	return c, nil
}

// value cleans one raw value. present is false for an empty value, and for
// one the Partner told us to ignore.
func (c cleaner) value(raw any, now time.Time) (v any, present, ok bool) {
	if strings.TrimSpace(clean.Text(raw)) == "" {
		return nil, false, false
	}
	switch c.attr.Kind {
	case standard.KindDate:
		d, ok := clean.ParseDate(raw, c.opts)
		if !ok || d.Year() < 1900 || d.After(now) {
			return nil, true, false
		}
		return d, true, true
	case standard.KindTimestamp:
		t, ok := clean.ParseTimestamp(raw, c.opts)
		if !ok || t.After(now.Add(24*time.Hour)) {
			return nil, true, false
		}
		return t, true, true
	case standard.KindEnum:
		if c.enums.Ignored(raw) {
			return nil, false, false
		}
		code, ok := c.enums.Map(raw)
		if !ok {
			return nil, true, false
		}
		return code, true, true
	case standard.KindBool:
		b, ok := clean.ParseBool(raw)
		if !ok {
			return nil, true, false
		}
		return b, true, true
	case standard.KindNumber:
		n, ok := clean.ParseNumber(raw)
		if !ok || n < 0 || n > math.MaxInt32 {
			return nil, true, false
		}
		return int32(math.Round(n)), true, true
	}
	return nil, true, false
}

// Sync copies the Partner's tables into the local store in full.
//
// Only adults who agreed to marketing are copied: nobody else could be shown
// an ad, so nobody else's data is needed. The new copy is built beside the
// old one and swapped in as a single step, so audience counts and ad decisions
// never see a half-loaded table, and a sync that fails part-way leaves
// yesterday's copy exactly as it was. Customers removed at the source, or who
// withdrew consent, disappear from the copy at the next sync.
func Sync(ctx context.Context, src source.Source, store *localstore.Store, m Mapping, now time.Time) (Report, error) {
	return run(ctx, src, store, m, now, nil)
}

// SyncChanges reads only the customers changed since `since`, through the
// updated-at column, and applies them to the live copy: added, updated, or
// removed when they withdrew consent. Orders and bookings are read again in
// full (within their window) because the windows move every day. It cannot
// notice a customer deleted from the table; the weekly full sync does.
func SyncChanges(ctx context.Context, src source.Source, store *localstore.Store, m Mapping,
	since, now time.Time) (Report, error) {
	return run(ctx, src, store, m, now, &since)
}

func run(ctx context.Context, src source.Source, store *localstore.Store, m Mapping, now time.Time,
	since *time.Time) (Report, error) {
	rep := Report{StartedAt: now.UTC(), Mode: ModeFull, Attributes: map[string]AttributeReport{}}
	if since != nil {
		rep.Mode = ModeIncremental
	}
	if m.Table == "" || m.IDColumn == "" {
		return rep, ErrNotSetUp
	}
	var changes source.SinceStreamer
	if since != nil {
		ss, ok := src.(source.SinceStreamer)
		if !ok || m.UpdatedColumn == "" {
			return rep, errors.New("this source cannot read only changed rows")
		}
		changes = ss
	}
	loc := location(m.Location)
	provides := ActivityProvides(m)

	var cleaners []cleaner
	columns := []string{m.IDColumn}
	seen := map[string]bool{m.IDColumn: true}
	want := func(col string) {
		if col != "" && !seen[col] {
			seen[col] = true
			columns = append(columns, col)
		}
	}
	for _, a := range standard.Attributes {
		if provides[a.Key] {
			// The orders or bookings table supplies it.
			rep.Attributes[a.Key] = AttributeReport{}
			continue
		}
		am, ok := m.Attributes[a.Key]
		if !ok || am.Column == "" {
			continue
		}
		c, err := newCleaner(a, am, loc)
		if err != nil {
			return rep, err
		}
		cleaners = append(cleaners, c)
		want(am.Column)
		rep.Attributes[a.Key] = AttributeReport{}
	}
	if !m.Consent.Everyone {
		want(m.Consent.Column)
	}
	want(m.Consent.Withdrawal)
	want(m.UpdatedColumn)

	if err := prepareStaging(ctx, store); err != nil {
		return rep, err
	}
	defer dropStaging(context.WithoutCancel(ctx), store)

	attrCols := []string{"partner_user_id"}
	for _, a := range standard.Attributes {
		attrCols = append(attrCols, a.Column)
	}
	attrCols = append(attrCols, "refreshed_at")
	index := map[string]int{}
	for i, c := range attrCols {
		index[c] = i
	}
	consentCols := []string{"partner_user_id", "purpose_id", "eligible", "policy_version", "updated_at", "withdrawn_at"}

	unrecognised := map[string]map[string]int{}
	var attrBatch, consentBatch [][]any
	flush := func() error {
		if len(attrBatch) > 0 {
			if _, err := store.Pool.CopyFrom(ctx, pgx.Identifier{stagingAttributes}, attrCols, pgx.CopyFromRows(attrBatch)); err != nil {
				return fmt.Errorf("writing the copy: %w", err)
			}
		}
		if len(consentBatch) > 0 {
			if _, err := store.Pool.CopyFrom(ctx, pgx.Identifier{stagingConsent}, consentCols, pgx.CopyFromRows(consentBatch)); err != nil {
				return fmt.Errorf("writing consent: %w", err)
			}
		}
		attrBatch, consentBatch = attrBatch[:0], consentBatch[:0]
		return nil
	}
	markOpts := clean.DateOptions{Order: clean.DayFirst, Location: loc}

	each := func(row source.Row) error {
		rep.RowsRead++
		id := strings.TrimSpace(clean.Text(row[m.IDColumn]))
		if id == "" {
			rep.WithoutID++
			return nil
		}
		if m.UpdatedColumn != "" {
			t, ok := clean.ParseTimestamp(row[m.UpdatedColumn], markOpts)
			if ok && since != nil && t.Before(*since) {
				// Read only because the source's bound is a day or two early.
				return nil
			}
			if ok && !t.After(now.Add(time.Hour)) && (rep.Watermark == nil || t.After(*rep.Watermark)) {
				rep.Watermark = &t
			}
		}
		values := make([]any, len(attrCols))
		results := make([]struct{ present, ok bool }, len(cleaners))
		for i, c := range cleaners {
			v, present, ok := c.value(row[c.col], now)
			results[i].present, results[i].ok = present, ok
			if ok {
				values[index[c.attr.Column]] = v
			}
		}
		scrambled := store.ScrambleID(id)
		// DPDP Act: no targeted advertising at children, so they are not
		// copied at all. A customer whose age is unknown cannot be judged.
		if dob, ok := values[index["dob"]].(time.Time); ok && yearsBetween(dob, now) < standard.MinimumAge {
			rep.UnderAge++
			if since != nil {
				// Already in the copy, perhaps, with a birth date since corrected.
				consentBatch = append(consentBatch, []any{scrambled, localstore.AnyPurpose, false, policyVersion, now.UTC(), nil})
			}
			return nil
		}

		eligible, withdrawnAt := consentOf(row, m.Consent, loc, now)
		// Recorded for everyone, so a customer listed twice with conflicting
		// answers can be left out rather than guessed about.
		consentBatch = append(consentBatch, []any{scrambled, localstore.AnyPurpose, eligible, policyVersion, now.UTC(), withdrawnAt})
		if eligible {
			for i, c := range cleaners {
				if results[i].present && !results[i].ok {
					ar := rep.Attributes[c.attr.Key]
					ar.Unreadable++
					rep.Attributes[c.attr.Key] = ar
					if c.attr.Kind == standard.KindEnum {
						if unrecognised[c.attr.Key] == nil {
							unrecognised[c.attr.Key] = map[string]int{}
						}
						unrecognised[c.attr.Key][strings.TrimSpace(clean.Text(row[c.col]))]++
					}
				}
			}
			values[0] = scrambled
			values[len(values)-1] = now.UTC()
			attrBatch = append(attrBatch, values)
		}

		if len(consentBatch) >= batchSize {
			return flush()
		}
		return nil
	}

	var err error
	if changes != nil {
		err = changes.StreamSince(ctx, m.Table, columns, m.UpdatedColumn, *since, each)
	} else {
		err = src.Stream(ctx, m.Table, columns, each)
	}
	if err == nil {
		err = flush()
	}
	for _, act := range []struct {
		kind string
		am   *ActivityMapping
	}{{kindOrders, m.Orders}, {kindBookings, m.Bookings}} {
		if err == nil && act.am != nil && act.am.Table != "" {
			err = stageActivity(ctx, src, store, act.kind, *act.am, loc, now, &rep, unrecognised)
		}
	}
	if err != nil {
		rep.FinishedAt = time.Now().UTC()
		return rep, err
	}

	for key, counts := range unrecognised {
		ar := rep.Attributes[key]
		ar.Unrecognised = top(counts, 10)
		rep.Attributes[key] = ar
	}

	if since != nil {
		err = applyChanges(ctx, store, attrCols, provides, now, &rep)
	} else {
		err = swapIn(ctx, store, attrCols, provides, now, &rep)
	}
	rep.FinishedAt = time.Now().UTC()
	return rep, err
}

// consentOf reads marketing consent for one row. Unknown means no: a customer
// is eligible only when the data says so.
func consentOf(row source.Row, c ConsentMapping, loc *time.Location, now time.Time) (bool, any) {
	opts := clean.DateOptions{Order: clean.DayFirst, Location: loc}
	given := c.Everyone
	var givenAt time.Time
	if !c.Everyone && c.Column != "" {
		raw := row[c.Column]
		if b, ok := clean.ParseBool(raw); ok {
			given = b
		} else if t, ok := clean.ParseTimestamp(raw, opts); ok {
			// A date of consent means consent was given.
			given, givenAt = true, t
		}
	}
	var withdrawnAt any
	if c.Withdrawal != "" {
		raw := row[c.Withdrawal]
		if b, ok := clean.ParseBool(raw); ok {
			if b {
				withdrawnAt = now.UTC()
			}
		} else if t, ok := clean.ParseTimestamp(raw, opts); ok {
			// Consent given again after a withdrawal counts; otherwise a
			// withdrawal date means withdrawn.
			if givenAt.IsZero() || !givenAt.After(t) {
				withdrawnAt = t
			}
		}
	}
	return given && withdrawnAt == nil, withdrawnAt
}

func yearsBetween(from, to time.Time) int {
	years := to.Year() - from.Year()
	if to.YearDay() < from.YearDay() {
		years--
	}
	return years
}

func prepareStaging(ctx context.Context, store *localstore.Store) error {
	for _, st := range []string{
		`DROP TABLE IF EXISTS ` + stagingAttributes + `, ` + stagingConsent + `, ` + stagingActivity,
		// UNLOGGED: a crash mid-sync simply means the next sync starts over.
		strings.Replace(localstore.AttributeDDL(stagingAttributes), "CREATE TABLE", "CREATE UNLOGGED TABLE", 1),
		strings.Replace(localstore.ConsentDDL(stagingConsent), "CREATE TABLE", "CREATE UNLOGGED TABLE", 1),
		activityDDL(stagingActivity),
	} {
		if _, err := store.Pool.Exec(ctx, st); err != nil {
			return fmt.Errorf("preparing the copy: %w", err)
		}
	}
	return nil
}

func dropStaging(ctx context.Context, store *localstore.Store) {
	_, _ = store.Pool.Exec(ctx, `DROP TABLE IF EXISTS `+stagingAttributes+`, `+stagingConsent+`, `+
		stagingActivity+`, `+nextAttributes+`, `+nextConsent)
}

// indexed are the columns rules filter on; the dates as ranges, so an index
// serves them.
var indexed = []string{"dob", "last_order_at", "last_booking_at", "last_seen_at", "city", "state_region"}

// selectAttributes is the SELECT list building one attribute row from a
// staged customer row (alias a) and, for what orders and bookings supply,
// their sums (alias g).
func selectAttributes(attrCols []string, fromActivity map[string]string) string {
	out := make([]string, len(attrCols))
	for i, c := range attrCols {
		if expr, ok := fromActivity[c]; ok {
			out[i] = expr
		} else {
			out[i] = "a." + c
		}
	}
	return strings.Join(out, ", ")
}

// swapIn builds the new copy from the staged rows, indexes it, and replaces
// the live tables with it in one transaction.
func swapIn(ctx context.Context, store *localstore.Store, attrCols []string, provides map[string]bool,
	now time.Time, rep *Report) error {
	cols := strings.Join(attrCols, ", ")
	fromActivity := activityColumns(provides)
	// One row per consenting customer. If the source listed someone twice,
	// the last row read wins -- the source gave no better way to choose.
	insert, args := `INSERT INTO `+nextAttributes+` (`+cols+`)
		   SELECT DISTINCT ON (a.partner_user_id) `+selectAttributes(attrCols, fromActivity)+`
		   FROM `+stagingAttributes+` a
		   WHERE EXISTS (SELECT 1 FROM `+nextConsent+` c WHERE c.partner_user_id = a.partner_user_id)
		   ORDER BY a.partner_user_id, a.ctid DESC`, []any(nil)
	if len(fromActivity) > 0 {
		insert = `WITH ` + activitySums + ` INSERT INTO ` + nextAttributes + ` (` + cols + `)
		   SELECT DISTINCT ON (a.partner_user_id) ` + selectAttributes(attrCols, fromActivity) + `
		   FROM ` + stagingAttributes + ` a LEFT JOIN g ON g.partner_user_id = a.partner_user_id
		   WHERE EXISTS (SELECT 1 FROM ` + nextConsent + ` c WHERE c.partner_user_id = a.partner_user_id)
		   ORDER BY a.partner_user_id, a.ctid DESC`
		args = activityWindows(now)
	}

	type step struct {
		sql  string
		args []any
	}
	build := []step{
		{sql: `DROP TABLE IF EXISTS ` + nextAttributes + `, ` + nextConsent},
		{sql: localstore.ConsentDDL(nextConsent)},
		// One answer per customer, and yes only if every row the source holds
		// for them says yes: when duplicates disagree, the answer is no.
		{sql: `INSERT INTO ` + nextConsent + ` (partner_user_id, purpose_id, eligible, policy_version, updated_at)
		   SELECT partner_user_id, '` + localstore.AnyPurpose + `', true, '` + policyVersion + `', max(updated_at)
		   FROM ` + stagingConsent + ` GROUP BY partner_user_id
		   HAVING bool_and(eligible AND withdrawn_at IS NULL)`},
		{sql: localstore.AttributeDDL(nextAttributes)},
		{sql: insert, args: args},
		{sql: `CREATE UNIQUE INDEX oolix_attributes_pkey_idx_next ON ` + nextAttributes + ` (partner_user_id)`},
		{sql: `CREATE UNIQUE INDEX oolix_consent_pkey_idx_next ON ` + nextConsent + ` (partner_user_id, purpose_id)`},
	}
	for _, col := range indexed {
		build = append(build, step{sql: fmt.Sprintf(`CREATE INDEX oolix_attributes_%s_idx_next ON %s (%s)`, col, nextAttributes, col)})
	}
	build = append(build, step{sql: `ANALYZE ` + nextAttributes}, step{sql: `ANALYZE ` + nextConsent})
	for _, st := range build {
		if _, err := store.Pool.Exec(ctx, st.sql, st.args...); err != nil {
			return fmt.Errorf("building the new copy: %w", err)
		}
	}

	var rows, people, consented int
	if err := store.Pool.QueryRow(ctx,
		`SELECT count(*), count(DISTINCT partner_user_id) FROM `+stagingConsent).Scan(&rows, &people); err != nil {
		return err
	}
	if err := store.Pool.QueryRow(ctx, `SELECT count(*) FROM `+nextConsent).Scan(&consented); err != nil {
		return err
	}
	if err := filled(ctx, store.Pool, nextAttributes, rep); err != nil {
		return err
	}

	swap := []string{
		// The attribute table first: waiting on a long audience count holds
		// up only other counts, not ad decisions, which read consent.
		`DROP TABLE ` + localstore.AttributesTable,
		`ALTER TABLE ` + nextAttributes + ` RENAME TO ` + localstore.AttributesTable,
		`ALTER INDEX oolix_attributes_pkey_idx_next RENAME TO oolix_attributes_pkey_idx`,
		`DROP TABLE ` + localstore.ConsentTable,
		`ALTER TABLE ` + nextConsent + ` RENAME TO ` + localstore.ConsentTable,
		`ALTER INDEX oolix_consent_pkey_idx_next RENAME TO oolix_consent_pkey_idx`,
	}
	for _, col := range indexed {
		swap = append(swap, fmt.Sprintf(`ALTER INDEX oolix_attributes_%s_idx_next RENAME TO oolix_attributes_%s_idx`, col, col))
	}
	err := retryOnLockTimeout(func() error {
		return inTx(ctx, store, func(tx pgx.Tx) error {
			for _, st := range swap {
				if _, err := tx.Exec(ctx, st); err != nil {
					return err
				}
			}
			return nil
		})
	})
	if err != nil {
		return fmt.Errorf("replacing the copy: %w", err)
	}
	rep.Customers = consented
	rep.NotConsented = people - consented
	rep.Duplicates = rows - people
	return nil
}

// applyChanges applies an incremental sync's staged customers to the live
// copy in one transaction, then brings every customer's order and booking
// sums up to date.
func applyChanges(ctx context.Context, store *localstore.Store, attrCols []string, provides map[string]bool,
	now time.Time, rep *Report) error {
	fromActivity := activityColumns(provides)
	// The customer table's own columns: an update must not blank what orders
	// and bookings supply.
	var own, set []string
	for _, c := range attrCols {
		if _, ok := fromActivity[c]; ok {
			continue
		}
		own = append(own, c)
		if c != "partner_user_id" {
			set = append(set, c+" = excluded."+c)
		}
	}
	attrs, consent := localstore.AttributesTable, localstore.ConsentTable

	var rows, people, removed int
	err := retryOnLockTimeout(func() error {
		return inTx(ctx, store, func(tx pgx.Tx) error {
			stmts := []struct {
				sql  string
				args []any
			}{
				{sql: `CREATE TEMP TABLE oolix_changed ON COMMIT DROP AS
				   SELECT partner_user_id, bool_and(eligible AND withdrawn_at IS NULL) AS ok, count(*) AS n
				   FROM ` + stagingConsent + ` GROUP BY partner_user_id`},
				// Withdrawn, or now known to be under 18: out of the copy.
				{sql: `DELETE FROM ` + attrs + ` t USING oolix_changed c
				   WHERE t.partner_user_id = c.partner_user_id AND NOT c.ok`},
				{sql: `DELETE FROM ` + consent + ` t USING oolix_changed c
				   WHERE t.partner_user_id = c.partner_user_id AND NOT c.ok`},
				{sql: `INSERT INTO ` + consent + ` (partner_user_id, purpose_id, eligible, policy_version, updated_at)
				   SELECT partner_user_id, '` + localstore.AnyPurpose + `', true, '` + policyVersion + `', $1
				   FROM oolix_changed WHERE ok
				   ON CONFLICT (partner_user_id, purpose_id) DO UPDATE
				   SET eligible = true, withdrawn_at = NULL, updated_at = excluded.updated_at`,
					args: []any{now.UTC()}},
				{sql: `INSERT INTO ` + attrs + ` (` + strings.Join(own, ", ") + `)
				   SELECT DISTINCT ON (a.partner_user_id) ` + prefixed("a.", own) + `
				   FROM ` + stagingAttributes + ` a
				   JOIN oolix_changed c ON c.partner_user_id = a.partner_user_id AND c.ok
				   ORDER BY a.partner_user_id, a.ctid DESC
				   ON CONFLICT (partner_user_id) DO UPDATE SET ` + strings.Join(set, ", ")},
			}
			if len(fromActivity) > 0 {
				// The windows move every day, so every customer's sums are
				// recomputed; only rows whose sums changed are written.
				var cols, values, fresh []string
				for c, expr := range fromActivity {
					cols = append(cols, c)
					values = append(values, expr+" AS "+c)
					fresh = append(fresh, c+" = x."+c)
				}
				stmts = append(stmts, struct {
					sql  string
					args []any
				}{sql: `WITH ` + activitySums + `
				   UPDATE ` + attrs + ` t SET ` + strings.Join(fresh, ", ") + `
				   FROM (SELECT a.partner_user_id, ` + strings.Join(values, ", ") + `
				         FROM ` + attrs + ` a LEFT JOIN g ON g.partner_user_id = a.partner_user_id) x
				   WHERE t.partner_user_id = x.partner_user_id
				     AND (` + prefixed("t.", cols) + `) IS DISTINCT FROM (` + prefixed("x.", cols) + `)`,
					args: activityWindows(now)})
			}
			for _, st := range stmts {
				if _, err := tx.Exec(ctx, st.sql, st.args...); err != nil {
					return err
				}
			}
			if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(n), 0), count(*), count(*) FILTER (WHERE NOT ok)
				FROM oolix_changed`).Scan(&rows, &people, &removed); err != nil {
				return err
			}
			return nil
		})
	})
	if err != nil {
		return fmt.Errorf("applying the changes: %w", err)
	}
	if err := store.Pool.QueryRow(ctx, `SELECT count(*) FROM `+attrs).Scan(&rep.Customers); err != nil {
		return err
	}
	rep.Changed = people
	rep.NotConsented = removed
	rep.Duplicates = rows - people
	return filled(ctx, store.Pool, attrs, rep)
}

func inTx(ctx context.Context, store *localstore.Store, fn func(pgx.Tx) error) error {
	tx, err := store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '20s'`); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// retryOnLockTimeout tries a few times when the tables are busy: a count that
// runs for minutes should not fail a sync that took an hour.
func retryOnLockTimeout(fn func() error) error {
	for attempt := 1; ; attempt++ {
		err := fn()
		var pgErr *pgconn.PgError
		if err == nil || attempt == 3 || !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
			return err
		}
	}
}

// filled counts, per attribute in the report, the customers in a table with
// a value.
func filled(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, table string, rep *Report) error {
	var keys, exprs []string
	for _, a := range standard.Attributes {
		if _, ok := rep.Attributes[a.Key]; ok {
			keys = append(keys, a.Key)
			exprs = append(exprs, "count("+a.Column+")")
		}
	}
	if len(keys) == 0 {
		return nil
	}
	counts := make([]int, len(keys))
	dest := make([]any, len(keys))
	for i := range counts {
		dest[i] = &counts[i]
	}
	if err := q.QueryRow(ctx, `SELECT `+strings.Join(exprs, ", ")+` FROM `+table).Scan(dest...); err != nil {
		return err
	}
	for i, key := range keys {
		ar := rep.Attributes[key]
		ar.Filled = counts[i]
		rep.Attributes[key] = ar
	}
	return nil
}

func prefixed(prefix string, cols []string) string {
	out := make([]string, len(cols))
	for i, c := range cols {
		out[i] = prefix + c
	}
	return strings.Join(out, ", ")
}

func top(counts map[string]int, n int) []detect.ValueCount {
	out := make([]detect.ValueCount, 0, len(counts))
	for v, c := range counts {
		out = append(out, detect.ValueCount{Value: v, Count: c})
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && (out[j].Count > out[j-1].Count ||
			(out[j].Count == out[j-1].Count && out[j].Value < out[j-1].Value)); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	if len(out) > n {
		out = out[:n]
	}
	return out
}
