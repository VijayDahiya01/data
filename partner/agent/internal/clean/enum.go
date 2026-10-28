package clean

import (
	"fmt"
	"strings"

	"github.com/oolix/partner-agent/internal/standard"
)

// synonyms maps a normalised raw value to a standard code, per attribute.
//
// Conservative on purpose: only spellings that cannot mean anything else. A
// value missing here is not dropped silently -- the setup page lists it with
// its count so the Partner can say what it means ("Elite" -> PLATINUM), and
// that answer is stored as an override.
var synonyms = map[string]map[string]string{
	"gender": {
		"m": "MALE", "male": "MALE", "man": "MALE", "boy": "MALE", "mr": "MALE",
		"f": "FEMALE", "female": "FEMALE", "woman": "FEMALE", "girl": "FEMALE",
		"mrs": "FEMALE", "ms": "FEMALE", "miss": "FEMALE",
		"o": "OTHER", "other": "OTHER", "others": "OTHER", "non binary": "OTHER",
		"nonbinary": "OTHER", "nb": "OTHER", "third gender": "OTHER", "transgender": "OTHER",
		"u": "UNDISCLOSED", "unknown": "UNDISCLOSED", "undisclosed": "UNDISCLOSED",
		"prefer not to say": "UNDISCLOSED", "not specified": "UNDISCLOSED",
		"not disclosed": "UNDISCLOSED", "na": "UNDISCLOSED", "n a": "UNDISCLOSED",
		// ISO/IEC 5218, the usual numeric coding.
		"0": "UNDISCLOSED", "1": "MALE", "2": "FEMALE", "9": "UNDISCLOSED",
	},
	"country": {
		"in": "IN", "ind": "IN", "india": "IN", "bharat": "IN", "republic of india": "IN",
	},
	// States and cities are also written in Hindi and in their own
	// languages, which cannot mean anything else either; other spellings in
	// those scripts are suggested (see Suggest).
	"state_region": {
		"dl": "DL", "delhi": "DL", "new delhi": "DL", "nct of delhi": "DL", "nct delhi": "DL",
		"hr": "HR", "haryana": "HR",
		"up": "UP", "uttar pradesh": "UP", "u p": "UP",
		"ka": "KA", "karnataka": "KA",
		"mh": "MH", "maharashtra": "MH",
		"tn": "TN", "tamil nadu": "TN", "tamilnadu": "TN",
		"tg": "TG", "ts": "TG", "telangana": "TG",
		"gj": "GJ", "gujarat": "GJ",
		"wb": "WB", "west bengal": "WB",
		"rj": "RJ", "rajasthan": "RJ",
		"दिल्ली": "DL", "हरियाणा": "HR", "उत्तर प्रदेश": "UP", "कर्नाटक": "KA", "ಕರ್ನಾಟಕ": "KA",
		"महाराष्ट्र": "MH", "तमिलनाडु": "TN", "तमिल नाडु": "TN", "தமிழ்நாடு": "TN", "तेलंगाना": "TG",
		"తెలంగాణ": "TG", "गुजरात": "GJ", "ગુજરાત": "GJ", "पश्चिम बंगाल": "WB", "পশ্চিমবঙ্গ": "WB",
		"राजस्थान": "RJ",
	},
	"city": {
		"delhi": "DELHI", "new delhi": "DELHI", "delhi ncr": "DELHI",
		"gurugram": "GURUGRAM", "gurgaon": "GURUGRAM", "ggn": "GURUGRAM",
		"noida":  "NOIDA",
		"mumbai": "MUMBAI", "bombay": "MUMBAI",
		"bengaluru": "BENGALURU", "bangalore": "BENGALURU", "blr": "BENGALURU",
		"chennai": "CHENNAI", "madras": "CHENNAI",
		"hyderabad": "HYDERABAD", "hyd": "HYDERABAD",
		"pune": "PUNE", "poona": "PUNE",
		"kolkata": "KOLKATA", "calcutta": "KOLKATA",
		"ahmedabad": "AHMEDABAD", "amdavad": "AHMEDABAD", "ahmadabad": "AHMEDABAD",
		"दिल्ली": "DELHI", "नई दिल्ली": "DELHI", "गुरुग्राम": "GURUGRAM", "नोएडा": "NOIDA",
		"मुंबई": "MUMBAI", "मुम्बई": "MUMBAI", "बेंगलुरु": "BENGALURU", "बेंगलूरु": "BENGALURU",
		"ಬೆಂಗಳೂರು": "BENGALURU", "चेन्नई": "CHENNAI", "சென்னை": "CHENNAI", "हैदराबाद": "HYDERABAD",
		"హైదరాబాద్": "HYDERABAD", "पुणे": "PUNE", "कोलकाता": "KOLKATA", "কলকাতা": "KOLKATA",
		"अहमदाबाद": "AHMEDABAD", "અમદાવાદ": "AHMEDABAD",
	},
	"purchase_category": {
		"footwear": "FOOTWEAR", "shoes": "FOOTWEAR", "sneakers": "FOOTWEAR",
		"fashion": "FASHION", "apparel": "FASHION", "clothing": "FASHION", "clothes": "FASHION",
		"electronics": "ELECTRONICS", "mobiles": "ELECTRONICS", "gadgets": "ELECTRONICS",
		"grocery": "GROCERY", "groceries": "GROCERY",
		"travel": "TRAVEL", "flights": "TRAVEL", "hotels": "TRAVEL",
		"beauty": "BEAUTY", "cosmetics": "BEAUTY", "personal care": "BEAUTY",
		"home": "HOME", "home and kitchen": "HOME", "home kitchen": "HOME", "furniture": "HOME",
		"sports": "SPORTS", "fitness": "SPORTS",
	},
	"payment_method": {
		"upi": "UPI", "gpay": "UPI", "google pay": "UPI", "phonepe": "UPI", "phone pe": "UPI",
		"bhim": "UPI", "bhim upi": "UPI", "paytm upi": "UPI", "upi payment": "UPI",
		"credit card": "CREDIT_CARD", "creditcard": "CREDIT_CARD", "cc": "CREDIT_CARD",
		"credit":     "CREDIT_CARD",
		"debit card": "DEBIT_CARD", "debitcard": "DEBIT_CARD", "dc": "DEBIT_CARD", "debit": "DEBIT_CARD",
		"net banking": "NET_BANKING", "netbanking": "NET_BANKING", "nb": "NET_BANKING",
		"internet banking": "NET_BANKING", "online banking": "NET_BANKING",
		"cod": "COD", "cash on delivery": "COD", "cash": "COD", "pay on delivery": "COD",
		"wallet": "WALLET", "paytm wallet": "WALLET", "amazon pay": "WALLET", "mobikwik": "WALLET",
		"freecharge": "WALLET", "e wallet": "WALLET", "ewallet": "WALLET",
	},
	"domestic_international": {
		"domestic": "DOMESTIC", "dom": "DOMESTIC", "national": "DOMESTIC", "d": "DOMESTIC",
		"international": "INTERNATIONAL", "intl": "INTERNATIONAL", "overseas": "INTERNATIONAL",
		"foreign": "INTERNATIONAL", "abroad": "INTERNATIONAL", "i": "INTERNATIONAL",
	},
	"loyalty_tier": {
		"plat": "PLATINUM",
	},
	// Not an attribute Buyers target: where an order was placed, which is how
	// online_shopper is worked out from an orders table.
	"order_channel": {
		"online": "ONLINE", "web": "ONLINE", "website": "ONLINE", "app": "ONLINE",
		"mobile": "ONLINE", "mobile app": "ONLINE", "android": "ONLINE", "ios": "ONLINE",
		"ecommerce": "ONLINE", "e commerce": "ONLINE", "internet": "ONLINE", "digital": "ONLINE",
		"marketplace": "ONLINE", "desktop": "ONLINE", "msite": "ONLINE", "pwa": "ONLINE",
		"offline": "OFFLINE", "store": "OFFLINE", "in store": "OFFLINE", "instore": "OFFLINE",
		"retail": "OFFLINE", "pos": "OFFLINE", "shop": "OFFLINE", "outlet": "OFFLINE",
		"counter": "OFFLINE", "branch": "OFFLINE", "walk in": "OFFLINE", "walkin": "OFFLINE",
		"showroom": "OFFLINE", "physical": "OFFLINE",
	},
}

