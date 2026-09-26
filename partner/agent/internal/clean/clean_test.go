package clean

import (
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/standard"
)

func day(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

// The formats a single real date-of-birth column is found to hold.
func TestParseDateReadsEveryCommonForm(t *testing.T) {
	want := day(1992, time.April, 14)
	for _, raw := range []any{
		"14/04/1992", "14-04-1992", "14.04.1992", "14/4/1992", " 14/04/1992 ",
		"1992-04-14", "1992/04/14", "19920414", "14041992",
		"1992-04-14T00:00:00+05:30", "1992-04-13T18:30:00Z", "1992-04-13 18:30:00+00",
		"14 Apr 1992", "14-Apr-1992", "14th April 1992", "April 14, 1992", "Apr 14 1992",
		"14/04/92", "14/04/1992 10:30", "4/14/1992 6:30 PM",
		int64(703189800),    // Unix seconds
		int64(703189800000), // Unix milliseconds
		float64(703189800),  // the same, as a float from a JSON source
		int64(19920414),     // YYYYMMDD stored as a number
		time.Date(1992, 4, 14, 0, 0, 0, 0, India),
		time.Date(1992, 4, 13, 18, 30, 0, 0, time.UTC), // midnight India, stored in UTC
		[]byte("14/04/1992"),
	} {
		got, ok := ParseDate(raw, DateOptions{Order: DayFirst})
		if !ok || !got.Equal(want) {
			t.Errorf("ParseDate(%v) = %v, %v; want %v", raw, got, ok, want)
		}
	}
}

func TestParseDateReadsBirthdaysBefore1970(t *testing.T) {
	got, ok := ParseDate(int64(-157766400), DateOptions{}) // 1965-01-01T00:00:00Z
	if !ok || got.Year() != 1965 {
		t.Fatalf("negative Unix time: got %v, %v", got, ok)
	}
}

func TestParseDateRefusesWhatIsNotADate(t *testing.T) {
	for _, raw := range []any{
		nil, "", "   ", "hello", "31/02/1992", "30/02/2000", "1992-13-01", "00/00/0000",
		"9999-12-31", "1800-01-01", "14/04", "12:30", int64(42), float64(3.5), true,
		"1992-04-14T25:00:00Z",
	} {
		if got, ok := ParseDate(raw, DateOptions{Order: DayFirst}); ok {
			t.Errorf("ParseDate(%v) = %v; want unreadable", raw, got)
		}
	}
}

func TestAmbiguousDatesFollowTheColumnOrder(t *testing.T) {
	if got, _ := ParseDate("04/05/1992", DateOptions{Order: DayFirst}); !got.Equal(day(1992, time.May, 4)) {
		t.Errorf("day first: got %v", got)
	}
	if got, _ := ParseDate("04/05/1992", DateOptions{Order: MonthFirst}); !got.Equal(day(1992, time.April, 5)) {
		t.Errorf("month first: got %v", got)
	}
	// With no decision, a date that reads two ways is not guessed.
	if got, ok := ParseDate("04/05/1992", DateOptions{}); ok {
		t.Errorf("unknown order: got %v, want unreadable", got)
	}
	// ...but one that reads only one way still is, and so is 05/05.
	if _, ok := ParseDate("14/05/1992", DateOptions{}); !ok {
		t.Error("an unmistakable date was refused")
	}
	if _, ok := ParseDate("05/05/1992", DateOptions{}); !ok {
		t.Error("a date that reads the same both ways was refused")
	}
	// A value that can only be day-first is read that way even in a
	// month-first column: there is no other reading.
	if got, _ := ParseDate("14/04/1992", DateOptions{Order: MonthFirst}); !got.Equal(day(1992, time.April, 14)) {
		t.Errorf("unmistakable value in a month-first column: got %v", got)
	}
}

func TestTimeZoneTurnsAMomentIntoTheRightCalendarDay(t *testing.T) {
	// Stored as UTC, this is 00:00 on 14 April in India. Read in UTC it would
	// be a day early.
	got, _ := ParseDate("1992-04-13T18:30:00Z", DateOptions{})
	if !got.Equal(day(1992, time.April, 14)) {
		t.Fatalf("got %v; want 1992-04-14", got)
	}
	utc, _ := ParseDate("1992-04-13T18:30:00Z", DateOptions{Location: time.UTC})
	if !utc.Equal(day(1992, time.April, 13)) {
		t.Fatalf("in UTC got %v; want 1992-04-13", utc)
	}
}

func TestParseTimestampKeepsTheMoment(t *testing.T) {
	got, ok := ParseTimestamp("2024-05-01 10:30:00", DateOptions{})
	want := time.Date(2024, 5, 1, 5, 0, 0, 0, time.UTC) // 10:30 in India
	if !ok || !got.Equal(want) {
		t.Fatalf("got %v, %v; want %v", got, ok, want)
	}
}

func TestDetectOrderFromTheData(t *testing.T) {
	cases := []struct {
		name      string
		samples   []any
		order     Order
		confident bool
	}{
		{"day first", []any{"14/04/1992", "03/05/1990", "25-12-1985"}, DayFirst, true},
		{"month first", []any{"04/14/1992", "03/05/1990", "12/25/1985"}, MonthFirst, true},
		{"year first only", []any{"1992-04-14", int64(703189800), nil}, DayFirst, true},
		{"every value reads both ways", []any{"03/05/1990", "01/02/1985"}, DayFirst, false},
		{"mixed systems", []any{"14/04/1992", "04/14/1992"}, OrderUnknown, false},
	}
	for _, c := range cases {
		d := DetectOrder(c.samples).Decide()
		if d.Order != c.order || d.Confident != c.confident {
			t.Errorf("%s: got %+v", c.name, d)
		}
	}

	// A handful of month-first values among many day-first ones are typos.
	var samples []any
	for i := 0; i < 40; i++ {
		samples = append(samples, "25/04/1990")
	}
	samples = append(samples, "04/25/1990")
	if d := DetectOrder(samples).Decide(); d.Order != DayFirst || d.Confident {
		t.Errorf("mostly day first: got %+v", d)
	}
}

func mapper(t *testing.T, key string, overrides map[string]string) *EnumMapper {
	t.Helper()
	a, _ := standard.ByKey(key)
	m, err := NewEnumMapper(a, overrides)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestEnumMapsCommonSpellingsToCodes(t *testing.T) {
	cases := map[string]map[any]string{
		"gender": {"M": "MALE", "male": "MALE", " Female ": "FEMALE", "F": "FEMALE",
			int64(1): "MALE", "2": "FEMALE", "Prefer not to say": "UNDISCLOSED", "MALE": "MALE"},
		"city": {"Bombay": "MUMBAI", "mumbai": "MUMBAI", "Bangalore": "BENGALURU",
			"Gurgaon": "GURUGRAM", "Calcutta": "KOLKATA", "new-delhi": "DELHI"},
		"payment_method": {"UPI": "UPI", "gpay": "UPI", "Credit Card": "CREDIT_CARD",
			"credit_card": "CREDIT_CARD", "Cash on Delivery": "COD", "netbanking": "NET_BANKING"},
		"state_region":      {"Maharashtra": "MH", "mh": "MH", "Telangana": "TG", "TS": "TG"},
		"country":           {"India": "IN", "IND": "IN", "in": "IN"},
		"purchase_category": {"Home & Kitchen": "HOME", "Shoes": "FOOTWEAR", "apparel": "FASHION"},
	}
	for key, values := range cases {
		m := mapper(t, key, nil)
		for raw, want := range values {
			if got, ok := m.Map(raw); !ok || got != want {
				t.Errorf("%s: Map(%v) = %q, %v; want %q", key, raw, got, ok, want)
			}
		}
	}
}

func TestEnumLeavesUnknownValuesToThePartner(t *testing.T) {
	m := mapper(t, "loyalty_tier", nil)
	if _, ok := m.Map("Elite"); ok {
		t.Fatal("an unknown tier was guessed")
	}
	// The Partner says what it means on the setup page; "" means ignore it.
	m = mapper(t, "loyalty_tier", map[string]string{"Elite": "PLATINUM", "Staff": ""})
	if got, ok := m.Map("elite"); !ok || got != "PLATINUM" {
		t.Errorf("override: got %q, %v", got, ok)
	}
	if _, ok := m.Map("Staff"); ok {
		t.Error("an ignored value was mapped")
	}
	if _, err := NewEnumMapper(standard.Attributes[1], map[string]string{"x": "NOT_A_CODE"}); err == nil {
		t.Error("an override to a code that does not exist was accepted")
	}
}

func TestParseBoolAndNumber(t *testing.T) {
	for raw, want := range map[any]bool{true: true, "Y": true, "yes": true, "1": true, int64(1): true,
		false: false, "N": false, "no": false, int64(0): false, "FALSE": false} {
		if got, ok := ParseBool(raw); !ok || got != want {
			t.Errorf("ParseBool(%v) = %v, %v", raw, got, ok)
		}
	}
	for _, raw := range []any{"maybe", "", nil, int64(7)} {
		if _, ok := ParseBool(raw); ok {
			t.Errorf("ParseBool(%v) should be unknown", raw)
		}
	}
	for raw, want := range map[any]float64{"12": 12, "1,204": 1204, int64(3): 3, 4.0: 4, " 7 ": 7} {
		if got, ok := ParseNumber(raw); !ok || got != want {
			t.Errorf("ParseNumber(%v) = %v, %v", raw, got, ok)
		}
	}
	if _, ok := ParseNumber("twelve"); ok {
		t.Error("ParseNumber accepted words")
	}
}
