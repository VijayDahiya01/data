package managed

import (
	"context"

	"github.com/oolix/partner-agent/internal/addecision"
	"github.com/oolix/partner-agent/internal/connector"
)

// The ad-decision path's two lookups, against the local copy.
const (
	// Prebuilt segments are not offered in managed mode, so this table stays
	// empty and every legacy segment manifest is answered "not a member".
	MembershipQuery = `SELECT 1 FROM oolix_segment_membership
		WHERE partner_user_id = $1 AND segment_id = $2 AND expires_at > NOW()`

	// Consent is recorded once for every purpose ('*'). A row for the exact
	// purpose would win over it, but managed mode writes none. No row at all
	// means no consent: the connector fails closed on it.
	ConsentQuery = `SELECT (eligible AND withdrawn_at IS NULL) FROM oolix_user_consent
		WHERE partner_user_id = $1 AND purpose_id IN ($2, '*')
		ORDER BY purpose_id = $2 DESC LIMIT 1`
)

// ScrambledConnector answers ad-decision lookups from the local copy, which
// holds customer ids only in scrambled form. The id in each request is
// scrambled the same way before it is looked up; the raw id is never written
// anywhere.
type ScrambledConnector struct {
	connector.Connector
	Scramble func(string) string
}

func (s ScrambledConnector) IsMember(ctx context.Context, partnerUserID, segmentKey string) (bool, error) {
	return s.Connector.IsMember(ctx, s.Scramble(partnerUserID), segmentKey)
}

func (s ScrambledConnector) IsAdvertisingEligible(ctx context.Context, partnerUserID, purposeID string) (bool, error) {
	return s.Connector.IsAdvertisingEligible(ctx, s.Scramble(partnerUserID), purposeID)
}

// ScrambledAudience does the same for materialized audience membership: the
// member lists were built from the copy, so they hold scrambled ids too.
type ScrambledAudience struct {
	addecision.AudienceIndex
	Scramble func(string) string
}

func (s ScrambledAudience) IsMaterializedMember(ctx context.Context, partnerUserID, activationID string) (bool, int, error) {
	return s.AudienceIndex.IsMaterializedMember(ctx, s.Scramble(partnerUserID), activationID)
}