// EnumMapper turns raw values into one attribute's standard codes.
type EnumMapper struct {
	key       string
	allowed   map[string]bool
	synonyms  map[string]string
	shared    map[string]string
	overrides map[string]string
}

// NewEnumMapper builds a mapper for an ENUM attribute. Overrides are the
// Partner's own answers from the setup page, keyed by the raw value as it
// appears in their data; an override to "" means "ignore this value".
func NewEnumMapper(attr standard.Attribute, overrides map[string]string) (*EnumMapper, error) {
	if attr.Kind != standard.KindEnum {
		return nil, fmt.Errorf("%s is not a list-of-values attribute", attr.Key)
	}
	m := &EnumMapper{
		key:       attr.Key,
		allowed:   map[string]bool{},
		synonyms:  synonyms[attr.Key],
		shared:    sharedFor(attr.Key),
		overrides: map[string]string{},
	}
	for _, code := range attr.Allowed {
		m.allowed[code] = true
	}
	for raw, code := range overrides {
		if code != "" && !m.allowed[code] {
			return nil, fmt.Errorf("%s: %q is not one of its codes", attr.Key, code)
		}
		m.overrides[Normalize(raw)] = code
	}
	return m, nil
}

// Ignored reports whether a value is treated as empty rather than reported as
// unrecognised: the Partner said to leave it out, or it is a place Oolix does
// not list (see Outside).
func (m *EnumMapper) Ignored(raw any) bool {
	key := Normalize(Text(raw))
	if code, ok := m.overrides[key]; ok {
		return code == ""
	}
	return m.outside(key)
}

