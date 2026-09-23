package config

import (
	"path/filepath"
	"strings"
	"testing"
)

// The shipped example is what every Partner copies, so it is tested like code
// rather than treated as documentation.
//
// This file exists because of a real defect: the reference config wrapped
// columns in functions -- `date_part('year', age(dob))` -- which no index can
// serve, measured 76x slower than the equivalent range. The compiler had
// supported the indexable form all along and the integration guide already
// taught it; only the shipped example was never updated. A Partner following
// the file rather than the guide inherited the slow version into their own
// infrastructure, where fixing it later happens on their schedule.

func exampleConfig(t *testing.T) *Config {
	t.Helper()
	cfg, err := Load(filepath.Join("..", "..", "config.example.yaml"))
	if err != nil {
		t.Fatalf("the shipped example config does not load: %v", err)
	}
	return cfg
}

func TestExampleConfigLoads(t *testing.T) {
	cfg := exampleConfig(t)
	if len(cfg.Connector.Audience.Mapping) == 0 {
		t.Error("the example ships no attribute mapping")
	}
}

func TestEveryDerivedAttributeInTheExampleIsIndexable(t *testing.T) {
	// A mapping whose expression wraps a column in a function must also name
	// the raw column, or the audience reads the whole table every time.
	cfg := exampleConfig(t)

	for key, m := range cfg.Connector.Audience.Mapping {
		wrapped := strings.Contains(m.Expr, "date_part(") ||
			strings.Contains(m.Expr, "age(") ||
			strings.Contains(m.Expr, "extract(") ||
			strings.Contains(m.Expr, "EXTRACT(")

		if !wrapped {
			continue
		}
		if m.Column == "" || m.Derive == "" {
			t.Errorf(
				"attribute %q uses a function over a column (%s) but declares no column/derive, "+
					"so no index can serve it", key, m.Expr)
		}
	}
}

func TestTheDerivationsTheExampleDeclaresAreOnesTheCompilerKnows(t *testing.T) {
	// A typo here is silent: an unrecognised derivation falls back to the
	// unindexable expression, which is correct and slow.
	known := map[string]bool{"years_since": true, "days_since": true}

	cfg := exampleConfig(t)
	for key, m := range cfg.Connector.Audience.Mapping {
		if m.Derive == "" {
			continue
		}
		if !known[m.Derive] {
			t.Errorf("attribute %q declares derive: %q, which the compiler does not implement",
				key, m.Derive)
		}
		if m.Column == "" {
			t.Errorf("attribute %q declares a derivation but no column to derive it from", key)
		}
	}
}

func TestTheExampleShipsExternalChannelsOff(t *testing.T) {
	// §84: an external channel stays unavailable until its eligibility model
	// is proven for a specific Partner/Buyer relationship. A shipped example
	// with one switched on would be an invitation to skip that.
	cfg := exampleConfig(t)
	if cfg.Channels.Meta.Enabled {
		t.Error("the example ships with Meta enabled")
	}
	if cfg.Channels.Google.Enabled {
		t.Error("the example ships with Google enabled")
	}
}

func TestTheExampleShipsNoCredential(t *testing.T) {
	// A copied example with a real-looking token in it is how a placeholder
	// reaches production.
	cfg := exampleConfig(t)
	for _, secret := range []string{
		cfg.Channels.Meta.AccessToken,
		cfg.Channels.Google.AccessToken,
	} {
		if secret != "" {
			t.Errorf("the example ships an inline access token: %q", secret)
		}
	}
}
