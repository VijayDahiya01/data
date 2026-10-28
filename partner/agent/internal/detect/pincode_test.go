package detect

import (
	"fmt"
	"testing"
)

// A pincode column gives the city and the state: it is suggested for both
// when nothing better does either.
func TestAPincodeColumnGivesCityAndState(t *testing.T) {
	cols := []Column{{Name: "customer_id"}, {Name: "pin_code"}, {Name: "dob"}}
	pins := []any{"400001", "560100", "110085", "226001", "400 072", "682001"}
	samples := map[string][]any{}
	for i := 0; i < 30; i++ {
		samples["customer_id"] = append(samples["customer_id"], fmt.Sprint(i))
		samples["pin_code"] = append(samples["pin_code"], pins[i%len(pins)])
		samples["dob"] = append(samples["dob"], "14/04/1992")
	}
	got := byAttr(Suggest(cols, samples, now))
	for _, attr := range []string{"city", "state_region"} {
		s := got[attr]
		if s.Column != "pin_code" || s.Readable != 1 {
			t.Errorf("%s: got %+v", attr, s)
		}
	}
	// Lucknow and Kochi have no listed city; Kochi's Kerala no listed state.
	if got["city"].Outside != 10 || got["state_region"].Outside != 5 {
		t.Errorf("outside the list: city %d, state %d", got["city"].Outside, got["state_region"].Outside)
	}

	// A real city column is preferred for the city; the pincodes still give
	// the state.
	cols = append(cols, Column{Name: "city"})
	for i := 0; i < 30; i++ {
		samples["city"] = append(samples["city"], "Mumbai")
	}
	got = byAttr(Suggest(cols, samples, now))
	if got["city"].Column != "city" || got["state_region"].Column != "pin_code" {
		t.Errorf("city from %q, state from %q", got["city"].Column, got["state_region"].Column)
	}

	// Six-digit numbers that are not pincodes are not taken for them.
	samples = map[string][]any{}
	for i := 0; i < 30; i++ {
		samples["order_no"] = append(samples["order_no"], fmt.Sprint(900000+i))
	}
	if pin := pincodeColumn([]Column{{Name: "order_no"}}, samples); pin != "" {
		t.Errorf("order numbers taken for pincodes")
	}
}
