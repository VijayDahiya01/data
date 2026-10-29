package managed

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/testdb"
)

func tablesNamed(names ...string) []source.Table {
	var out []source.Table
	for _, n := range names {
		out = append(out, source.Table{Name: n, Rows: -1})
	}
	return out
}

func TestWooCommerceLayout(t *testing.T) {
	// Today's storage, with MailPoet.
	l, ok := DetectLayout(tablesNamed("wp_posts", "wp_users", "wp_usermeta", "wp_wc_customer_lookup",
		"wp_wc_orders", "wp_wc_order_stats", "wp_mailpoet_subscribers"))
	if !ok || l.Platform != "WooCommerce" || l.Table != "wp_wc_customer_lookup" || l.IDColumn != "user_id" {
		t.Fatalf("layout %+v", l)
	}
	o := l.Orders
	if o == nil || o.Table != "wp_wc_orders" || o.CustomerColumn != "customer_id" || o.CustomerKey != "" ||
		!o.DateInUTC || o.PaymentColumn != "payment_method" || !o.AllOnline ||
		len(o.Only) != 1 || o.Only[0].Column != "type" {
		t.Errorf("orders %+v", o)
	}
	if c, _ := o.Status.Decide("wc-processing"); !c {
		t.Error("a processing order does not count")
	}
	if c, _ := o.Status.Decide("wc-refunded"); c {
		t.Error("a refunded order counts")
	}
	if l.Consent.Column != "wp_mailpoet_subscribers.status" || len(l.Joins) != 1 || l.Joins[0].Key != "wp_user_id" {
		t.Errorf("consent %+v, joins %+v", l.Consent, l.Joins)
	}

	// An older store with its own prefix: the analytics table, by the
	// lookup's number, refunds as rows with a parent.
	l, ok = DetectLayout(tablesNamed("shop7_wc_customer_lookup", "shop7_wc_order_stats", "shop7_posts"))
	if !ok || l.Table != "shop7_wc_customer_lookup" || l.Orders == nil ||
		l.Orders.Table != "shop7_wc_order_stats" || l.Orders.CustomerKey != "customer_id" ||
		l.Orders.DateInUTC || l.Orders.Only[0].Column != "parent_id" || len(l.Joins) != 0 {
		t.Fatalf("older store: %+v %+v", l, l.Orders)
	}
	steps := strings.Join(l.Explain(), " ")
	for _, want := range []string{"WordPress user ID", "shop7_wc_order_stats", "does not record marketing consent"} {
		if !strings.Contains(steps, want) {
			t.Errorf("explanation lacks %q: %s", want, steps)
		}
	}

	if _, ok := DetectLayout(tablesNamed("customers", "orders", "wc_customer_lookup_backup")); ok {
		t.Error("a store that is not WooCommerce was taken for one")
	}

	// Applied to a draft from the sample: the ID is the layout's, and a
	// suggestion that took the ID column for something else goes.
	m := Mapping{Table: "wp_wc_customer_lookup", IDColumn: "customer_id",
		Attributes: map[string]AttributeMapping{"city": {Column: "city"}, "age": {Column: "user_id"}}}
	l, _ = DetectLayout(tablesNamed("wp_wc_customer_lookup", "wp_wc_orders"))
	l.Apply(&m)
	if m.IDColumn != "user_id" || m.Orders == nil || m.Orders == l.Orders || m.Attributes["city"].Column != "city" {
		t.Errorf("applied: %+v", m)
	}
	if _, ok := m.Attributes["age"]; ok {
		t.Error("the ID column stayed mapped as an attribute")
	}
}

