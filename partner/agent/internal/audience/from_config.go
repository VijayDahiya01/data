package audience

import "github.com/oolix/partner-agent/internal/config"

// MappingsFromConfig translates a Partner's configuration into compiler input.
//
// This is four lines and it lived inline in main.go, where it dropped Column
// and Derive. Nothing failed: the compiler simply saw an ordinary attribute,
// fell back to the function form, and every audience carrying an age rule read
// the whole attribute table. The unit tests for the indexable path kept passing
// the entire time, because they built their mappings by hand.
//
// It is a named function so the translation itself can be tested. A field
// added to the config struct and forgotten here is exactly the failure this
// exists to prevent.
func MappingsFromConfig(in map[string]config.AttributeMapping) map[string]Mapping {
	out := make(map[string]Mapping, len(in))
	for key, m := range in {
		out[key] = Mapping{
			Expr:   m.Expr,
			Type:   m.Type,
			Column: m.Column,
			Derive: m.Derive,
		}
	}
	return out
}
