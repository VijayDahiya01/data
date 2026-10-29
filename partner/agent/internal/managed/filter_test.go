package managed

import (
	"fmt"
	"testing"

	"github.com/oolix/partner-agent/internal/source"
)

// Which orders count: the Partner's answers first, then the words, and a
// platform's conditions on top. No database needed.
func TestOrdersThatCount(t *testing.T) {
	c := &activityCleaner{am: ActivityMapping{
		Status: &StatusFilter{Column: "status", Counted: []string{"wc-completed", "Shipped Partly"},
			NotCounted: []string{"wc-processing"}},
		Only: []RowFilter{{Column: "type", Values: []string{"shop_order"}}},
	}}
	var ar ActivityReport
	for _, tc := range []struct {
		row  source.Row
		want bool
	}{
		{source.Row{"status": "wc-completed", "type": "shop_order"}, true},
		// The Partner said processing orders do not count: their answer wins
		// over the words.
		{source.Row{"status": "wc-processing", "type": "shop_order"}, false},
		{source.Row{"status": "shipped partly", "type": "SHOP_ORDER"}, true},
		// A refund beside the orders.
		{source.Row{"status": "wc-completed", "type": "shop_order_refund"}, false},
		// Not asked about: the words decide, and the status is reported.
		{source.Row{"status": "Delivered", "type": "shop_order"}, true},
		{source.Row{"status": "wc-cancelled", "type": "shop_order"}, false},
		{source.Row{"status": "awaiting-pickup", "type": "shop_order"}, false},
		{source.Row{"status": nil, "type": "shop_order"}, false},
	} {
		if got := c.counts(tc.row, &ar); got != tc.want {
			t.Errorf("%v counts %v, want %v", tc.row, got, tc.want)
		}
	}
	if len(ar.Undecided) != 3 || ar.Undecided["Delivered"] != 1 || ar.Undecided["awaiting-pickup"] != 1 {
		t.Errorf("undecided statuses %v", ar.Undecided)
	}

	// A column of free text chosen as the status lists only so many.
	free := &activityCleaner{am: ActivityMapping{Status: &StatusFilter{Column: "note"}}}
	var many ActivityReport
	for i := 0; i < 100; i++ {
		free.counts(source.Row{"note": fmt.Sprintf("call me %d", i)}, &many)
	}
	free.counts(source.Row{"note": "call me 0"}, &many)
	if len(many.Undecided) != maxUndecided || many.Undecided["call me 0"] != 2 {
		t.Errorf("%d undecided, call me 0 x%d", len(many.Undecided), many.Undecided["call me 0"])
	}

	// No status column: every row counts.
	if !(&activityCleaner{}).counts(source.Row{"status": "wc-cancelled"}, &ar) {
		t.Error("a table without a status column dropped a row")
	}
	for id, want := range map[string]bool{"": true, "0": true, "C1": false, "10": false} {
		if noCustomer(id) != want {
			t.Errorf("noCustomer(%q) = %v", id, !want)
		}
	}
	// The columns read include the ones the conditions need.
	cols := c.columns()
	for _, want := range []string{"status", "type"} {
		if !contains(cols, want) {
			t.Errorf("%s not read: %v", want, cols)
		}
	}
}
