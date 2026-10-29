package managed

import (
	"strings"

	"github.com/oolix/partner-agent/internal/source"
)

// Platform layouts. A store on a known platform keeps its customers and orders
// in the same tables as every other store on it, so the setup page fills in
// the choices and the Partner confirms them instead of making each one.

// Layout is a platform's choices for the setup page.
type Layout struct {
	Platform string
	// Table and IDColumn are the customer table and the ID the website
	// knows a signed-in customer by; Joins, more about the same customers.
	Table    string
	IDColumn string
	Joins    []source.Join
	// Consent is where the platform, or a plugin on it, records marketing
	// consent; empty when it records none.
	Consent ConsentMapping
	Orders  *ActivityMapping
	// Uses names the tables read, for the page to show.
	Uses []string
	// IDMeans and ConsentMeans say in plain words what the ID and the
	// consent column are; OrdersLeftOut, which orders do not count.
	IDMeans, ConsentMeans, OrdersLeftOut string
}

// DetectLayout finds a known platform among a database's tables.
func DetectLayout(tables []source.Table) (Layout, bool) {
	return wooCommerce(tables)
}

// WooCommerce's order statuses: completed, and processing -- paid and being
// prepared, as most cash-on-delivery orders stay until they are delivered.
// The rest are not purchases yet, or no longer.
var (
	wooCounted    = []string{"wc-completed", "wc-processing"}
	wooNotCounted = []string{"wc-pending", "wc-on-hold", "wc-cancelled", "wc-refunded", "wc-failed",
		"wc-checkout-draft", "trash", "draft", "auto-draft"}
)

// wooCommerce reads a WooCommerce store (MySQL, tables with the site's prefix,
// wp_ unless changed):
//
//   - customers: wc_customer_lookup, one row per customer, by user_id -- the
//     WordPress user ID the website knows a signed-in customer by; guests,
//     who have none, cannot be recognised and are left out;
//   - orders: wc_orders, the order storage WooCommerce has made the default
//     since 8.2, with the same user ID, its payment method, and refunds kept
//     apart by type; else the analytics table wc_order_stats, which names a
//     customer by the lookup table's own customer_id and keeps refunds as
//     rows with a parent order;
//   - consent: WooCommerce records none. MailPoet, its newsletter plugin,
//     does: subscribed, by WordPress user.
func wooCommerce(tables []source.Table) (Layout, bool) {
	names := map[string]bool{}
	for _, t := range tables {
		names[t.Name] = true
	}
	for _, t := range tables {
		prefix, ok := strings.CutSuffix(t.Name, "wc_customer_lookup")
		if !ok {
			continue
		}
		l := Layout{Platform: "WooCommerce", Table: t.Name, IDColumn: "user_id", Uses: []string{t.Name},
			IDMeans:       "the WordPress user ID your website knows a signed-in customer by",
			OrdersLeftOut: "pending, on-hold, cancelled, failed and refunded orders, and refunds themselves"}
		status := func() *StatusFilter {
			return &StatusFilter{Column: "status", Counted: wooCounted, NotCounted: wooNotCounted}
		}
		switch {
		case names[prefix+"wc_orders"]:
			l.Orders = &ActivityMapping{Table: prefix + "wc_orders", CustomerColumn: "customer_id",
				DateColumn: "date_created_gmt", DateInUTC: true, Status: status(),
				Only:          []RowFilter{{Column: "type", Values: []string{"shop_order"}}},
				PaymentColumn: "payment_method", AllOnline: true}
		case names[prefix+"wc_order_stats"]:
			l.Orders = &ActivityMapping{Table: prefix + "wc_order_stats", CustomerColumn: "customer_id",
				CustomerKey: "customer_id", DateColumn: "date_created", Status: status(),
				Only: []RowFilter{{Column: "parent_id", Values: []string{"0"}}}, AllOnline: true}
		}
		if l.Orders != nil {
			l.Uses = append(l.Uses, l.Orders.Table)
		}
		if mp := prefix + "mailpoet_subscribers"; names[mp] {
			l.Joins = []source.Join{{Table: mp, Key: "wp_user_id"}}
			l.Consent = ConsentMapping{Column: mp + ".status"}
			l.ConsentMeans = "MailPoet's subscriptions: a customer subscribed to your emails agreed to marketing"
			l.Uses = append(l.Uses, mp)
		}
		return l, true
	}
	return Layout{}, false
}

// Explain says what the layout fills in, step by step, for the setup page.
func (l Layout) Explain() []string {
	out := []string{"Customers: " + l.Table + ", by " + l.IDColumn + ", " + l.IDMeans +
		". Guest checkouts have none, so they are left out."}
	if o := l.Orders; o != nil {
		out = append(out, "Orders: "+o.Table+", counting completed and processing orders; "+l.OrdersLeftOut+
			" are left out.")
	} else {
		out = append(out, "Orders: no orders table was found; you can choose one on the orders step.")
	}
	if l.Consent.Column != "" {
		out = append(out, "Consent: "+l.ConsentMeans+".")
	} else {
		out = append(out, l.Platform+" does not record marketing consent itself: on the consent step, "+
			"choose the column of the plugin that does.")
	}
	return out
}

// Apply puts the layout's choices into a draft started from the customer
// table's sample, keeping the attributes the sample suggested.
func (l Layout) Apply(m *Mapping) {
	m.Table, m.IDColumn, m.Joins = l.Table, l.IDColumn, l.Joins
	if l.Consent.Column != "" {
		m.Consent = l.Consent
	}
	if l.Orders != nil {
		o := *l.Orders
		m.Orders = &o
	}
	// The suggestions from the sample may have taken the layout's columns
	// for something else: the ID is the ID.
	for key, am := range m.Attributes {
		if am.Column == l.IDColumn {
			delete(m.Attributes, key)
		}
	}
}
