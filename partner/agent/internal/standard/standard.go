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

// Form is how a Partner's column holds an attribute. The same fact arrives in
// many shapes -- a date of birth, an age, an age group -- and each is read
// into the same stored range.
type Form string

const (
	// FormNative is the attribute's own form: a date of birth for age, a
	// date for the recency attributes, a code, a yes/no, a count.
	FormNative Form = ""
	// FormBirthYear is a year of birth: 1992.
	FormBirthYear Form = "birth_year"
	// FormAge is an age in whole years, true on some date: 25.
	FormAge Form = "age"
	// FormAgeBand is an age group, true on some date: 25-45, 60+, under 25.
	FormAgeBand Form = "age_band"
	// FormDaysSince is a number of whole days before some date: 12.
	FormDaysSince Form = "days_since"
	// FormWithinDays is yes or no for "in the last N days", true on some date.
	FormWithinDays Form = "within_days"
)

// NeedsAsOf says whether values in this form were true on a particular date,
// which the Partner has to name: an age of 25 means nothing until we know
// when the customer was 25.
func (f Form) NeedsAsOf() bool {
	return f == FormAge || f == FormAgeBand || f == FormDaysSince || f == FormWithinDays
}

// Attribute is one standard attribute and the local column that holds it.
type Attribute struct {
	// Key is Oolix's name for it -- the only thing Oolix ever hears about.
	Key string
	// Label is how the setup page names it to the Partner.
	Label string
	// Column is where the cleaned value lives in the local copy. For an
	// attribute stored as a range it is the low end: the earliest date or
	// the smallest count the value can be.
	Column string
	// Upper is the column holding the high end of a range attribute: the
	// latest date or the largest count. Empty for attributes held exactly.
	//
	// A value known exactly has both ends equal. A year of birth, an age or an
	// age group is a wider range, and a missing end means no bound on that
	// side ("35+" has no earliest birth date). Rules are answered with the
	// customers who CERTAINLY match: every value in their range satisfies the
	// rule, so nobody is shown an ad because they might be in the audience.
	Upper string
	// Forms are the shapes besides the native one a Partner's column may hold
	// this attribute in, with the column names that suggest each.
	Forms map[Form][]string
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
		Key: "age", Label: "Age", Column: "dob", Upper: "dob_hi",
		Kind: KindDate, Type: "NUMBER", Derive: "years_since",
		Expr: "date_part('year', age(dob))", Operators: []string{"BETWEEN"},
		Hints: []string{"dob", "date_of_birth", "dateofbirth", "birth_date", "birthdate",
			"birthday", "bday", "birth_dt", "dt_of_birth", "d_o_b"},
		Forms: map[Form][]string{
			FormBirthYear: {"yob", "birth_year", "year_of_birth", "birthyear", "byear", "birth_yr"},
			FormAge:       {"age", "customer_age", "current_age", "age_years", "age_yrs", "age_in_years", "cust_age"},
			FormAgeBand: {"age_group", "age_band", "age_range", "agegroup", "ageband", "age_bucket",
				"age_bracket", "age_category", "age_segment", "age_grp"},
		},
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
		Upper: "last_order_at_hi",
		Kind:  KindTimestamp, Type: "NUMBER", Derive: "days_since",
		Expr:      "date_part('day', now() - last_order_at)",
		Operators: []string{"LTE"},
		Hints: []string{"last_order_at", "last_order_date", "last_purchase_at", "last_purchase_date",
			"last_ordered_at", "last_order", "last_purchase", "last_txn_date"},
		Forms: map[Form][]string{
			FormDaysSince: {"days_since_last_order", "days_since_last_purchase", "days_since_order",
				"days_since_purchase", "purchase_recency", "order_recency", "recency_days", "recency"},
			FormWithinDays: {"purchased_recently", "ordered_recently", "bought_recently", "recent_buyer",
				"recent_purchaser", "is_recent_buyer", "active_buyer"},
		},
	},
	{
		// A count says nothing until its window is known: 5 orders in 30 days
		// and 5 ever are different facts. The Partner names the window; a
		// shorter one than 90 days gives a lower bound -- at least that many
		// in 90 -- so only those customers count as certain.
		Key: "purchase_frequency", Label: "Purchases in the last 90 days", Column: "purchase_frequency",
		Upper: "purchase_frequency_hi",
		Kind:  KindNumber, Type: "NUMBER", Expr: "purchase_frequency",
		Operators: []string{"GTE"},
		Hints: []string{"order_count_90d", "orders_90d", "purchase_count_90d", "purchases_90d",
			"orders_last_90_days", "purchase_frequency", "order_count_30d", "orders_30d",
			"purchase_count_30d", "purchases_30d", "orders_last_30_days", "orders_60d", "orders_7d"},
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
		Upper: "last_booking_at_hi",
		Kind:  KindTimestamp, Type: "NUMBER", Derive: "days_since",
		Expr:      "date_part('day', now() - last_booking_at)",
		Operators: []string{"LTE"},
		Hints: []string{"last_booking_at", "last_booking_date", "last_trip_date", "last_travel_date",
			"last_booking"},
		Forms: map[Form][]string{
			FormDaysSince:  {"days_since_last_booking", "days_since_booking", "days_since_last_trip", "booking_recency"},
			FormWithinDays: {"booked_recently", "travelled_recently", "traveled_recently", "recent_traveller"},
		},
	},
	{
		Key: "active_user_days", Label: "Days since last seen", Column: "last_seen_at",
		Upper: "last_seen_at_hi",
		Kind:  KindTimestamp, Type: "NUMBER", Derive: "days_since",
		Expr:      "date_part('day', now() - last_seen_at)",
		Operators: []string{"LTE"},
		Hints: []string{"last_seen_at", "last_login_at", "last_login", "last_active_at",
			"last_activity", "last_seen", "last_visit", "last_login_date", "date_last_active"},
		Forms: map[Form][]string{
			FormDaysSince: {"days_since_login", "days_since_last_login", "days_since_last_seen",
				"days_since_active", "days_since_last_active", "inactive_days", "days_inactive"},
			FormWithinDays: {"active_recently", "recently_active", "is_active", "active_user"},
		},
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
		"mode_of_payment", "tender_type", "payment_channel", "pay_method", "payment_gateway", "gateway"}
	TripHints = []string{"trip_type", "domestic_international", "trip_scope", "travel_type",
		"sector", "route_type", "journey_type", "is_international"}
)
