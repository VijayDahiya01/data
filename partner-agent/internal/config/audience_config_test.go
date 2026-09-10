package config

import "testing"

// The shipped example config is what a Partner copies on day one. If the v6
// mapping block in it does not parse, or has drifted from the taxonomy, every
// Partner starts with an Agent that silently cannot evaluate an audience.
func TestExampleConfigCarriesTheV6Mapping(t *testing.T) {
	cfg, err := Load("../../config.example.yaml")
	if err != nil {
		t.Fatalf("the example config does not load: %v", err)
	}

	// The 16 Appendix A attributes seeded in packages/db/prisma/seed/attributes.ts.
	// A Partner is free to map fewer -- §7 turns a gap into INCOMPATIBLE rather
	// than a wrong answer -- but the example should show the full taxonomy.
	want := []string{
		"age", "gender",
		"country", "state_region", "city",
		"online_shopper", "purchase_category", "purchase_recency_days",
		"purchase_frequency", "payment_method",
		"recent_booking", "domestic_international", "booking_recency_days",
		"active_user_days", "app_active", "loyalty_tier",
	}
	for _, key := range want {
		if _, ok := cfg.Connector.Audience.Mapping[key]; !ok {
			t.Errorf("taxonomy attribute %q has no local mapping", key)
		}
	}

	// §17: the local column names are the thing that must stay Partner-side.
	// Their presence here, and nowhere in the Oolix schema, is the whole point.
	if got := cfg.Connector.Audience.Mapping["payment_method"].Expr; got != "pay_mode" {
		t.Errorf("payment_method should map to this Partner's own column name, got %q", got)
	}

	if cfg.Connector.Audience.MaterializationTTL == 0 {
		t.Error("materialization_ttl did not parse; the audience worker would fall back to a default")
	}
	if cfg.Connector.Audience.EvaluationTimeout <= cfg.Connector.QueryTimeout {
		t.Error("the estimate timeout must be well above the ad-decision timeout: a full-table count is not a page-render query")
	}
}
