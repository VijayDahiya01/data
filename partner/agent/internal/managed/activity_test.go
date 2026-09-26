package managed

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/oolix/partner-agent/internal/audience"
	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/testdb"
)

// now is 26 Sep 2026, 12:00 UTC. Times in the files are India time.
const (
	shopCustomers = `customer_id,DOB,City,marketing_opt_in,last_order_date,fav_category
C1,14/04/1992,Mumbai,yes,01/01/2020,Beauty
C2,15/05/1990,Pune,yes,,
C3,16/06/1985,Delhi,no,,
C4,17/07/1980,Chennai,yes,,
`
	shopOrders = `order_id,customer_id,order_date,category,pay_mode,channel
O1,C1,2026-09-20 10:00:00,Shoes,GPay,App
O2,C1,2026-08-01 10:00:00,Sneakers,Credit Card,Store
O3,C1,2026-01-15 10:00:00,Electronics,UPI,Web
O4,C1,2023-01-01 10:00:00,Grocery,COD,Store
O5,C2,2025-12-01 10:00:00,Groceries,Cash,Store
O6,C3,2026-09-01 10:00:00,Beauty,UPI,App
O7,,2026-09-01 10:00:00,Beauty,UPI,App
O8,C2,not a date,Beauty,UPI,App
O9,C1,2026-09-25 10:00:00,Stationery,Paytm Wallet,Kiosk
`
	shopBookings = `booking_id,customer_id,booked_on,trip
B1,C2,2026-03-10,International
B2,C2,2026-07-01,Domestic
B3,C1,2025-06-01,Domestic
`
)