// A WooCommerce store's older order storage, end to end on a real database:
// orders found through the lookup table, only completed and processing ones
// counted, refunds and guests left out, consent from MailPoet.
func TestSyncReadsAWooCommerceStore(t *testing.T) {
	store := localStore(t)
	ctx := context.Background()
	partnerURL := testdb.URL(t, "managed_source")
	db, err := pgx.Connect(ctx, partnerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)
	for _, sql := range []string{
		`DROP TABLE IF EXISTS wp_wc_customer_lookup, wp_wc_order_stats, wp_mailpoet_subscribers`,
		`CREATE TABLE wp_wc_customer_lookup (customer_id bigint PRIMARY KEY, user_id bigint, city text,
		   state text, postcode text)`,
		`CREATE TABLE wp_wc_order_stats (order_id bigint PRIMARY KEY, parent_id bigint NOT NULL,
		   status text NOT NULL, customer_id bigint NOT NULL, date_created timestamp NOT NULL)`,
		`CREATE TABLE wp_mailpoet_subscribers (id bigint PRIMARY KEY, wp_user_id bigint, status text)`,
		// Asha (user 7), Ravi (user 8), and a guest with no WordPress user.
		`INSERT INTO wp_wc_customer_lookup VALUES (1, 7, 'Mumbai', 'MH', '400001'),
		   (2, 8, 'Kochi', 'KL', '682001'), (3, NULL, 'Pune', 'MH', '411001')`,
		`INSERT INTO wp_wc_order_stats VALUES
		   (101, 0, 'wc-completed', 1, '2026-09-20 10:00:00'),
		   (102, 0, 'wc-processing', 1, '2026-09-10 10:00:00'),
		   (103, 0, 'wc-cancelled', 1, '2026-09-15 10:00:00'),
		   (104, 101, 'wc-completed', 1, '2026-09-21 10:00:00'),
		   (105, 0, 'wc-completed', 3, '2026-09-01 10:00:00'),
		   (106, 0, 'wc-shipped', 2, '2026-09-05 10:00:00'),
		   (107, 0, 'wc-failed', 2, '2026-09-06 10:00:00')`,
		`INSERT INTO wp_mailpoet_subscribers VALUES (1, 7, 'subscribed'), (2, 8, 'unsubscribed')`,
	} {
		if _, err := db.Exec(ctx, sql); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	t.Cleanup(func() {
		_, _ = db.Exec(context.Background(),
			`DROP TABLE IF EXISTS wp_wc_customer_lookup, wp_wc_order_stats, wp_mailpoet_subscribers`)
	})

	src, err := source.Open(ctx, source.Config{Kind: source.Postgres, URI: partnerURL})
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	tables, err := src.Tables(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var woo []source.Table
	for _, tb := range tables {
		if strings.HasPrefix(tb.Name, "wp_") {
			woo = append(woo, tb)
		}
	}
	l, ok := DetectLayout(woo)
	if !ok || l.Orders == nil || l.Orders.Table != "wp_wc_order_stats" {
		t.Fatalf("layout from %v: %+v", woo, l)
	}
	m := Mapping{Attributes: map[string]AttributeMapping{"city": {Column: "city", Publish: true}}}
	l.Apply(&m)

	rep, err := Sync(ctx, src, store, m, now)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Customers != 1 {
		t.Errorf("copied %d customers, want Asha alone (Ravi unsubscribed, the guest has no ID)", rep.Customers)
	}
	o := rep.Activity["orders"]
	if o.RowsRead != 7 || o.NotCounted != 3 || o.WithoutCustomer != 1 || o.Used != 3 {
		t.Errorf("orders read: %+v", o)
	}
	if len(o.Undecided) != 1 || o.Undecided["wc-shipped"] != 1 {
		t.Errorf("undecided statuses %v", o.Undecided)
	}
	var last time.Time
	var frequency int32
	if err := store.Pool.QueryRow(ctx, `SELECT last_order_at, purchase_frequency FROM oolix_audience_attributes
		WHERE partner_user_id = $1`, store.ScrambleID("7")).Scan(&last, &frequency); err != nil {
		t.Fatal(err)
	}
	// The completed and the processing order; not the cancelled one, nor the
	// refund dated after them.
	if frequency != 2 || !last.Equal(time.Date(2026, 9, 20, 10, 0, 0, 0, clean.India)) {
		t.Errorf("Asha: %d orders, last %v", frequency, last)
	}
}
