// Package standard is Oolix's attribute vocabulary as the Agent sees it in
// managed mode (v6 §4, Appendix A).
//
// In managed mode the Agent keeps its own cleaned copy of the Partner's data,
// so the copy has ONE fixed shape: a column per standard attribute, holding
// values already translated into Oolix's codes. That is what lets a Partner
// connect any database without writing a mapping: the translation happens
// once, on the way in, and everything downstream -- audience rules, member
// lists, ad decisions -- sees the same table whatever the source was.
//
// The keys, types and allowed values mirror the taxonomy the API seeds
// (oolix/packages/db/prisma/seed/attributes.ts); standard_test.go fails if the
// two drift apart.
package standard

// Kind is how a raw value is read on its way into the local copy.
type Kind string

const (
	// KindDate is a calendar date, such as a date of birth.
	KindDate Kind = "DATE"
	// KindTimestamp is a moment, such as the last order.
	KindTimestamp Kind = "TIMESTAMP"
	// KindEnum is one of the attribute's allowed codes.
	KindEnum Kind = "ENUM"
	// KindBool is yes or no.
	KindBool Kind = "BOOLEAN"
	// KindNumber is a count.
	KindNumber Kind = "NUMBER"
)

// Attribute is one standard attribute and the local column that holds it.
type Attribute struct {
	// Key is Oolix's name for it -- the only thing Oolix ever hears about.
	Key string
	// Label is how the setup page names it to the Partner.
	Label string
	// Column is where the cleaned value lives in the local copy.
	Column string
	// Kind is how raw values are read.
	Kind Kind
	// Type is the taxonomy data type rules are compiled against.
	Type string
	// Derive turns a stored date into the attribute's value: "years_since"
	// for age, "days_since" for the recency attributes. Empty otherwise.
	Derive string
	// Expr is the attribute as SQL over the local copy.
	Expr string
	// Operators are the rule operators a Buyer may use on it.
	Operators []string
	// Allowed are the codes an ENUM may take.
	Allowed []string
	// Hints are column names that usually hold it, lower-case, used to
	// suggest a match. Values are checked too; see package detect.
	Hints []string
}

