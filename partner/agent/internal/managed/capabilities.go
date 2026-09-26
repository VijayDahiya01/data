package managed

import (
	"errors"

	"github.com/oolix/partner-agent/internal/standard"
)

// Capability is one attribute the Agent offers to answer questions about.
type Capability struct {
	AttributeKey string   `json:"attribute_key"`
	Operators    []string `json:"operators"`
	Status       string   `json:"status"`
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
		if provides[a.Key] {
			if withheld(m, a.Key) || last.Attributes[a.Key].Filled == 0 {
				continue
			}
		} else if am, ok := m.Attributes[a.Key]; !ok || am.Column == "" || !am.Publish ||
			last.Attributes[a.Key].Filled == 0 {
			continue
		}
		caps.Attributes = append(caps.Attributes, Capability{
			AttributeKey: a.Key, Operators: a.Operators, Status: "AVAILABLE",
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
