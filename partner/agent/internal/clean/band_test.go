package clean

import "testing"

func TestParseBandReadsTheWaysPartnersWriteAgeGroups(t *testing.T) {
	for in, want := range map[string]string{
		"25-45":              "25-45",
		"25 - 45":            "25-45",
		"25–45 yrs":          "25-45",
		"25 to 45":           "25-45",
		"Between 25 and 45":  "25-45",
		"18-24 years old":    "18-24",
		"Age 25-34":          "25-34",
		"(35-44)":            "35-44",
		"60+":                "60+",
		"60 +":               "60+",
		"60 and above":       "60+",
		"60 years & above":   "60+",
		"65 plus":            "65+",
		">=60":               "60+",
		"≥60":                "60+",
		">60":                "61+",
		"<25":                "0-24",
		"<=25":               "0-25",
		"25":                 "25",
		"25 years":           "25",
		"Aged 30 and older ": "30+",
		// Words are read wide: the group that cannot over-claim.
		"above 60": "60+",
		"over 60":  "60+",
		"under 25": "0-25",
		"below 25": "0-25",
		"upto 25":  "0-25",
	} {
		b, ok := ParseBand(in)
		if !ok || b.String() != want {
			t.Errorf("ParseBand(%q) = %v %v, want %s", in, b, ok, want)
		}
	}
}

func TestParseBandLeavesWordsAndNonsenseForThePartner(t *testing.T) {
	for _, in := range []string{"senior", "young", "", "45-25", "25-130", "1992", "abc 25", "25-45-60", "-5"} {
		if b, ok := ParseBand(in); ok {
			t.Errorf("ParseBand(%q) = %v, want unknown", in, b)
		}
	}
}

func TestParseWhole(t *testing.T) {
	for in, want := range map[any]int{"25": 25, " 25 yrs": 25, "12 days": 12, 25.0: 25, int64(7): 7, "30.0": 30} {
		if n, ok := ParseWhole(in); !ok || n != want {
			t.Errorf("ParseWhole(%v) = %d %v, want %d", in, n, ok, want)
		}
	}
	for _, in := range []any{"25.5", 25.5, "-3", "", "twenty", "25-30"} {
		if n, ok := ParseWhole(in); ok {
			t.Errorf("ParseWhole(%v) = %d, want unknown", in, n)
		}
	}
}
