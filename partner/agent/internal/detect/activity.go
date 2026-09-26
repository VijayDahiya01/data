package detect

import (
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/standard"
)

// ActivitySuggestion is what the tool found in an orders or bookings table.
// Empty fields are columns it could not find.
type ActivitySuggestion struct {
	CustomerColumn string
	DateColumn     string
	Order          clean.Order
	CategoryColumn string
	PaymentColumn  string
	ChannelColumn  string
	TripColumn     string
}

// ActivityKind guesses from a table's name whether it lists orders or
// bookings: "orders", "bookings", or "".
func ActivityKind(table string) string {
	name := strings.ToLower(table)
	for _, hint := range []string{"booking", "reservation", "trip", "pnr", "ticket", "itinerar"} {
		if strings.Contains(name, hint) {
			return "bookings"
		}
	}
	for _, hint := range []string{"order", "transaction", "txn", "purchase", "sale", "invoice", "payment"} {
		if strings.Contains(name, hint) {
			return "orders"
		}
	}
	return ""
}

// SuggestActivity picks the columns of an orders table (kind "orders") or a
// bookings table ("bookings"). idColumn is the customer table's id column,
// whose name an orders table often repeats.
func SuggestActivity(kind string, columns []Column, samples map[string][]any, idColumn string,
	now time.Time) ActivitySuggestion {
	var s ActivitySuggestion

	// The customer column. In an orders table "id" is the order's own, so
	// only names that say "customer" count -- or the customer table's own id
	// name, when it is more telling than "id".
	hints := []string{}
	for _, h := range standard.IDHints {
		if h != "id" && h != "_id" {
			hints = append(hints, h)
		}
	}
	best := 0.0
	for _, c := range columns {
		score := nameScore(c.Name, hints)
		if idColumn != "" && idColumn != "id" && idColumn != "_id" && strings.EqualFold(c.Name, idColumn) {
			score = 1.1
		}
		if c.PrimaryKey && score < 1.1 {
			continue
		}
		if score > best {
			s.CustomerColumn, best = c.Name, score
		}
	}

	dateHints := standard.OrderDateHints
	if kind == "bookings" {
		dateHints = standard.BookingDateHints
	}
	when := standard.Attribute{Key: "activity_date", Kind: standard.KindTimestamp, Hints: dateHints}
	best = 0
	for _, c := range columns {
		name := nameScore(c.Name, dateHints)
		if name == 0 {
			continue
		}
		m := measure(when, c, samples[c.Name], now)
		if m.Sampled == 0 || m.Readable < 0.8 {
			continue
		}
		if score := 0.6*name + 0.4*m.Readable; score > best {
			s.DateColumn, s.Order, best = c.Name, m.Order, score
		}
	}

	pick := func(key string, hints []string, least float64) string {
		a, ok := standard.ByKey(key)
		if key == standard.OrderChannel.Key {
			a, ok = standard.OrderChannel, true
		}
		if !ok {
			return ""
		}
		chosen, top := "", 0.0
		for _, c := range columns {
			if c.Name == s.CustomerColumn || c.Name == s.DateColumn {
				continue
			}
			name := nameScore(c.Name, hints)
			if name == 0 {
				continue
			}
			m := measure(a, c, samples[c.Name], now)
			if m.Sampled == 0 || m.Readable < least {
				continue
			}
			if score := 0.6*name + 0.4*m.Readable; score > top {
				chosen, top = c.Name, score
			}
		}
		return chosen
	}
	if kind == "bookings" {
		s.TripColumn = pick("domestic_international", standard.TripHints, 0.5)
		return s
	}
	// A catalogue has more categories than the taxonomy's eight; the setup
	// page asks about the rest, so a column that is only partly readable is
	// still the right one.
	s.CategoryColumn = pick("purchase_category", standard.CategoryHints, 0.3)
	s.PaymentColumn = pick("payment_method", standard.PaymentHints, 0.5)
	s.ChannelColumn = pick(standard.OrderChannel.Key, standard.OrderChannel.Hints, 0.5)
	return s
}
