package managed

import (
	"github.com/oolix/partner-agent/internal/audience"
	"github.com/oolix/partner-agent/internal/standard"
)

// EvaluatorMappings is how audience rules read the local copy. It is the same
// for every Partner -- the cleaning already put each attribute in its own
// standard column -- which is why managed mode needs no mapping file at all.
func EvaluatorMappings() map[string]audience.Mapping {
	out := make(map[string]audience.Mapping, len(standard.Attributes))
	for _, a := range standard.Attributes {
		m := audience.Mapping{Expr: a.Expr, Type: a.Type}
		if a.Derive != "" {
			// Compiled as a range over the stored date, so an index serves it.
			m.Column, m.Derive = a.Column, a.Derive
		}
		out[a.Key] = m
	}
	return out
}

// MappingVersion identifies the fixed local layout in estimate reports. It
// changes only when the Agent's standard columns do.
const MappingVersion = 1
