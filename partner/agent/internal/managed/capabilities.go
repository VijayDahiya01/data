package managed

import (
	"errors"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/standard"
)

// Capability is one attribute the Agent offers to answer questions about.
type Capability struct {
	AttributeKey string   `json:"attribute_key"`
	Operators    []string `json:"operators"`
	Status       string   `json:"status"`
	// Precision is absent when the copy holds the attribute exactly.
	Precision *Precision `json:"precision,omitempty"`
}

// Precision says how exactly the copy holds an attribute, when not exactly:
// ages as groups 25-45, purchases counted over 30 days. It is the Partner's
// FORMAT -- group edges and window lengths -- never a value or a count, and it
// lets Oolix tell a Buyer when a rule is narrower than the data can answer.
type Precision struct {
	// Kind is APPROXIMATE (ranges up to Width Units wide), BANDS (age groups
	// kept up to date), WITHIN (a yes/no for the last Days days) or WINDOW (a
	// count over Days days rather than the attribute's own window).
	Kind  string          `json:"kind"`
	Unit  string          `json:"unit,omitempty"`
	Width int             `json:"width,omitempty"`
	Bands []PrecisionBand `json:"bands,omitempty"`
	Days  int             `json:"days,omitempty"`
}

// PrecisionBand is one age group; Hi is nil for an open one ("60+").
type PrecisionBand struct {
	Lo int  `json:"lo"`
	Hi *int `json:"hi"`
}

// precisionOf is how exactly a mapping holds an attribute.
func precisionOf(a standard.Attribute, am AttributeMapping, ar AttributeReport) *Precision {
	switch am.Form {
	case standard.FormBirthYear, standard.FormAge:
		return &Precision{Kind: "APPROXIMATE", Unit: "YEARS", Width: 1}
	case standard.FormDaysSince:
		return &Precision{Kind: "APPROXIMATE", Unit: "DAYS", Width: 1}
	case standard.FormWithinDays:
		return &Precision{Kind: "WITHIN", Days: am.Days}
	case standard.FormAgeBand:
		var bands []PrecisionBand
		width := 1
		for _, text := range ar.Bands {
			b, ok := clean.ParseBand(text)
			if !ok {
				continue
			}
			pb := PrecisionBand{Lo: b.Lo}
			if b.Open {
				width = max(width, clean.MaxAge-b.Lo)
			} else {
				hi := b.Hi
				pb.Hi = &hi
				width = max(width, b.Hi-b.Lo+1)
			}
			bands = append(bands, pb)
		}
		if am.AsOf == AsOfRefresh && len(bands) > 0 {
			return &Precision{Kind: "BANDS", Unit: "YEARS", Bands: bands}
		}
		// Groups recorded on different dates have drifted apart: only their
		// width still says anything.
		return &Precision{Kind: "APPROXIMATE", Unit: "YEARS", Width: width}
	}
	if a.Key == "purchase_frequency" && am.window() < standard.FrequencyDays {
		return &Precision{Kind: "WINDOW", Days: am.window()}
	}
	return nil
}

// Capabilities is everything the Agent tells Oolix. It names standard
// attributes and nothing else: never a column, a value or a customer.
type Capabilities struct {
	Attributes     []Capability `json:"attributes"`
	Geographies    []string     `json:"geographies"`
	Channels       []string     `json:"channels"`
	MappingVersion int          `json:"mapping_version"`
}

// ErrNothingToPublish means no attribute the Partner chose had any readable
// value in the copy.
var ErrNothingToPublish = errors.New(
	"nothing to publish: none of the chosen attributes had a readable value in the last sync")

// BuildCapabilities lists the attributes the Partner chose to publish that the
// last good sync actually filled. An attribute whose column turned out empty
// is left out: a Buyer targeting it would reach nobody.
func BuildCapabilities(m Mapping, last *Report) (Capabilities, error) {
	caps := Capabilities{
		Geographies:    []string{"IN"},
		Channels:       m.Channels,
		MappingVersion: MappingVersion,
	}
	if len(caps.Channels) == 0 {
		caps.Channels = []string{"PARTNER_WEB"}
	}
	if last == nil {
		return caps, ErrNothingToPublish
	}
	provides := ActivityProvides(m)
	for _, a := range standard.Attributes {
		var precision *Precision
		if provides[a.Key] {
			// Worked out from every order or booking: exact.
			if withheld(m, a.Key) || last.Attributes[a.Key].Filled == 0 {
				continue
			}
		} else if am, ok := m.Attributes[a.Key]; !ok || am.Column == "" || !am.Publish ||
			last.Attributes[a.Key].Filled == 0 {
			continue
		} else {
			precision = precisionOf(a, am, last.Attributes[a.Key])
		}
		caps.Attributes = append(caps.Attributes, Capability{
			AttributeKey: a.Key, Operators: a.Operators, Status: "AVAILABLE", Precision: precision,
		})
	}
	if len(caps.Attributes) == 0 {
		return caps, ErrNothingToPublish
	}
	return caps, nil
}

// withheld says whether the Partner chose not to offer an attribute their
// orders or bookings table supplies.
func withheld(m Mapping, key string) bool {
	for _, am := range []*ActivityMapping{m.Orders, m.Bookings} {
		if am != nil && contains(am.Withhold, key) {
			return true
		}
	}
	return false
}

// Withdrawn is the same list marked unavailable: what is published when the
// Partner deletes the copy, so no Buyer is offered an audience that cannot be
// served.
func (c Capabilities) Withdrawn() Capabilities {
	out := c
	out.Attributes = make([]Capability, len(c.Attributes))
	for i, a := range c.Attributes {
		a.Status = "UNAVAILABLE"
		out.Attributes[i] = a
	}
	return out
}

// Keys lists the attribute keys, for the status page.
func (c Capabilities) Keys() []string {
	out := make([]string, len(c.Attributes))
	for i, a := range c.Attributes {
		out[i] = a.AttributeKey
	}
	return out
}
