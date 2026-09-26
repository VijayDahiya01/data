package setupui

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"sort"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/standard"
)

// The optional step for a table with one row per order, or per booking.

// provided explains what the Agent works out from each kind of table.
var provided = map[string]string{
	"purchase_recency_days":  "from the latest order's date",
	"purchase_frequency":     "orders in the last 90 days",
	"purchase_category":      "the most common in the last 12 months",
	"payment_method":         "the most common in the last 12 months",
	"online_shopper":         "any order placed online in the last 12 months",
	"booking_recency_days":   "from the latest booking's date",
	"recent_booking":         "any booking in the last 12 months",
	"domestic_international": "the latest trip in the last 12 months",
}

type activityField struct {
	Key, Label, Expects, Column string
	Measure                     managed.Measurement
	Percent                     int
	Codes                       []string
	Answers                     []answer
}

type offeredAttr struct {
	Key, Label, How string
	Offered         bool
}

type activityCard struct {
	Kind, Title, Lead string
	Table             string
	Tables            []tableRow
	Columns           []columnOption
	Customer, Date    string
	AskOrder          bool
	Order, OrderNote  string
	DateMeasure       managed.Measurement
	DatePercent       int
	// InWindow is the share of readable dates within the last two years.
	InWindow  int
	Fields    []activityField
	AllOnline bool
	Offers    []offeredAttr
	Problem   string
}

type activityData struct {
	Cards []activityCard
}

var activityDate = standard.Attribute{Key: "activity_date", Kind: standard.KindTimestamp}

func activityFieldDefs(kind string) []struct{ key, label, expects string } {
	if kind == "bookings" {
		return []struct{ key, label, expects string }{
			{"domestic_international", "Domestic or international", "Domestic or international. Optional."},
		}
	}
	return []struct{ key, label, expects string }{
		{"purchase_category", "What was bought", "Category or department (Shoes, Groceries...). Optional."},
		{"payment_method", "How it was paid", "UPI, card, COD, wallet... Optional."},
		{standard.OrderChannel.Key, "Where it was placed", "App, website, store... Optional."},
	}
}

func fieldColumn(am *managed.ActivityMapping, key string) string {
	switch key {
	case "purchase_category":
		return am.CategoryColumn
	case "payment_method":
		return am.PaymentColumn
	case standard.OrderChannel.Key:
		return am.ChannelColumn
	case "domestic_international":
		return am.TripColumn
	}
	return ""
}

func (s *Server) activityPage(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	if st.draft == nil || st.draft.IDColumn == "" {
		redirect(w, r, "/review")
		return
	}
	v := s.view(r, sess, st, "Orders and bookings", "/activity")
	tables, err := s.tables(ctx, *st.source)
	if err != nil {
		v.Error = explain(err, *st.source)
	}
	d := activityData{}
	for _, kind := range []string{"orders", "bookings"} {
		d.Cards = append(d.Cards, s.activityCard(ctx, st, kind, tables))
	}
	v.Data = d
	s.render(w, "activity.html", v)
}

func activityOf(m *managed.Mapping, kind string) *managed.ActivityMapping {
	if kind == "bookings" {
		return m.Bookings
	}
	return m.Orders
}

