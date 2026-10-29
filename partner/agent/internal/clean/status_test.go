package clean

import "testing"

func TestStatusCounts(t *testing.T) {
	for raw, want := range map[string]struct{ counts, known bool }{
		"wc-completed": {true, true}, "wc-processing": {true, true}, "Delivered": {true, true},
		"PAID": {true, true}, "fulfilled": {true, true}, "In Transit": {true, true},
		"checked-out": {true, true}, "Ticketed": {true, true},
		"wc-cancelled": {false, true}, "Canceled": {false, true}, "wc-refunded": {false, true},
		"wc-failed": {false, true}, "wc-pending": {false, true}, "wc-on-hold": {false, true},
		"RTO": {false, true}, "payment_pending": {false, true}, "no-show": {false, true},
		"wc-checkout-draft": {false, true},
		// The purchase was made, then partly returned.
		"partially_refunded": {true, true}, "partially paid": {true, true},
		// Words that settle nothing: the Partner decides.
		"open": {false, false}, "new": {false, false}, "3": {false, false}, "": {false, false},
	} {
		counts, known := StatusCounts(raw)
		if counts != want.counts || known != want.known {
			t.Errorf("%q: counts %v known %v, want %v %v", raw, counts, known, want.counts, want.known)
		}
	}
	if got := NormalStatus(" wc-On-Hold "); got != "on hold" {
		t.Errorf("normal status %q", got)
	}
}