// Attributes is the full vocabulary, in the order the setup page shows it.
var Attributes = []Attribute{
	{
		Key: "age", Label: "Age (from date of birth)", Column: "dob",
		Kind: KindDate, Type: "NUMBER", Derive: "years_since",
		Expr: "date_part('year', age(dob))", Operators: []string{"BETWEEN"},
		Hints: []string{"dob", "date_of_birth", "dateofbirth", "birth_date", "birthdate",
			"birthday", "bday", "birth_dt", "dt_of_birth", "d_o_b"},
	},
	{
		Key: "gender", Label: "Gender", Column: "gender",
		Kind: KindEnum, Type: "ENUM", Expr: "gender", Operators: []string{"IN"},
		Allowed: []string{"MALE", "FEMALE", "OTHER", "UNDISCLOSED"},
		Hints:   []string{"gender", "sex", "gender_code", "sex_code", "gndr"},
	},
	{
		Key: "country", Label: "Country", Column: "country",
		Kind: KindEnum, Type: "ENUM", Expr: "country", Operators: []string{"IN"},
		Allowed: []string{"IN"},
		Hints:   []string{"country", "country_code", "nationality", "cntry"},
	},
	{
		Key: "state_region", Label: "State", Column: "state_region",
		Kind: KindEnum, Type: "ENUM", Expr: "state_region", Operators: []string{"IN"},
		Allowed: []string{"DL", "HR", "UP", "KA", "MH", "TN", "TG", "GJ", "WB", "RJ"},
		Hints:   []string{"state", "state_code", "region", "region_code", "province", "state_name"},
	},
	{
		Key: "city", Label: "City", Column: "city",
		Kind: KindEnum, Type: "ENUM", Expr: "city", Operators: []string{"IN"},
		Allowed: []string{"DELHI", "GURUGRAM", "NOIDA", "MUMBAI", "BENGALURU", "CHENNAI",
			"HYDERABAD", "PUNE", "KOLKATA", "AHMEDABAD"},
		Hints: []string{"city", "city_name", "city_code", "town", "location_city"},
	},
	{
		Key: "online_shopper", Label: "Shops online", Column: "online_shopper",
		Kind: KindBool, Type: "BOOLEAN", Expr: "online_shopper", Operators: []string{"EQ"},
		Hints: []string{"online_shopper", "is_online_buyer", "online_buyer", "shops_online",
			"is_online_shopper"},
	},
	{
		Key: "purchase_category", Label: "Main purchase category", Column: "purchase_category",
		Kind: KindEnum, Type: "ENUM", Expr: "purchase_category", Operators: []string{"IN"},
		Allowed: []string{"FOOTWEAR", "FASHION", "ELECTRONICS", "GROCERY", "TRAVEL", "BEAUTY",
			"HOME", "SPORTS"},
		Hints: []string{"purchase_category", "product_category", "category", "product_class",
			"top_category", "fav_category", "favourite_category", "favorite_category"},
	},
	{
		Key: "purchase_recency_days", Label: "Days since last purchase", Column: "last_order_at",
		Kind: KindTimestamp, Type: "NUMBER", Derive: "days_since",
		Expr:      "date_part('day', now() - last_order_at)",
		Operators: []string{"LTE"},
		Hints: []string{"last_order_at", "last_order_date", "last_purchase_at", "last_purchase_date",
			"last_ordered_at", "last_order", "last_purchase", "last_txn_date"},
	},
	{
		Key: "purchase_frequency", Label: "Purchases in the last 90 days", Column: "purchase_frequency",
		Kind: KindNumber, Type: "NUMBER", Expr: "purchase_frequency",
		Operators: []string{"GTE"},
		Hints: []string{"order_count_90d", "orders_90d", "purchase_count_90d", "purchase_frequency",
			"order_count", "orders_count", "num_orders", "total_orders"},
	},
	{
		Key: "payment_method", Label: "Usual payment method", Column: "payment_method",
		Kind: KindEnum, Type: "ENUM", Expr: "payment_method", Operators: []string{"IN"},
		Allowed: []string{"UPI", "CREDIT_CARD", "DEBIT_CARD", "NET_BANKING", "COD", "WALLET"},
		Hints: []string{"payment_method", "pay_mode", "payment_mode", "payment_type",
			"preferred_payment", "pay_method", "payment_channel"},
	},
	{
		Key: "recent_booking", Label: "Booked recently", Column: "recent_booking",
		Kind: KindBool, Type: "BOOLEAN", Expr: "recent_booking", Operators: []string{"EQ"},
		Hints: []string{"recent_booking", "has_recent_trip", "has_recent_booking", "recently_booked"},
	},
	{
		Key: "domestic_international", Label: "Domestic or international traveller",
		Column: "domestic_international",
		Kind:   KindEnum, Type: "ENUM", Expr: "domestic_international", Operators: []string{"IN"},
		Allowed: []string{"DOMESTIC", "INTERNATIONAL"},
		Hints:   []string{"trip_scope", "domestic_international", "travel_type", "trip_type"},
	},
	{
		Key: "booking_recency_days", Label: "Days since last booking", Column: "last_booking_at",
		Kind: KindTimestamp, Type: "NUMBER", Derive: "days_since",
		Expr:      "date_part('day', now() - last_booking_at)",
		Operators: []string{"LTE"},
		Hints: []string{"last_booking_at", "last_booking_date", "last_trip_date", "last_travel_date",
			"last_booking"},
	},
	{
		Key: "active_user_days", Label: "Days since last seen", Column: "last_seen_at",
		Kind: KindTimestamp, Type: "NUMBER", Derive: "days_since",
		Expr:      "date_part('day', now() - last_seen_at)",
		Operators: []string{"LTE"},
		Hints: []string{"last_seen_at", "last_login_at", "last_login", "last_active_at",
			"last_activity", "last_seen", "last_visit", "last_login_date"},
	},
	{
		Key: "app_active", Label: "Uses the app", Column: "app_active",
		Kind: KindBool, Type: "BOOLEAN", Expr: "app_active", Operators: []string{"EQ"},
		Hints: []string{"app_active", "uses_app", "app_user", "has_app", "app_installed",
			"is_app_user"},
	},
	{
		Key: "loyalty_tier", Label: "Loyalty tier", Column: "loyalty_tier",
		Kind: KindEnum, Type: "ENUM", Expr: "loyalty_tier", Operators: []string{"IN"},
		Allowed: []string{"BRONZE", "SILVER", "GOLD", "PLATINUM"},
		Hints:   []string{"loyalty_tier", "tier", "tier_code", "membership_tier", "member_tier", "level"},
	},
}

