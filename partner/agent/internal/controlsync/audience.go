package controlsync

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/oolix/partner-agent/internal/audience"
)

// AudienceEvaluator is the local half of v6 §8.2 and §11.
//
// An interface rather than a concrete type so this package does not need a
// database handle: the Agent owns the connection, and control sync only needs
// something that can answer "evaluate these rules" and "compile them".
type AudienceEvaluator interface {
	Estimate(ctx context.Context, rules []audience.Rule, expectedHash string) audience.EstimateResult
	Materialize(
		ctx context.Context,
		activationID string,
		audienceGroupID string,
		audienceVersion int,
		rules []audience.Rule,
		expectedHash string,
		ttl time.Duration,
	) (*audience.MaterializeResult, error)
}

// estimateRequestDTO is one item of v6 §8.1's work queue.
type estimateRequestDTO struct {
	ReachEstimateID  string          `json:"reach_estimate_id"`
	AudienceGroupID  string          `json:"audience_group_id"`
	AudienceVersion  int             `json:"audience_version"`
	AudienceRuleHash string          `json:"audience_rule_hash"`
	Rules            []audience.Rule `json:"rules"`
	RequestedAt      string          `json:"requested_at"`
}

type estimateQueueDTO struct {
	Items []estimateRequestDTO `json:"items"`
}

// RunAudienceWorker polls for reach estimate requests and answers them locally.
//
// This is the loop that makes v6's central claim true. Oolix sends rules; the
// evaluation happens HERE, against the Partner's own attribute source; and what
// goes back is a bucket. The count that produced it never leaves the Partner —
// there is no field on the result that could carry it (§8.2, §17).
//
// It runs on its own cadence rather than inside Sync, because an estimate is a
// full-table count that can take seconds and must never delay the 30-second
// control sync that keeps manifests fresh.
func (s *Syncer) RunAudienceWorker(
	ctx context.Context,
	evaluator AudienceEvaluator,
	interval time.Duration,
	ttl time.Duration,
) {
	if evaluator == nil {
		s.log.Info("audience evaluation disabled: no local attribute mapping configured")
		return
	}
	if interval <= 0 {
		interval = 30 * time.Second
	}
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.processEstimates(ctx, evaluator); err != nil {
				// A failed poll is not fatal: the request stays claimed only
				// briefly and is offered again, so the next tick retries.
				s.log.Warn("audience estimate poll failed", "error", err)
			}
			s.reconcileMaterializations(ctx, evaluator, ttl)
		}
	}
}

// materializedState is what this Agent has already compiled, so a rebuild
// happens when something actually changed rather than every tick.
type materializedState struct {
	ruleHash string
	version  int
	builtAt  time.Time
}

// reconcileMaterializations compiles approved audiences into the local
// membership index (§11).
//
// It is driven by the verified snapshot rather than by a separate feed: a
// manifest is the only thing that authorises serving (§11.2), so an audience
// worth materializing is by definition one that arrived on a verified
// manifest. A revoked or expired manifest simply stops appearing, and the
// members age out on their TTL.
func (s *Syncer) reconcileMaterializations(ctx context.Context, evaluator AudienceEvaluator, ttl time.Duration) {
	snap := s.Snapshot()
	if snap == nil {
		return
	}

	for _, candidate := range snap.Candidates {
		m := candidate.Manifest
		if m == nil || m.Audience == nil {
			continue
		}
		// A killed or revoked activation must not be (re)built. §24: a Partner
		// stop takes effect locally even when Oolix is unreachable.
		if snap.KillSwitchAll ||
			snap.KilledActivationIDs[m.ActivationID] ||
			snap.RevokedActivationIDs[m.ActivationID] {
			continue
		}

		if !s.needsMaterialization(m.ActivationID, m.Audience.RuleHash, m.Audience.AudienceVersion, ttl) {
			continue
		}

		rules := make([]audience.Rule, 0, len(m.Audience.Rules))
		for _, r := range m.Audience.Rules {
			rules = append(rules, audience.Rule{
				Attribute: r.Attribute,
				Operator:  audience.Operator(r.Operator),
				Value:     r.Value,
				Required:  r.Required,
				Weight:    r.Weight,
			})
		}

		res, err := evaluator.Materialize(ctx, m.ActivationID, m.Audience.AudienceGroupID,
			m.Audience.AudienceVersion, rules, m.Audience.RuleHash, ttl)
		if err != nil {
			// §11's FAILED state. Reported so an operator can see that an
			// approved audience is not actually servable, without Oolix
			// learning anything about why in terms of people.
			s.log.Warn("audience materialization failed",
				"activation_id", m.ActivationID, "error", err)
			if reportErr := s.ReportMaterialization(ctx, m.ActivationID, "FAILED", 0,
				m.Audience.RuleHash, err.Error()); reportErr != nil {
				s.log.Warn("reporting materialization failure failed", "error", reportErr)
			}
			continue
		}

		s.recordMaterialized(m.ActivationID, m.Audience.RuleHash, m.Audience.AudienceVersion)

		// The member count is local operator information. It is logged HERE,
		// inside the Partner, and is not part of what ReportMaterialization
		// sends -- §11 gives Oolix status, version and freshness only.
		s.log.Info("audience materialized locally",
			"activation_id", m.ActivationID,
			"audience_version", m.Audience.AudienceVersion,
			"materialization_version", res.MaterializationVersion,
			"member_count", res.MemberCount)

		if err := s.ReportMaterialization(ctx, m.ActivationID, "READY",
			res.MaterializationVersion, m.Audience.RuleHash, ""); err != nil {
			s.log.Warn("reporting materialization failed",
				"activation_id", m.ActivationID, "error", err)
		}
	}
}

