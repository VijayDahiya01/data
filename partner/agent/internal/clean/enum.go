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
	allowed   map[string]bool
	synonyms  map[string]string
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
		allowed:   map[string]bool{},
		synonyms:  synonyms[attr.Key],
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

// Ignored reports whether the Partner said to leave this value out: it is
// treated as empty rather than reported as unrecognised again.
func (m *EnumMapper) Ignored(raw any) bool {
	code, ok := m.overrides[Normalize(Text(raw))]
	return ok && code == ""
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
	// Already a code: "MUMBAI", "credit_card", "Credit Card".
	if code := strings.ToUpper(strings.ReplaceAll(key, " ", "_")); m.allowed[code] {
		return code, true
	}
	if code, ok := m.synonyms[key]; ok {
		return code, true
	}
	return "", false
}

// Normalize folds case, punctuation and spacing so that "Credit-Card",
// "credit_card" and " CREDIT  CARD " are one value.
func Normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.NewReplacer("_", " ", "-", " ", ".", " ", "/", " ", "&", " and ", "'", "").Replace(s)
	return strings.Join(strings.Fields(s), " ")
}
