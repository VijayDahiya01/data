package managed

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/standard"
)

// Orders and bookings: a table with one row per order, or per booking, read
// at every sync and summed up per customer. The rows are staged cleaned and
// with scrambled customer ids only, used for the sums, and dropped when the
// sync ends; the copy keeps the sums, never the orders.

// ActivityReport is what was read from an orders or bookings table.
type ActivityReport struct {
	Table    string `json:"table"`
	RowsRead int    `json:"rows_read"`
	// Used counts rows that went into a customer's sums.
	Used int `json:"used"`
	// WithoutCustomer counts rows with no customer id.
	WithoutCustomer int `json:"without_customer"`
	// UnreadableDates counts rows whose date could not be read, or lay in the
	// future.
	UnreadableDates int `json:"unreadable_dates"`
	// Older counts rows from before the history window, which no Buyer can
	// ask about.
	Older int `json:"older"`
}

const (
	stagingActivity = "oolix_sync_activity"
	kindOrders      = "orders"
	kindBookings    = "bookings"
)

// ActivityProvides lists the attributes the orders and bookings tables supply.
// For these the customer table's own column is not read.
func ActivityProvides(m Mapping) map[string]bool {
	out := map[string]bool{}
	if o := m.Orders; o != nil && o.Table != "" {
		out["purchase_recency_days"], out["purchase_frequency"] = true, true
		if o.CategoryColumn != "" {
			out["purchase_category"] = true
		}
		if o.PaymentColumn != "" {
			out["payment_method"] = true
		}
		if o.ChannelColumn != "" || o.AllOnline {
			out["online_shopper"] = true
		}
	}
	if b := m.Bookings; b != nil && b.Table != "" {
		out["booking_recency_days"], out["recent_booking"] = true, true
		if b.TripColumn != "" {
			out["domestic_international"] = true
		}
	}
	return out
}

func activityDDL(table string) string {
	return `CREATE UNLOGGED TABLE ` + table + ` (
	   partner_user_id TEXT        NOT NULL,
	   kind            TEXT        NOT NULL,
	   at              TIMESTAMPTZ NOT NULL,
	   category        TEXT,
	   payment         TEXT,
	   online          BOOLEAN,
	   trip            TEXT)`
}

// activityCleaner turns one row of an orders or bookings table into what is
// kept of it.
type activityCleaner struct {
	kind                             string
	am                               ActivityMapping
	opts                             clean.DateOptions
	category, payment, channel, trip *clean.EnumMapper
}

func attr(key string) standard.Attribute {
	if key == standard.OrderChannel.Key {
		return standard.OrderChannel
	}
	a, _ := standard.ByKey(key)
	return a
}

func newActivityCleaner(kind string, am ActivityMapping, loc *time.Location) (*activityCleaner, error) {
	c := &activityCleaner{kind: kind, am: am, opts: clean.DateOptions{Order: am.Order, Location: loc}}
	mapper := func(column, key string) (*clean.EnumMapper, error) {
		if column == "" {
			return nil, nil
		}
		return clean.NewEnumMapper(attr(key), am.Overrides[key])
	}
	var err error
	if c.category, err = mapper(am.CategoryColumn, "purchase_category"); err != nil {
		return nil, err
	}
	if c.payment, err = mapper(am.PaymentColumn, "payment_method"); err != nil {
		return nil, err
	}
	if c.channel, err = mapper(am.ChannelColumn, standard.OrderChannel.Key); err != nil {
		return nil, err
	}
	if c.trip, err = mapper(am.TripColumn, "domestic_international"); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *activityCleaner) columns() []string {
	cols := []string{c.am.CustomerColumn, c.am.DateColumn}
	for _, col := range []string{c.am.CategoryColumn, c.am.PaymentColumn, c.am.ChannelColumn, c.am.TripColumn} {
		if col != "" && !contains(cols, col) {
			cols = append(cols, col)
		}
	}
	return cols
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// code maps one list value, counting what it could not place against the
// attribute it feeds.
func code(m *clean.EnumMapper, raw any, key string, rep *Report, unrecognised map[string]map[string]int) any {
	if m == nil || strings.TrimSpace(clean.Text(raw)) == "" || m.Ignored(raw) {
		return nil
	}
	if v, ok := m.Map(raw); ok {
		return v
	}
	ar := rep.Attributes[key]
	ar.Unreadable++
	rep.Attributes[key] = ar
	if unrecognised[key] == nil {
		unrecognised[key] = map[string]int{}
	}
	unrecognised[key][strings.TrimSpace(clean.Text(raw))]++
	return nil
}

// stageActivity reads one orders or bookings table into the staging table.
func stageActivity(ctx context.Context, src source.Source, store *localstore.Store, kind string,
	am ActivityMapping, loc *time.Location, now time.Time, rep *Report,
	unrecognised map[string]map[string]int) error {
	c, err := newActivityCleaner(kind, am, loc)
	if err != nil {
		return err
	}
	ar := ActivityReport{Table: am.Table}
	oldest := now.AddDate(0, 0, -standard.HistoryDays)
	rowKind := strings.TrimSuffix(kind, "s") // "order", "booking"

	stream := func(fn func(source.Row) error) error {
		return src.Stream(ctx, am.Table, c.columns(), fn)
	}
	// A large table is read from the start of the window only, when its date
	// column is one the database can compare.
	if ss, ok := src.(source.SinceStreamer); ok && nativeDate(ctx, src, am.Table, am.DateColumn) {
		stream = func(fn func(source.Row) error) error {
			return ss.StreamSince(ctx, am.Table, c.columns(), am.DateColumn, oldest, fn)
		}
	}

	cols := []string{"partner_user_id", "kind", "at", "category", "payment", "online", "trip"}
	var batch [][]any
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		_, err := store.Pool.CopyFrom(ctx, pgx.Identifier{stagingActivity}, cols, pgx.CopyFromRows(batch))
		batch = batch[:0]
		if err != nil {
			return fmt.Errorf("writing %s: %w", kind, err)
		}
		return nil
	}

	err = stream(func(row source.Row) error {
		ar.RowsRead++
		id := strings.TrimSpace(clean.Text(row[am.CustomerColumn]))
		if id == "" {
			ar.WithoutCustomer++
			return nil
		}
		at, ok := clean.ParseTimestamp(row[am.DateColumn], c.opts)
		if !ok || at.After(now.Add(24*time.Hour)) {
			ar.UnreadableDates++
			return nil
		}
		if at.Before(oldest) {
			ar.Older++
			return nil
		}
		var online any
		switch {
		case am.AllOnline:
			online = true
		case c.channel != nil:
			if v := code(c.channel, row[am.ChannelColumn], "online_shopper", rep, unrecognised); v != nil {
				online = v == "ONLINE"
			}
		}
		batch = append(batch, []any{
			store.ScrambleID(id), rowKind, at,
			code(c.category, row[am.CategoryColumn], "purchase_category", rep, unrecognised),
			code(c.payment, row[am.PaymentColumn], "payment_method", rep, unrecognised),
			online,
			code(c.trip, row[am.TripColumn], "domestic_international", rep, unrecognised),
		})
		ar.Used++
		if len(batch) >= batchSize {
			return flush()
		}
		return nil
	})
	if err == nil {
		err = flush()
	}
	if err != nil {
		return fmt.Errorf("reading %s from %s: %w", kind, am.Table, err)
	}
	if rep.Activity == nil {
		rep.Activity = map[string]ActivityReport{}
	}
	rep.Activity[kind] = ar
	return nil
}