func (s *Server) activityCard(ctx context.Context, st state, kind string, tables []source.Table) activityCard {
	now := s.opts.Now()
	c := activityCard{Kind: kind, Title: "Orders", Lead: "A table with one row per order. The Agent works " +
		"out when each customer last bought, how often, what they buy most and how they pay."}
	if kind == "bookings" {
		c.Title, c.Lead = "Bookings", "A table with one row per booking. The Agent works out when each "+
			"customer last booked, and whether their latest trip was domestic or international."
	}
	am := activityOf(st.draft, kind)
	if am != nil {
		c.Table = am.Table
	}
	for _, t := range tables {
		if t.Name == st.draft.Table {
			continue
		}
		c.Tables = append(c.Tables, tableRow{Name: t.Name, Rows: t.Rows,
			Likely: detect.ActivityKind(t.Name) == kind, Selected: t.Name == c.Table})
	}
	sort.SliceStable(c.Tables, func(i, j int) bool { return c.Tables[i].Likely && !c.Tables[j].Likely })
	if am == nil || am.Table == "" {
		return c
	}
	p, err := s.previewOf(ctx, st, am.Table)
	if err != nil {
		c.Problem = "Could not read a sample of " + am.Table + ": " + err.Error()
		return c
	}
	for _, col := range p.columns {
		c.Columns = append(c.Columns, columnOption{Name: col.Name, Type: col.Type})
	}
	c.Customer, c.Date, c.AllOnline = am.CustomerColumn, am.DateColumn, am.AllOnline

	if am.DateColumn != "" {
		values := p.sample[am.DateColumn]
		order := am.Order
		report := clean.DetectOrder(values)
		if report.DayFirst+report.MonthFirst+report.Ambiguous > 0 {
			c.AskOrder = true
			decision := report.Decide()
			if !decision.Confident {
				c.OrderNote = decision.Note
			}
			if order == clean.OrderUnknown {
				order = decision.Order
			}
		}
		switch order {
		case clean.DayFirst:
			c.Order = "day"
		case clean.MonthFirst:
			c.Order = "month"
		}
		ms, _ := managed.Measure(activityDate, managed.AttributeMapping{Column: am.DateColumn, Order: order},
			"", values, now)
		c.DateMeasure, c.DatePercent = ms, ms.Percent()
		oldest, inWindow := now.AddDate(0, 0, -standard.HistoryDays), 0
		for _, raw := range values {
			if t, ok := clean.ParseTimestamp(raw, clean.DateOptions{Order: order}); ok && !t.Before(oldest) {
				inWindow++
			}
		}
		c.InWindow = percent(inWindow, ms.Readable)
	}

	for _, def := range activityFieldDefs(kind) {
		f := activityField{Key: def.key, Label: def.label, Expects: def.expects, Column: fieldColumn(am, def.key)}
		a := standard.OrderChannel
		if def.key != standard.OrderChannel.Key {
			a, _ = standard.ByKey(def.key)
		}
		f.Codes = a.Allowed
		if f.Column != "" {
			overrides := am.Overrides[def.key]
			ms, err := managed.Measure(a, managed.AttributeMapping{Column: f.Column, Overrides: overrides},
				"", p.sample[f.Column], now)
			if err == nil {
				f.Measure, f.Percent = ms, ms.Percent()
				f.Answers = answersFor(overrides, ms)
			}
		}
		c.Fields = append(c.Fields, f)
	}

	provides := managed.ActivityProvides(managed.Mapping{Orders: st.draft.Orders, Bookings: st.draft.Bookings})
	keys := standard.OrderKeys
	if kind == "bookings" {
		keys = standard.BookingKeys
	}
	for _, key := range keys {
		if !provides[key] {
			continue
		}
		c.Offers = append(c.Offers, offeredAttr{Key: key, Label: label(key), How: provided[key],
			Offered: !slices.Contains(am.Withhold, key)})
	}
	return c
}

// answersFor lists the Partner's earlier answers, then the values still open.
func answersFor(overrides map[string]string, ms managed.Measurement) []answer {
	var out []answer
	for _, raw := range sortedKeys(overrides) {
		code := overrides[raw]
		if code == "" {
			code = "-"
		}
		out = append(out, answer{Raw: raw, Code: code})
	}
	for _, u := range ms.Unrecognised {
		out = append(out, answer{Raw: u.Value, Count: u.Count})
	}
	return out
}

func (s *Server) saveActivity(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	if st.draft == nil || st.draft.IDColumn == "" || st.source == nil {
		redirect(w, r, "/review")
		return
	}
	tables, err := s.tables(ctx, *st.source)
	if err != nil {
		redirect(w, r, "/activity")
		return
	}
	m := *st.draft
	problems := map[string]string{}
	for _, kind := range []string{"orders", "bookings"} {
		am, problem, err := s.readActivityForm(ctx, st, r, kind, tables)
		if err != nil {
			s.fail(w, err)
			return
		}
		if problem != "" {
			problems[kind] = problem
		}
		if kind == "orders" {
			m.Orders = am
		} else {
			m.Bookings = am
		}
	}
	if err := s.settings.SaveDraft(ctx, m); err != nil {
		s.fail(w, err)
		return
	}
	if r.PostFormValue("action") != "next" {
		redirect(w, r, "/activity?notice=saved")
		return
	}
	if len(problems) > 0 {
		st.draft = &m
		v := s.view(r, sess, st, "Orders and bookings", "/activity")
		d := activityData{}
		for _, kind := range []string{"orders", "bookings"} {
			card := s.activityCard(ctx, st, kind, tables)
			if card.Problem == "" {
				card.Problem = problems[kind]
			}
			d.Cards = append(d.Cards, card)
		}
		v.Data = d
		v.Error = "Some choices are missing below."
		s.render(w, "activity.html", v)
		return
	}
	redirect(w, r, "/consent")
}

