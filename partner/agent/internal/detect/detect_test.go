package detect

import (
	"fmt"
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
)

var now = time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)

// A customer table the way one really looks: odd names, mixed formats, extra
// columns that are none of our business.
func messyTable() ([]Column, map[string][]any) {
	cols := []Column{
		{Name: "id", PrimaryKey: true}, {Name: "full_name"}, {Name: "email"},
		{Name: "DOB"}, {Name: "sex"}, {Name: "City"}, {Name: "state"}, {Name: "tier"},
		{Name: "lastLogin"}, {Name: "orders_90d"}, {Name: "is_app_user"},
		{Name: "marketing_opt_in"}, {Name: "unsubscribed_at"}, {Name: "created_at"},
		{Name: "status"}, {Name: "flag"},
	}
	s := map[string][]any{}
	dobs := []any{"14/04/1992", "14-04-1993", "1992-04-13T18:30:00Z", int64(703189800), "25/12/1985", "", nil}
	sexes := []any{"M", "F", "1", "2", "Male", "female"}
	cities := []any{"Mumbai", "Bombay", "Bangalore", "Thane", "Pune", "Gurgaon"}
	states := []any{"Maharashtra", "KA", "Telangana", "MH", "Haryana"}
	tiers := []any{"Gold", "Silver", "Elite", "GOLD", "Platinum"}
	for i := 0; i < 30; i++ {
		s["id"] = append(s["id"], fmt.Sprintf("C%05d", i))
		s["full_name"] = append(s["full_name"], "Asha Rao")
		s["email"] = append(s["email"], fmt.Sprintf("a%d@example.com", i))
		s["DOB"] = append(s["DOB"], dobs[i%len(dobs)])
		s["sex"] = append(s["sex"], sexes[i%len(sexes)])
		s["City"] = append(s["City"], cities[i%len(cities)])
		s["state"] = append(s["state"], states[i%len(states)])
		s["tier"] = append(s["tier"], tiers[i%len(tiers)])
		s["lastLogin"] = append(s["lastLogin"], "2026-09-01 10:00:00")
		s["orders_90d"] = append(s["orders_90d"], int64(i%7))
		s["is_app_user"] = append(s["is_app_user"], []any{"Y", "N"}[i%2])
		s["marketing_opt_in"] = append(s["marketing_opt_in"], i%3 != 0)
		s["unsubscribed_at"] = append(s["unsubscribed_at"], nil)
		s["created_at"] = append(s["created_at"], "2024-01-01 00:00:00")
		s["status"] = append(s["status"], "active")
		s["flag"] = append(s["flag"], int64(i%2))
	}
	return cols, s
}

func byAttr(ss []Suggestion) map[string]Suggestion {
	m := map[string]Suggestion{}
	for _, s := range ss {
		m[s.Attribute] = s
	}
	return m
}

func TestSuggestFindsTheRightColumns(t *testing.T) {
	cols, samples := messyTable()
	got := byAttr(Suggest(cols, samples, now))

	want := map[string]string{
		"age": "DOB", "gender": "sex", "city": "City", "state_region": "state",
		"loyalty_tier": "tier", "active_user_days": "lastLogin",
		"purchase_frequency": "orders_90d", "app_active": "is_app_user",
	}
	for attr, col := range want {
		if got[attr].Column != col {
			t.Errorf("%s: suggested %q, want %q (%s)", attr, got[attr].Column, col, got[attr].Reason)
		}
	}
	// Nothing is invented for what the table does not hold, and columns that
	// are none of our business are left alone.
	for _, attr := range []string{"payment_method", "recent_booking", "purchase_category"} {
		if got[attr].Column != "" {
			t.Errorf("%s: suggested %q for an attribute the table does not hold", attr, got[attr].Column)
		}
	}
	for _, s := range got {
		switch s.Column {
		case "full_name", "email", "status", "flag", "created_at":
			t.Errorf("%s: matched to %q", s.Attribute, s.Column)
		}
	}
}

func TestSuggestReportsWhatNeedsAPerson(t *testing.T) {
	cols, samples := messyTable()
	got := byAttr(Suggest(cols, samples, now))

	city := got["city"]
	if !city.NeedsReview || len(city.Unrecognised) == 0 || city.Unrecognised[0].Value != "Thane" {
		t.Errorf("city: unrecognised values should be listed for the Partner, got %+v", city)
	}
	tier := got["loyalty_tier"]
	if len(tier.Unrecognised) == 0 || tier.Unrecognised[0].Value != "Elite" {
		t.Errorf("tier: 'Elite' should be listed, got %+v", tier.Unrecognised)
	}
	age := got["age"]
	if age.Order != clean.DayFirst || age.Readable != 1 {
		t.Errorf("age: every date of birth should read, day first; got %+v", age)
	}
}