// needsMaterialization decides whether to rebuild.
//
// Three reasons to rebuild, and no others: never built, the approved rules
// changed, or the build is old enough that the population behind it has moved.
// Rebuilding at half the TTL means members never expire out from under a live
// campaign, which would look to the Buyer like reach silently collapsing.
func (s *Syncer) needsMaterialization(activationID, ruleHash string, version int, ttl time.Duration) bool {
	s.materializedMu.Lock()
	defer s.materializedMu.Unlock()

	prev, ok := s.materialized[activationID]
	if !ok {
		return true
	}
	if prev.ruleHash != ruleHash || prev.version != version {
		return true
	}
	return time.Since(prev.builtAt) > ttl/2
}

func (s *Syncer) recordMaterialized(activationID, ruleHash string, version int) {
	s.materializedMu.Lock()
	defer s.materializedMu.Unlock()

	if s.materialized == nil {
		s.materialized = map[string]materializedState{}
	}
	s.materialized[activationID] = materializedState{
		ruleHash: ruleHash,
		version:  version,
		builtAt:  time.Now(),
	}
}

func (s *Syncer) processEstimates(ctx context.Context, evaluator AudienceEvaluator) error {
	queue, err := s.pullEstimateRequests(ctx)
	if err != nil {
		return err
	}

	for _, request := range queue.Items {
		// §8.2 step 1: the Agent verifies the rules produce the hash it was
		// given BEFORE evaluating. The evaluator repeats this check; doing it
		// here too means a mismatch is logged with the request that caused it.
		result := evaluator.Estimate(ctx, request.Rules, request.AudienceRuleHash)

		s.log.Info("audience reach estimated locally",
			"reach_estimate_id", request.ReachEstimateID,
			"audience_version", request.AudienceVersion,
			"status", result.Status,
			// The bucket is safe to log. There is no count to omit.
			"reach_bucket", string(result.ReachBucket),
		)

		if err := s.reportEstimate(ctx, request.ReachEstimateID, result); err != nil {
			s.log.Warn("reporting reach estimate failed",
				"reach_estimate_id", request.ReachEstimateID, "error", err)
		}
	}

	return nil
}

func (s *Syncer) pullEstimateRequests(ctx context.Context) (*estimateQueueDTO, error) {
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return nil, fmt.Errorf("agent token: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		s.opts.APIBaseURL+"/agent/v1/audience/estimate-requests", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Agent-Id", s.opts.AgentID)

	res, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return nil, fmt.Errorf("estimate request pull returned %d: %s", res.StatusCode, string(body))
	}

	var queue estimateQueueDTO
	if err := json.NewDecoder(res.Body).Decode(&queue); err != nil {
		return nil, fmt.Errorf("decode estimate queue: %w", err)
	}
	return &queue, nil
}

