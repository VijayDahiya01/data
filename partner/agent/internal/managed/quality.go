package managed

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

// Quality is what the Agent tells Oolix about its copy after a full sync, so
// the Partner can see in the portal how complete their data is. Percentages
// and a size band only: never a customer, a value, or an exact count.
type Quality struct {
	SyncedAt        time.Time          `json:"synced_at"`
	SyncMode        string             `json:"sync_mode"`
	CustomersBucket string             `json:"customers_bucket"`
	Attributes      []AttributeQuality `json:"attributes"`
}

// AttributeQuality is one published attribute's completeness.
type AttributeQuality struct {
	AttributeKey string `json:"attribute_key"`
	// CoveragePct is the share of customers in the copy with a usable value.
	CoveragePct int `json:"coverage_pct"`
	// UnreadablePct is the share of values present that could not be used.
	UnreadablePct int `json:"unreadable_pct"`
}

// BuildQuality reports on the attributes Oolix was told about.
func BuildQuality(caps Capabilities, rep *Report) Quality {
	q := Quality{SyncedAt: rep.FinishedAt, SyncMode: rep.Mode, CustomersBucket: bucket(rep.Customers)}
	for _, c := range caps.Attributes {
		if c.Status != "AVAILABLE" {
			continue
		}
		ar := rep.Attributes[c.AttributeKey]
		q.Attributes = append(q.Attributes, AttributeQuality{
			AttributeKey:  c.AttributeKey,
			CoveragePct:   pct(ar.Filled, rep.Customers),
			UnreadablePct: pct(ar.Unreadable, ar.Filled+ar.Unreadable),
		})
	}
	return q
}

func pct(part, whole int) int {
	if whole <= 0 {
		return 0
	}
	return part * 100 / whole
}

// bucket is the size band Oolix already uses for reach, so no exact count
// of a Partner's customers leaves their server.
func bucket(n int) string {
	switch {
	case n < 10_000:
		return "UNDER_10K"
	case n < 50_000:
		return "10K_50K"
	case n < 100_000:
		return "50K_100K"
	case n < 250_000:
		return "100K_250K"
	case n < 500_000:
		return "250K_500K"
	case n < 1_000_000:
		return "500K_1M"
	}
	return "OVER_1M"
}

// Fingerprint identifies the choices a sync was made with. An incremental
// sync is only safe on top of a full one made with the same choices.
func (m Mapping) Fingerprint() string {
	m.UpdatedAt, m.PublishedAt = time.Time{}, nil
	raw, _ := json.Marshal(m)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