// Outside reports a value recognised as a place in India that Oolix does not
// list: a pincode, district or state elsewhere -- 226001, Lucknow, Kerala.
// There is nothing to ask the Partner about it, so it is left empty, as if
// blank, and counted rather than listed.
func (m *EnumMapper) Outside(raw any) bool {
	key := Normalize(Text(raw))
	if _, ok := m.overrides[key]; ok {
		return false
	}
	return m.outside(key)
}

func (m *EnumMapper) outside(key string) bool {
	if key == "" {
		return false
	}
	if _, ok := m.lookup(key); ok {
		return false
	}
	if code, known := m.pincode(key); known {
		return code == ""
	}
	switch m.key {
	case "city":
		if _, ok := m.partOf(key); ok {
			return false // Bangalore North: asked about, with a suggestion
		}
		city, known := knownPlace(key)
		return known && !m.allowed[city]
	case "state_region":
		code, known := otherStates[key]
		return known && !m.allowed[code]
	}
	return false
}

// Map returns the standard code for a raw value, or false when there is none.
func (m *EnumMapper) Map(raw any) (string, bool) {
	key := Normalize(Text(raw))
	if key == "" {
		return "", false
	}
	if code, ok := m.overrides[key]; ok {
		return code, code != ""
	}
	if code, ok := m.lookup(key); ok {
		return code, true
	}
	if code, _ := m.pincode(key); code != "" {
		return code, true
	}
	return "", false
}

// lookup finds a normalised value's code by name: the code itself, a
// built-in synonym, a shared one, or another state's name once Oolix lists
// that state.
func (m *EnumMapper) lookup(key string) (string, bool) {
	// Already a code: "MUMBAI", "credit_card", "Credit Card".
	if code := strings.ToUpper(strings.ReplaceAll(key, " ", "_")); m.allowed[code] {
		return code, true
	}
	if code, ok := m.synonyms[key]; ok {
		return code, true
	}
	if code, ok := m.shared[key]; ok && m.allowed[code] {
		return code, true
	}
	if m.key == "state_region" {
		if code, ok := otherStates[key]; ok && m.allowed[code] {
			return code, true
		}
	}
	return "", false
}

// pincode reads a city or state from a pincode: known is true for any
// pincode in the directory, and code is "" when its place is not listed.
func (m *EnumMapper) pincode(key string) (code string, known bool) {
	if m.key != "city" && m.key != "state_region" {
		return "", false
	}
	state, city, known := Pincode(key)
	if !known {
		return "", false
	}
	code = state
	if m.key == "city" {
		code = city
	}
	if !m.allowed[code] {
		code = ""
	}
	return code, true
}

// Normalize folds case, punctuation and spacing so that "Credit-Card",
// "credit_card" and " CREDIT  CARD " are one value.
func Normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.NewReplacer("_", " ", "-", " ", ".", " ", "/", " ", "&", " and ", "'", "").Replace(s)
	return strings.Join(strings.Fields(s), " ")
}