func TestSuggestIDAndConsent(t *testing.T) {
	cols, samples := messyTable()
	if id, _ := SuggestID(cols, samples); id != "id" {
		t.Errorf("id column: got %q", id)
	}
	consent, withdrawal := SuggestConsent(cols)
	if consent != "marketing_opt_in" || withdrawal != "unsubscribed_at" {
		t.Errorf("consent: got %q / %q", consent, withdrawal)
	}
}

func TestSuggestIDToleratesSomeDuplicatesButNotAForeignKey(t *testing.T) {
	cols := []Column{{Name: "city_id"}, {Name: "customer_id"}}
	s := map[string][]any{}
	for i := 0; i < 20; i++ {
		s["city_id"] = append(s["city_id"], int64(i%4))
		s["customer_id"] = append(s["customer_id"], fmt.Sprintf("C%d", i%18)) // two customers twice
	}
	if id, _ := SuggestID(cols, s); id != "customer_id" {
		t.Errorf("got %q", id)
	}
	// Named like an id but repeating: a foreign key, not the customer.
	if id, _ := SuggestID(cols[:1], s); id != "" {
		t.Errorf("city_id suggested as the customer id")
	}
}

func TestValuesAloneCanIdentifyACity(t *testing.T) {
	cols := []Column{{Name: "location"}}
	var v []any
	for i := 0; i < 25; i++ {
		v = append(v, []any{"Mumbai", "Pune", "Chennai"}[i%3])
	}
	got := byAttr(Suggest(cols, map[string][]any{"location": v}, now))
	if got["city"].Column != "location" || !got["city"].NeedsReview {
		t.Errorf("a column of city names should be suggested for review, got %+v", got["city"])
	}
	// ...but a column of 0/1 is not gender just because 1 and 2 are codes.
	cols = []Column{{Name: "flag"}}
	v = nil
	for i := 0; i < 25; i++ {
		v = append(v, int64(i%2))
	}
	if got := byAttr(Suggest(cols, map[string][]any{"flag": v}, now)); got["gender"].Column != "" {
		t.Errorf("0/1 flag suggested as gender")
	}
}

func TestWords(t *testing.T) {
	for in, want := range map[string]string{
		"dateOfBirth": "date_of_birth", "Date Of Birth": "date_of_birth", "DOB": "dob",
		"profile.dob": "dob", "customer.address.city": "city", "last-login": "last_login",
	} {
		if got := Words(in); got != want {
			t.Errorf("Words(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSuggestActivityForAnOrdersTable(t *testing.T) {
	cols := []Column{{Name: "id", PrimaryKey: true}, {Name: "customer_id"}, {Name: "order_date"},
		{Name: "category"}, {Name: "pay_mode"}, {Name: "channel"}, {Name: "amount"}}
	s := map[string][]any{}
	for i := 0; i < 30; i++ {
		s["id"] = append(s["id"], fmt.Sprintf("O%d", i))
		s["customer_id"] = append(s["customer_id"], fmt.Sprintf("C%d", i%9))
		s["order_date"] = append(s["order_date"], fmt.Sprintf("%02d/08/2026", i%28+1))
		s["category"] = append(s["category"], []any{"Shoes", "Groceries", "Stationery"}[i%3])
		s["pay_mode"] = append(s["pay_mode"], []any{"GPay", "COD", "Credit Card"}[i%3])
		s["channel"] = append(s["channel"], []any{"App", "Store"}[i%2])
		s["amount"] = append(s["amount"], int64(100+i))
	}
	got := SuggestActivity("orders", cols, s, "customer_id", now)
	want := ActivitySuggestion{CustomerColumn: "customer_id", DateColumn: "order_date", Order: clean.DayFirst,
		CategoryColumn: "category", PaymentColumn: "pay_mode", ChannelColumn: "channel"}
	if got != want {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
	if ActivityKind("sales_orders") != "orders" || ActivityKind("flight_bookings") != "bookings" ||
		ActivityKind("customers") != "" {
		t.Error("table names misread")
	}
}