// nativeDate reports whether a column holds dates the database itself can
// compare.
func nativeDate(ctx context.Context, src source.Source, table, column string) bool {
	cols, err := src.Columns(ctx, table)
	if err != nil {
		return false
	}
	for _, c := range cols {
		if c.Name == column {
			return source.TimeType(c.Type)
		}
	}
	return false
}

// activitySums is the per-customer summary of the staged orders and
// bookings, as a CTE named g. $1 is the start of the 90-day window, $2 of the
// 365-day one.
const activitySums = `g AS (
  SELECT partner_user_id,
    max(at) FILTER (WHERE kind = 'order') AS last_order_at,
    count(*) FILTER (WHERE kind = 'order' AND at >= $1) AS orders_90d,
    count(*) FILTER (WHERE kind = 'order' AND at >= $2) AS orders_365d,
    mode() WITHIN GROUP (ORDER BY category)
      FILTER (WHERE kind = 'order' AND at >= $2 AND category IS NOT NULL) AS top_category,
    mode() WITHIN GROUP (ORDER BY payment)
      FILTER (WHERE kind = 'order' AND at >= $2 AND payment IS NOT NULL) AS top_payment,
    bool_or(online) FILTER (WHERE kind = 'order' AND at >= $2) AS online,
    max(at) FILTER (WHERE kind = 'booking') AS last_booking_at,
    count(*) FILTER (WHERE kind = 'booking' AND at >= $2) AS bookings_365d,
    (array_agg(trip ORDER BY at DESC)
      FILTER (WHERE kind = 'booking' AND at >= $2 AND trip IS NOT NULL))[1] AS last_trip
  FROM ` + stagingActivity + `
  GROUP BY partner_user_id)`

// activityColumns gives, for each attribute column an orders or bookings
// table supplies, its value from g. A customer with no orders has bought
// nothing online and nothing in 90 days -- known answers, not unknown ones --
// while dates and favourites stay empty.
func activityColumns(provides map[string]bool) map[string]string {
	exprs := map[string]string{
		"purchase_recency_days":  "g.last_order_at",
		"purchase_frequency":     "COALESCE(g.orders_90d, 0)::int",
		"purchase_category":      "g.top_category",
		"payment_method":         "g.top_payment",
		"online_shopper":         "CASE WHEN COALESCE(g.orders_365d, 0) = 0 THEN false ELSE g.online END",
		"booking_recency_days":   "g.last_booking_at",
		"recent_booking":         "COALESCE(g.bookings_365d, 0) > 0",
		"domestic_international": "g.last_trip",
	}
	out := map[string]string{}
	for key := range provides {
		if a, ok := standard.ByKey(key); ok {
			out[a.Column] = exprs[key]
		}
	}
	return out
}

func activityWindows(now time.Time) []any {
	return []any{
		now.AddDate(0, 0, -standard.FrequencyDays).UTC(),
		now.AddDate(0, 0, -standard.RecentDays).UTC(),
	}
}