func TestSyncSumsUpOrdersAndBookings(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	dir := t.TempDir()
	for name, body := range map[string]string{
		"customers.csv": shopCustomers, "orders.csv": shopOrders, "bookings.csv": shopBookings,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	src, err := source.Open(ctx, source.Config{Kind: source.File, Folder: dir})
	if err != nil {
		t.Fatal(err)
	}
	m := Mapping{
		Table: "customers.csv", IDColumn: "customer_id",
		Attributes: map[string]AttributeMapping{
			"age":  {Column: "DOB", Order: clean.DayFirst, Publish: true},
			"city": {Column: "City", Publish: true},
			// Also in the customer table, but the orders table wins.
			"purchase_recency_days": {Column: "last_order_date", Order: clean.DayFirst, Publish: true},
			"purchase_category":     {Column: "fav_category", Publish: true},
		},
		Consent: ConsentMapping{Column: "marketing_opt_in"},
		Orders: &ActivityMapping{Table: "orders.csv", CustomerColumn: "customer_id", DateColumn: "order_date",
			CategoryColumn: "category", PaymentColumn: "pay_mode", ChannelColumn: "channel"},
		Bookings: &ActivityMapping{Table: "bookings.csv", CustomerColumn: "customer_id",
			DateColumn: "booked_on", TripColumn: "trip"},
	}

	rep, err := Sync(ctx, src, store, m, now)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Customers != 3 || rep.NotConsented != 1 {
		t.Errorf("customers %d, not consented %d", rep.Customers, rep.NotConsented)
	}
	if o := rep.Activity["orders"]; o.RowsRead != 9 || o.Used != 6 || o.Older != 1 ||
		o.WithoutCustomer != 1 || o.UnreadableDates != 1 {
		t.Errorf("orders read: %+v", o)
	}
	if u := rep.Attributes["purchase_category"].Unrecognised; len(u) != 1 || u[0].Value != "Stationery" {
		t.Errorf("unrecognised categories: %+v", u)
	}
	if u := rep.Attributes["online_shopper"].Unrecognised; len(u) != 1 || u[0].Value != "Kiosk" {
		t.Errorf("unrecognised channels: %+v", u)
	}
	for key, want := range map[string]int{
		"purchase_recency_days": 2, "purchase_frequency": 3, "purchase_category": 2, "payment_method": 2,
		"online_shopper": 3, "booking_recency_days": 2, "recent_booking": 3, "domestic_international": 1,
	} {
		if got := rep.Attributes[key].Filled; got != want {
			t.Errorf("%s filled for %d customers, want %d", key, got, want)
		}
	}

	type row struct {
		lastOrder, lastBooking  *time.Time
		frequency               *int32
		category, payment, trip *string
		online, recent          *bool
	}
	get := func(id string) row {
		var r row
		if err := store.Pool.QueryRow(ctx, `SELECT last_order_at, purchase_frequency, purchase_category,
			payment_method, online_shopper, last_booking_at, recent_booking, domestic_international
			FROM oolix_audience_attributes WHERE partner_user_id = $1`, store.ScrambleID(id)).Scan(
			&r.lastOrder, &r.frequency, &r.category, &r.payment, &r.online, &r.lastBooking, &r.recent, &r.trip); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		return r
	}
	ist := clean.India
	c1 := get("C1")
	// The latest order, O9, placed 25 Sep at 10:00 in India -- not the
	// customer table's stale 2020 date.
	if !c1.lastOrder.Equal(time.Date(2026, 9, 25, 10, 0, 0, 0, ist)) || *c1.frequency != 3 ||
		*c1.category != "FOOTWEAR" || *c1.payment != "UPI" || !*c1.online {
		t.Errorf("C1 orders: %v %d %s %s %v", c1.lastOrder, *c1.frequency, *c1.category, *c1.payment, *c1.online)
	}
	// Booked 16 months ago: known, but not recent, so no current trip type.
	if !c1.lastBooking.Equal(time.Date(2025, 6, 1, 0, 0, 0, 0, ist)) || *c1.recent || c1.trip != nil {
		t.Errorf("C1 bookings: %v %v %v", c1.lastBooking, *c1.recent, c1.trip)
	}
	c2 := get("C2")
	if *c2.frequency != 0 || *c2.category != "GROCERY" || *c2.payment != "COD" || *c2.online {
		t.Errorf("C2 orders: %d %s %s %v", *c2.frequency, *c2.category, *c2.payment, *c2.online)
	}
	if !*c2.recent || *c2.trip != "DOMESTIC" {
		t.Errorf("C2 bookings: %v %v", *c2.recent, *c2.trip)
	}
	// No orders and no bookings: known answers where there are answers.
	c4 := get("C4")
	if c4.lastOrder != nil || *c4.frequency != 0 || *c4.online || *c4.recent || c4.category != nil {
		t.Errorf("C4: %+v", c4)
	}

	// The audience code reads the sums like any column.
	ev := audience.NewEvaluator(audience.EvaluatorOptions{
		Pool: store.Pool, AttributeTable: localstore.AttributesTable,
		Mappings: EvaluatorMappings(), MappingVersion: MappingVersion,
	})
	for _, tc := range []struct {
		rule audience.Rule
		want int
	}{
		{audience.Rule{Attribute: "purchase_recency_days", Operator: audience.OpLTE, Value: 30.0, Required: true}, 1},
		{audience.Rule{Attribute: "purchase_frequency", Operator: audience.OpGTE, Value: 2.0, Required: true}, 1},
		{audience.Rule{Attribute: "recent_booking", Operator: audience.OpEQ, Value: true, Required: true}, 1},
	} {
		res, err := ev.Materialize(ctx, uuid.NewString(), "ag", 1, []audience.Rule{tc.rule}, "", time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		if res.MemberCount != tc.want {
			t.Errorf("%s: %d members, want %d", tc.rule.Attribute, res.MemberCount, tc.want)
		}
	}

	// And they are offered to advertisers.
	caps, err := BuildCapabilities(Mapping{Attributes: map[string]AttributeMapping{}, Orders: m.Orders,
		Bookings: m.Bookings}, &rep)
	if err == nil {
		keys := caps.Keys()
		for _, want := range []string{"purchase_recency_days", "purchase_frequency", "recent_booking"} {
			if !slices.Contains(keys, want) {
				t.Errorf("%s not offered: %v", want, keys)
			}
		}
	} else {
		t.Error(err)
	}
}

func TestIncrementalSyncAppliesChangesAndTheWeeklyFullSyncCatchesDeletions(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	partnerURL := testdb.URL(t, "managed_source")
	db, err := pgx.Connect(ctx, partnerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	at := func(day int) time.Time { return time.Date(2026, 9, day, 9, 0, 0, 0, time.UTC) }
	exec(`DROP TABLE IF EXISTS crm`)
	exec(`CREATE TABLE crm (id text PRIMARY KEY, city text, consent boolean, updated_at timestamptz)`)
	for _, id := range []string{"C1", "C2", "C3"} {
		exec(`INSERT INTO crm VALUES ($1, 'Mumbai', true, $2)`, id, at(20))
	}

	src, err := source.Open(ctx, source.Config{Kind: source.Postgres, URI: partnerURL})
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	m := Mapping{Table: "crm", IDColumn: "id", UpdatedColumn: "updated_at",
		Attributes: map[string]AttributeMapping{"city": {Column: "city", Publish: true}},
		Consent:    ConsentMapping{Column: "consent"}}

	full, err := Sync(ctx, src, store, m, now)
	if err != nil {
		t.Fatal(err)
	}
	if full.Customers != 3 || full.Watermark == nil || !full.Watermark.Equal(at(20)) {
		t.Fatalf("full sync: %+v", full)
	}

	// A move, a withdrawal, a new customer -- and a deletion, which nothing
	// marks as changed.
	exec(`UPDATE crm SET city = 'Chennai', updated_at = $1 WHERE id = 'C1'`, at(25))
	exec(`UPDATE crm SET consent = false, updated_at = $1 WHERE id = 'C2'`, at(25))
	exec(`INSERT INTO crm VALUES ('C4', 'Pune', true, $1)`, at(25))
	exec(`DELETE FROM crm WHERE id = 'C3'`)

	inc, err := SyncChanges(ctx, src, store, m, full.Watermark.Add(-10*time.Minute), now)
	if err != nil {
		t.Fatal(err)
	}
	if inc.Mode != ModeIncremental || inc.Changed != 3 || inc.NotConsented != 1 || inc.Customers != 3 {
		t.Errorf("incremental sync: %+v", inc)
	}
	if inc.Watermark == nil || !inc.Watermark.Equal(at(25)) {
		t.Errorf("watermark %v", inc.Watermark)
	}
	city := func(id string) string {
		var c string
		err := store.Pool.QueryRow(ctx, `SELECT coalesce(city, '') FROM oolix_audience_attributes
			WHERE partner_user_id = $1`, store.ScrambleID(id)).Scan(&c)
		if err != nil {
			return "absent"
		}
		return c
	}
	for id, want := range map[string]string{"C1": "CHENNAI", "C2": "absent", "C3": "MUMBAI", "C4": "PUNE"} {
		if got := city(id); got != want {
			t.Errorf("after the incremental sync %s is %q, want %q", id, got, want)
		}
	}
	var consented int
	_ = store.Pool.QueryRow(ctx, `SELECT count(*) FROM oolix_user_consent WHERE partner_user_id = $1`,
		store.ScrambleID("C2")).Scan(&consented)
	if consented != 0 {
		t.Error("the withdrawal left consent behind")
	}

	// The weekly full sync notices C3 is gone.
	if again, err := Sync(ctx, src, store, m, now); err != nil || again.Customers != 2 {
		t.Fatalf("full sync: %+v, %v", again, err)
	}
	if city("C3") != "absent" {
		t.Error("a deleted customer survived the full sync")
	}
}