func (s *Syncer) reportEstimate(ctx context.Context, estimateID string, result audience.EstimateResult) error {
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return err
	}

	payload := map[string]interface{}{
		"reach_estimate_id":  estimateID,
		"status":             result.Status,
		"audience_rule_hash": result.RuleHash,
		"mapping_version":    result.MappingVersion,
		"freshness_at":       result.FreshnessAt.Format(time.RFC3339),
	}
	// Only a READY result carries a bucket. BELOW_THRESHOLD deliberately does
	// not: "fewer than the minimum cohort" is itself a disclosure (§17).
	if result.Status == "READY" && result.ReachBucket != "" {
		payload["reach_bucket"] = string(result.ReachBucket)
	}
	if result.FailureReason != "" {
		payload["failure_reason"] = result.FailureReason
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.opts.APIBaseURL+"/agent/v1/audience/estimate-results", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Agent-Id", s.opts.AgentID)
	req.Header.Set("Content-Type", "application/json")

	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		responseBody, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("estimate result returned %d: %s", res.StatusCode, string(responseBody))
	}
	return nil
}

// ReportMaterialization tells Oolix that an approved audience is compiled and
// servable (§11).
//
// Status, version and freshness — nothing else. §11's privacy boundary is
// explicit that "audience materialization and member IDs remain inside the Data
// Partner", and this payload has no field that could carry either.
func (s *Syncer) ReportMaterialization(
	ctx context.Context,
	activationID string,
	status string,
	materializationVersion int,
	ruleHash string,
	lastError string,
) error {
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return err
	}

	payload := map[string]interface{}{
		"activation_id":           activationID,
		"status":                  status,
		"materialization_version": materializationVersion,
		"built_at":                time.Now().UTC().Format(time.RFC3339),
	}
	if ruleHash != "" {
		payload["audience_rule_hash"] = ruleHash
	}
	if lastError != "" {
		payload["last_error"] = lastError
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.opts.APIBaseURL+"/agent/v1/audience/materializations", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Agent-Id", s.opts.AgentID)
	req.Header.Set("Content-Type", "application/json")

	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		responseBody, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("materialization report returned %d: %s", res.StatusCode, string(responseBody))
	}
	return nil
}

// ReportSync tells Oolix what happened to an external audience (§47.11, §48.9).
//
// Deliberately matches channel.Reporter so the sync loop can call the control
// client directly rather than through an adapter that exists only to satisfy
// an interface.
//
// Only the resource id, a status and two counts travel. §47.11: "raw matching
// payload is not stored in Oolix DB." The counts are what make a broken field
// mapping visible -- an upload of 12 members out of 40,000 succeeds at the
// platform and is only detectable here.
func (s *Syncer) ReportSync(
	ctx context.Context,
	activationID, provider, resourceID, status string,
	accepted, skipped int,
) error {
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return err
	}

	payload := map[string]interface{}{
		"activation_id": activationID,
		"provider":      provider,
		"status":        status,
		"accepted":      accepted,
		"skipped":       skipped,
	}
	if resourceID != "" {
		payload["resource_id"] = resourceID
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.opts.APIBaseURL+"/agent/v1/channel-status", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Agent-Id", s.opts.AgentID)
	req.Header.Set("Content-Type", "application/json")

	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		responseBody, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("channel status report returned %d: %s", res.StatusCode, string(responseBody))
	}
	return nil
}

// PublishCapabilities tells Oolix which standard attributes this Agent can
// answer, and with which operators. A managed Agent calls it after a sync;
// the body names attribute keys only, never a local column or a value.
func (s *Syncer) PublishCapabilities(ctx context.Context, capabilities any) error {
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return err
	}
	body, err := json.Marshal(capabilities)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.opts.APIBaseURL+"/agent/v1/audience/capabilities", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Agent-Id", s.opts.AgentID)
	req.Header.Set("Content-Type", "application/json")

	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		responseBody, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("publishing capabilities returned %d: %s", res.StatusCode, string(responseBody))
	}
	return nil
}

// ReportQuality tells Oolix how complete a managed Agent's copy is after a
// full sync: per published attribute, the share of customers with a value.
// Percentages and a size band only, for the Partner's own portal.
func (s *Syncer) ReportQuality(ctx context.Context, report any) error {
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return err
	}
	body, err := json.Marshal(report)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.opts.APIBaseURL+"/agent/v1/audience/quality", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Agent-Id", s.opts.AgentID)
	req.Header.Set("Content-Type", "application/json")

	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode >= 300 {
		responseBody, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("reporting data quality returned %d: %s", res.StatusCode, string(responseBody))
	}
	return nil
}