// ByKey finds an attribute by its Oolix key.
func ByKey(key string) (Attribute, bool) {
	for _, a := range Attributes {
		if a.Key == key {
			return a, true
		}
	}
	return Attribute{}, false
}

// MinimumAge is the youngest person a Partner's copy may hold. India's DPDP
// Act 2023 forbids targeted advertising directed at children, so anyone
// younger is left out of the copy altogether rather than merely unmatched.
const MinimumAge = 18

// IDHints are column names that usually hold the Partner's customer id.
var IDHints = []string{"customer_id", "user_id", "partner_user_id", "cust_id", "member_id",
	"account_id", "uid", "userid", "customerid", "id", "_id"}

// ConsentHints are column names that usually record marketing consent: a
// yes/no flag, or the date consent was given.
var ConsentHints = []string{"marketing_consent", "marketing_opt_in", "marketing_optin",
	"consent", "opt_in", "optin", "accepts_marketing", "email_opt_in", "promo_consent",
	"consent_marketing", "is_subscribed", "subscribed", "marketing_opt_in_at", "opted_in_at",
	"consent_given_at", "consent_date"}

// WithdrawalHints are column names that usually record consent being taken
// back: a yes/no flag, or the date it happened.
var WithdrawalHints = []string{"unsubscribed", "unsubscribed_at", "opt_out", "optout",
	"opted_out", "opted_out_at", "marketing_opt_out", "dnd", "do_not_disturb", "do_not_contact",
	"consent_withdrawn", "consent_withdrawn_at", "withdrawn_at"}

// --- orders and bookings ------------------------------------------------------

// A Partner may also point the Agent at a table with one row per order or per
// booking. The Agent reads it at every sync and works these attributes out per
// customer, so nobody has to pre-compute "orders in the last 90 days".
const (
	// HistoryDays is how far back orders and bookings are read: the longest
	// window a Buyer can ask about (the taxonomy caps recency at 730 days).
	HistoryDays = 730
	// FrequencyDays is purchase_frequency's window.
	FrequencyDays = 90
	// RecentDays is the window for the main category and payment method,
	// shopping online, a recent booking, and the latest trip's type.
	RecentDays = 365
)

// OrderKeys are the attributes an orders table can provide; BookingKeys, a
// bookings table.
var (
	OrderKeys = []string{"purchase_recency_days", "purchase_frequency", "purchase_category",
		"payment_method", "online_shopper"}
	BookingKeys = []string{"booking_recency_days", "recent_booking", "domestic_international"}
)

// OrderChannel says where an order was placed. It is not an attribute a Buyer
// can target: it is how online_shopper is worked out from an orders table.
var OrderChannel = Attribute{
	Key: "order_channel", Label: "Where the order was placed", Kind: KindEnum,
	Allowed: []string{"ONLINE", "OFFLINE"},
	Hints: []string{"channel", "order_channel", "sales_channel", "platform", "order_source",
		"source", "medium", "order_mode", "store_type"},
}

// Column hints for orders and bookings tables.
var (
	OrderDateHints = []string{"order_date", "ordered_at", "order_time", "order_datetime",
		"purchase_date", "purchased_at", "transaction_date", "txn_date", "invoice_date",
		"created_at", "date"}
	BookingDateHints = []string{"booking_date", "booked_at", "booking_time", "booking_datetime",
		"reservation_date", "booking_created_at", "created_at", "date"}
	CategoryHints = []string{"category", "product_category", "category_name", "purchase_category",
		"department", "dept", "vertical", "product_type"}
	PaymentHints = []string{"payment_method", "payment_mode", "pay_mode", "payment_type",
		"mode_of_payment", "tender_type", "payment_channel", "pay_method"}
	TripHints = []string{"trip_type", "domestic_international", "trip_scope", "travel_type",
		"sector", "route_type", "journey_type", "is_international"}
)
