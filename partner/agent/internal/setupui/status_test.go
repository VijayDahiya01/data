package setupui

import (
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/source"
)

// The statuses listed: the sample's, most common first, then those only the
// last refresh met; ticked by the Partner's answers, else by their words.
func TestStatusOptions(t *testing.T) {
	f := managed.StatusFilter{Column: "status", NotCounted: []string{"wc-processing"}}
	got := statusOptions(f, []any{"wc-completed", "wc-processing", "wc-completed", "wc-cancelled", nil, " "},
		map[string]int{"wc-completed": 9, "wc-delivered": 4, "lost-in-transit": 1})
	want := []statusOption{
		{Value: "wc-completed", Count: 2, Counted: true},
		{Value: "wc-processing", Count: 1, Counted: false}, // the Partner's answer
		{Value: "wc-cancelled", Count: 1, Counted: false},
		{Value: "lost-in-transit", Count: 1, Counted: false, Since: true},
		{Value: "wc-delivered", Count: 4, Counted: true, Since: true},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%d: %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestTablePageOffersAPlatformLayout(t *testing.T) {
	pages, err := parsePages()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{opts: Options{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, pages: pages}
	l, ok := managed.DetectLayout([]source.Table{{Name: "wp_wc_customer_lookup"}, {Name: "wp_wc_orders"}})
	if !ok {
		t.Fatal("no layout")
	}
	rec := httptest.NewRecorder()
	s.render(rec, "table.html", view{Title: "Choose the customer table", CSRF: "c", Data: map[string]any{
		"Tables": []tableRow{{Name: "wp_wc_customer_lookup", Rows: 120, Likely: true}}, "Kind": "MySQL",
		"Layout": l, "LayoutSteps": l.Explain(),
	}})
	body := rec.Body.String()
	if rec.Code != 200 {
		t.Fatalf("table page: %d %s", rec.Code, body)
	}
	for _, want := range []string{`This looks like a WooCommerce store`, `value="layout"`,
		`counting completed and processing orders`, `does not record marketing consent`} {
		if !strings.Contains(body, want) {
			t.Errorf("table page lacks %q", want)
		}
	}
}

func TestOverviewOffersUpdates(t *testing.T) {
	pages, err := parsePages()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{opts: Options{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, pages: pages}
	render := func(d overviewData) string {
		t.Helper()
		d.Live = &managed.Mapping{Table: "customers"}
		rec := httptest.NewRecorder()
		s.render(rec, "overview.html", view{Title: "Overview", CSRF: "c", Data: d})
		if rec.Code != 200 {
			t.Fatalf("overview: %d %s", rec.Code, rec.Body.String())
		}
		return rec.Body.String()
	}

	body := render(overviewData{UpdateTo: "abc", Updates: &updatesView{Version: "0123456789ab", Offered: "abcdef012345",
		Newer: true, CanInstall: true, Auto: true, Window: "01:00 and 02:00", LastError: "downloading: 404"}})
	for _, want := range []string{`id="updates"`, `Version <code>abcdef012345</code> is`, `name="auto" checked`,
		`value="now">Update now`, `between 01:00 and 02:00`, `could not be installed: downloading: 404`} {
		if !strings.Contains(body, want) {
			t.Errorf("updates section lacks %q", want)
		}
	}
	if strings.Contains(body, "docker compose pull") {
		t.Error("an Agent that updates itself was told to update by hand")
	}

	// An Agent that cannot update itself keeps the commands, and says why.
	body = render(overviewData{UpdateTo: "abc", ManualUpdate: true, Updates: &updatesView{Version: "v1",
		WhyNot: "This build of the Agent cannot update itself: install new versions by hand.", Unsupported: true}})
	for _, want := range []string{"docker compose pull", "cannot update itself", "no longer supports this version"} {
		if !strings.Contains(body, want) {
			t.Errorf("overview lacks %q", want)
		}
	}
	if strings.Contains(body, `value="now"`) {
		t.Error("an Agent that cannot update itself offered to")
	}
}

func TestOrdersCardAsksWhichStatusesCount(t *testing.T) {
	pages, err := parsePages()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{opts: Options{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, pages: pages}
	rec := httptest.NewRecorder()
	s.render(rec, "activity.html", view{Title: "Orders and bookings", CSRF: "c", Data: activityData{
		Cards: []activityCard{{Kind: "orders", Title: "Orders", Table: "wp_wc_order_stats",
			Columns:  []columnOption{{Name: "customer_id"}, {Name: "status"}, {Name: "date_created"}},
			Customer: "customer_id", Date: "date_created", IDColumn: "user_id",
			KeyColumns: []string{"customer_id", "email"}, CustomerKey: "customer_id",
			Status: "status", Statuses: []statusOption{{Value: "wc-completed", Count: 9, Counted: true},
				{Value: "wc-cancelled", Count: 2}, {Value: "wc-delivered", Count: 1, Counted: true, Since: true}},
			Only: []string{describeFilter(managed.RowFilter{Column: "parent_id", Values: []string{"0"}})}}},
	}})
	body := rec.Body.String()
	if rec.Code != 200 {
		t.Fatalf("activity page: %d %s", rec.Code, body)
	}
	for _, want := range []string{
		`<option value="customer_id" selected>customer_id</option>`,
		`customer ID (user_id)`,
		`name="orders_status_shown" value="wc-cancelled"`,
		`name="orders_status_counted" value="wc-completed" checked`,
		`found by the last`,
		`only rows whose parent_id is 0`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("activity page lacks %q", want)
		}
	}
	if strings.Contains(body, `value="wc-cancelled" checked`) {
		t.Error("a cancelled order was ticked as counting")
	}
}
