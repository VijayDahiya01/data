package clean

import (
	"strings"
	"unicode"
)

// Order and booking statuses. A shop's orders table holds cancelled, failed
// and refunded orders beside the real purchases, and only the Partner knows
// every status their system uses -- so the setup page asks, ticking in
// advance the ones whose words say plainly whether they count.

// NormalStatus is a status as compared: lower case, words separated by single
// spaces, without WooCommerce's "wc-" prefix.
func NormalStatus(raw any) string {
	s := strings.ToLower(strings.TrimSpace(Text(raw)))
	s = strings.TrimPrefix(s, "wc-")
	return strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}), " ")
}

var (
	statusCounts = map[string]bool{
		"complete": true, "completed": true, "delivered": true, "paid": true, "success": true,
		"successful": true, "succeeded": true, "fulfilled": true, "fulfiled": true, "shipped": true,
		"dispatched": true, "processing": true, "processed": true, "confirmed": true, "settled": true,
		"captured": true, "ticketed": true, "issued": true, "travelled": true, "traveled": true,
		"booked": true, "transit": true, "checkedout": true,
	}
	statusDoesNot = map[string]bool{
		"cancelled": true, "canceled": true, "cancel": true, "cancellation": true, "failed": true,
		"failure": true, "fail": true, "refunded": true, "refund": true, "returned": true, "return": true,
		"rto": true, "pending": true, "draft": true, "abandoned": true, "declined": true, "void": true,
		"voided": true, "trash": true, "deleted": true, "rejected": true, "expired": true, "hold": true,
		"onhold": true, "awaiting": true, "unpaid": true, "chargeback": true, "disputed": true,
		"lost": true, "noshow": true, "initiated": true, "quote": true,
	}
)

// StatusCounts says whether an order or booking with this status counts --
// a purchase made, a trip booked -- when its words say so; known is false for
// a status they do not settle, which then does not count until the Partner
// says it does. "Partially refunded" still counts: the purchase was made.
func StatusCounts(raw any) (counts, known bool) {
	s := NormalStatus(raw)
	if s == "" {
		return false, false
	}
	words := strings.Fields(s)
	// "on hold", "no show", "checked out" are one word here.
	joined := strings.ReplaceAll(s, " ", "")
	partial := false
	for _, w := range words {
		if strings.HasPrefix(w, "partial") {
			partial = true
		}
	}
	for _, w := range append(words, joined) {
		if statusDoesNot[w] && !partial {
			return false, true
		}
	}
	for _, w := range append(words, joined) {
		if statusCounts[w] {
			return true, true
		}
	}
	if partial {
		return true, true
	}
	return false, false
}