// readActivityForm reads one card of the form. A table newly chosen gets the
// tool's suggestions; otherwise the Partner's choices are kept as posted.
func (s *Server) readActivityForm(ctx context.Context, st state, r *http.Request, kind string,
	tables []source.Table) (*managed.ActivityMapping, string, error) {
	f := func(name string) string { return r.PostFormValue(kind + "_" + name) }
	table := f("table")
	if table == "" || table == st.draft.Table ||
		!slices.ContainsFunc(tables, func(t source.Table) bool { return t.Name == table }) {
		return nil, "", nil
	}
	p, err := s.previewOf(ctx, st, table)
	if err != nil {
		return &managed.ActivityMapping{Table: table}, "Could not read a sample of " + table + ".", nil
	}
	known := map[string]bool{}
	for _, c := range p.columns {
		known[c.Name] = true
	}
	prev := activityOf(st.draft, kind)
	if prev == nil || prev.Table != table {
		// A table newly chosen: start from what the tool found.
		sg := detect.SuggestActivity(kind, p.columns, p.sample, st.draft.IDColumn, s.opts.Now())
		return &managed.ActivityMapping{Table: table, CustomerColumn: sg.CustomerColumn,
			DateColumn: sg.DateColumn, Order: sg.Order, CategoryColumn: sg.CategoryColumn,
			PaymentColumn: sg.PaymentColumn, ChannelColumn: sg.ChannelColumn, TripColumn: sg.TripColumn}, "", nil
	}
	col := func(name string) string {
		if c := f(name); known[c] {
			return c
		}
		return ""
	}
	am := &managed.ActivityMapping{Table: table, CustomerColumn: col("customer"), DateColumn: col("date"),
		Overrides: map[string]map[string]string{}}
	switch f("order") {
	case "day":
		am.Order = clean.DayFirst
	case "month":
		am.Order = clean.MonthFirst
	}
	if kind == "bookings" {
		am.TripColumn = col("domestic_international")
	} else {
		am.CategoryColumn = col("purchase_category")
		am.PaymentColumn = col("payment_method")
		am.ChannelColumn = col(standard.OrderChannel.Key)
		am.AllOnline = f("all_online") == "on"
		if am.AllOnline {
			am.ChannelColumn = ""
		}
	}
	for _, def := range activityFieldDefs(kind) {
		column := fieldColumn(am, def.key)
		if column == "" || column != fieldColumn(prev, def.key) {
			continue // answers belong to the column they were given for
		}
		a := standard.OrderChannel
		if def.key != standard.OrderChannel.Key {
			a, _ = standard.ByKey(def.key)
		}
		answers := map[string]string{}
		for i := 0; i < 200; i++ {
			raw := f(fmt.Sprintf("raw_%s_%d", def.key, i))
			if raw == "" {
				break
			}
			switch code := f(fmt.Sprintf("code_%s_%d", def.key, i)); {
			case code == "-":
				answers[raw] = ""
			case slices.Contains(a.Allowed, code):
				answers[raw] = code
			}
		}
		if len(answers) > 0 {
			am.Overrides[def.key] = answers
		}
	}
	keys := standard.OrderKeys
	if kind == "bookings" {
		keys = standard.BookingKeys
	}
	for _, key := range keys {
		// Only what was on the page can have been switched off.
		if f("shown_"+key) == "1" && f("offer_"+key) != "on" {
			am.Withhold = append(am.Withhold, key)
		}
	}
	switch {
	case am.CustomerColumn == "":
		return am, "Choose the column with the customer ID.", nil
	case am.DateColumn == "":
		return am, fmt.Sprintf("Choose the column with the date of the %s.", map[string]string{
			"orders": "order", "bookings": "booking"}[kind]), nil
	}
	return am, "", nil
}
