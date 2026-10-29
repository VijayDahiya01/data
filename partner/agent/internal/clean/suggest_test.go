package clean

import (
	"testing"

	"github.com/oolix/partner-agent/internal/standard"
)

func mapperFor(t *testing.T, key string) *EnumMapper {
	t.Helper()
	a, ok := standard.ByKey(key)
	if !ok {
		t.Fatalf("no attribute %s", key)
	}
	m, err := NewEnumMapper(a, nil)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestPincodesGiveTheCityAndTheState(t *testing.T) {
	city, state := mapperFor(t, "city"), mapperFor(t, "state_region")
	for _, c := range []struct {
		raw         any
		city, state string
	}{
		{"400001", "MUMBAI", "MH"},
		{"400 001", "MUMBAI", "MH"},
		{int64(560100), "BENGALURU", "KA"}, // Electronics City
		{"500032", "HYDERABAD", "TG"},      // Gachibowli, in Rangareddy district
		{"122001", "GURUGRAM", "HR"},
		{"201301", "NOIDA", "UP"},
		{"110085", "DELHI", "DL"},
		{"400601", "", "MH"}, // Thane: same sorting district, another city
		{"562106", "", "KA"}, // Anekal, outside Bengaluru's postal district
		{"122051", "", "HR"}, // Manesar
		{"226001", "", "UP"}, // Lucknow
		{"682001", "", ""},   // Kochi: Kerala is not on the list either
	} {
		got, _ := city.Map(c.raw)
		if got != c.city {
			t.Errorf("city of %v = %q, want %q", c.raw, got, c.city)
		}
		got, _ = state.Map(c.raw)
		if got != c.state {
			t.Errorf("state of %v = %q, want %q", c.raw, got, c.state)
		}
		// A known pincode with no listed place is left empty, not asked about.
		if c.city == "" && !city.Ignored(c.raw) {
			t.Errorf("city: %v should be left empty", c.raw)
		}
	}
	// Not pincodes India Post knows: asked about, like any unknown value.
	for _, raw := range []string{"999999", "012345", "40001", "4000011"} {
		if city.Ignored(raw) {
			t.Errorf("%s was taken for a pincode", raw)
		}
		if _, ok := city.Map(raw); ok {
			t.Errorf("%s mapped", raw)
		}
	}
	if _, _, ok := Pincode("400001"); !ok {
		t.Error("Pincode(400001) not found")
	}
}

func TestPlacesOutsideTheListAreLeftEmpty(t *testing.T) {
	city, state := mapperFor(t, "city"), mapperFor(t, "state_region")
	for _, raw := range []string{"Lucknow", "Thane", "Mangalore", "Bangalore Rural"} {
		if !city.Outside(raw) || !city.Ignored(raw) {
			t.Errorf("city %q should be outside the list", raw)
		}
	}
	// Names, and codes as WooCommerce keeps them -- its older OR and CT too.
	for _, raw := range []string{"Kerala", "Orissa", "Jammu & Kashmir", "KL", "ap", "OR", "CT", "DN"} {
		if !state.Outside(raw) {
			t.Errorf("state %q should be outside the list", raw)
		}
	}
	for raw, want := range map[string]string{"MH": "MH", "ka": "KA", "TS": "TG"} {
		if code, ok := state.Map(raw); !ok || code != want {
			t.Errorf("state %q read as %q, want %s", raw, code, want)
		}
	}
	// Not places at all, a listed city's part, and an answer the Partner gave:
	// none is outside.
	for _, raw := range []string{"Mumbay", "Bangalore North", "Secunderabad", "Elite"} {
		if city.Outside(raw) {
			t.Errorf("city %q should not be outside the list", raw)
		}
	}
	a, _ := standard.ByKey("city")
	answered, _ := NewEnumMapper(a, map[string]string{"Thane": "MUMBAI"})
	if code, ok := answered.Map("Thane"); !ok || code != "MUMBAI" || answered.Outside("Thane") {
		t.Errorf("the Partner's answer for Thane = %q %v", code, ok)
	}
}

func TestSuggestions(t *testing.T) {
	for _, c := range []struct {
		attr, raw, code, why string
	}{
		// Misspelled by a letter or two.
		{"city", "Gurgoan", "GURUGRAM", "a close spelling"},
		{"city", "Bengalooru", "BENGALURU", "a close spelling"},
		// India Post itself writes Banglore for a part of the city.
		{"city", "Banglore", "BENGALURU", "lies in Bengaluru"},
		{"city", "Puna", "PUNE", "a close spelling"}, // Poona, as said
		{"city", "Hydrabad", "HYDERABAD", "a close spelling"},
		{"city", "Chenai", "CHENNAI", "a close spelling"},
		{"state_region", "Maharastra", "MH", "a close spelling"},
		{"purchase_category", "Footware", "FOOTWEAR", "a close spelling"},
		{"payment_method", "Phonepay", "UPI", "a close spelling"},
		// Written in an Indian script, but not as the built-in synonyms are.
		{"city", "बंगलौर", "BENGALURU", "written in Devanagari"},
		{"city", "गुड़गांव", "GURUGRAM", "written in Devanagari"},
		{"city", "ಮುಂಬಯಿ", "MUMBAI", "written in Kannada"},
		{"city", "கொல்கத்தா", "KOLKATA", "written in Tamil"},
		// Parts of a listed city.
		{"city", "South Delhi", "DELHI", "a part of Delhi"},
		{"city", "Bangalore North", "BENGALURU", "a part of Bengaluru"},
		{"city", "Mumbai Suburban", "MUMBAI", "a part of Mumbai"},
		{"city", "Secunderabad", "HYDERABAD", "lies in Hyderabad"},
	} {
		sg, ok := mapperFor(t, c.attr).Suggest(c.raw)
		if !ok || sg.Code != c.code || sg.Why != c.why {
			t.Errorf("%s %q: got %+v %v, want %s (%s)", c.attr, c.raw, sg, ok, c.code, c.why)
		}
	}
}

func TestNoSuggestionWhenItCouldBeSomethingElse(t *testing.T) {
	for _, c := range []struct{ attr, raw string }{
		{"city", "Mangalore"},      // another city, one letter from Bangalore
		{"city", "Mangaluru"},      // the same, two letters from Bengaluru
		{"city", "Mangalor"},       // nearer Mangalore than Bangalore
		{"city", "Navi Mumbai"},    // a city of its own
		{"city", "Greater Noida"},  // likewise
		{"city", "Pine"},           // a letter from Pune, but too short to guess at
		{"state_region", "Kerela"}, // near Kerala, which is not listed: not Karnataka
		{"city", "Mumbai"},         // already a code: nothing to suggest
		{"purchase_category", "Toys"},
	} {
		if sg, ok := mapperFor(t, c.attr).Suggest(c.raw); ok {
			t.Errorf("%s %q: suggested %+v", c.attr, c.raw, sg)
		}
	}
}

func TestRomanize(t *testing.T) {
	for _, c := range []struct{ in, out, script string }{
		{"गुरुग्राम", "gurugraam", "Devanagari"},
		{"मुंबई", "mumbaii", "Devanagari"},
		{"दिल्ली", "dillii", "Devanagari"},
		// North Indian scripts drop the inherent vowel between a vowel and
		// a consonant that has its own; southern ones keep it.
		{"हैदराबाद", "haidraabaad", "Devanagari"},
		{"गुड़गांव", "gurgaon", "Devanagari"},
		{"गोरेगाव", "goregaon", "Devanagari"},
		{"कोलकाता", "kolkaataa", "Devanagari"},
		{"अहमदाबाद", "ahmadaabaad", "Devanagari"},
		{"சென்னை", "chennai", "Tamil"},
		{"ಬೆಂಗಳೂರು", "bengaluuru", "Kannada"},
		{"హైదరాబాద్", "haidaraabaad", "Telugu"},
		{"কলকাতা", "kalkaataa", "Bengali"},
		{"અમદાવાદ", "amdaavaad", "Gujarati"},
		{"ज़ीरो", "ziiro", "Devanagari"}, // a nukta: ज़ is z
		{"Pune 411001", "Pune 411001", ""},
	} {
		got, script := Romanize(c.in)
		if got != c.out || script != c.script {
			t.Errorf("Romanize(%s) = %q %q, want %q %q", c.in, got, script, c.out, c.script)
		}
	}
}

func TestFoldAndDistance(t *testing.T) {
	for _, c := range []struct{ a, b string }{
		{"chennai", "chenai"}, {"calcutta", "calcuta"}, {"gurugraam", "gurugram"}, {"new delhi", "newdelhi"},
	} {
		if fold(c.a) != fold(c.b) {
			t.Errorf("fold(%q) = %q, fold(%q) = %q", c.a, fold(c.a), c.b, fold(c.b))
		}
	}
	if d := distance([]rune("gurgoan"), []rune("gurgaon")); d != 1 {
		t.Errorf("a swap costs %d", d)
	}
	if d := distance([]rune(""), []rune("abc")); d != 3 {
		t.Errorf("from nothing: %d", d)
	}
}

func TestSharedSynonymsRankBelowTheBuiltIns(t *testing.T) {
	t.Cleanup(func() { SetShared(nil) })
	SetShared(map[string]map[string]string{
		"purchase_category": {"Kurtis": "FASHION", "Shoes": "BEAUTY"},
		"loyalty_tier":      {"Elite": "NOT_A_CODE"},
	})
	if code, ok := mapperFor(t, "purchase_category").Map("kurtis"); !ok || code != "FASHION" {
		t.Errorf("kurtis = %q %v", code, ok)
	}
	if code, _ := mapperFor(t, "purchase_category").Map("Shoes"); code != "FOOTWEAR" {
		t.Errorf("a shared synonym overrode a built-in one: %q", code)
	}
	if _, ok := mapperFor(t, "loyalty_tier").Map("Elite"); ok {
		t.Error("a shared synonym to a code the attribute lacks was used")
	}
}
