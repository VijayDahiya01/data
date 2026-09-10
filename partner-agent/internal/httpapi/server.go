// Package httpapi serves the Agent's PRIVATE local API -- spec v5 §12.1,
// §21.2, §44, §67, §69.2.
//
// SECURITY POSTURE. This listener is private to the Partner's own network. It
// is the single hop in the whole architecture that carries a partner_user_id,
// and §12 requires the Partner backend -- not the browser -- to be the caller:
//
//	"Partner frontend must never send partner_user_id to Oolix cloud.
//	 Partner backend obtains user identity from existing session and calls
//	 local Agent."
//
// So there is deliberately no CORS support here. A browser must not be able to
// reach this endpoint at all; if one can, the Partner has exposed it wrongly.
package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/addecision"
	"github.com/oolix/partner-agent/internal/connector"
	"github.com/oolix/partner-agent/internal/controlsync"
	"github.com/oolix/partner-agent/internal/metrics"
	"github.com/oolix/partner-agent/internal/state"
)

// Server holds the Agent's local HTTP surface.
type Server struct {
	Engine     *addecision.Engine
	Syncer     *controlsync.Syncer
	Connector  connector.Connector
	State      state.Store
	Logger     *slog.Logger
	Timeout    time.Duration
	StaleGrace time.Duration
	// Metrics may be nil: an Agent that was built before this existed, or a
	// test that does not care, must still serve decisions.
	Metrics *metrics.Recorder
}

type decisionRequest struct {
	PartnerUserID string            `json:"partner_user_id"`
	PlacementID   string            `json:"placement_id"`
	Context       map[string]string `json:"context"`
}

// Handler builds the router.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /private/v1/ad-decision", s.handleAdDecision)
	mux.HandleFunc("POST /private/v1/click", s.handleClick)
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /readyz", s.handleReadyz)
	mux.HandleFunc("GET /version", s.handleVersion)
	// The Partner's own collector scrapes this. Oolix cannot: the Agent is
	// inside the Partner's network and nothing from outside reaches it.
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	return mux
}

// handleAdDecision implements §12.1 / §44's runtime contract.
func (s *Server) handleAdDecision(w http.ResponseWriter, r *http.Request) {
	started := time.Now()

	var req decisionRequest
	// Bounded read: an oversized body must not become a memory-pressure
	// vector on a Partner's own infrastructure.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&req); err != nil {
		// Even a malformed request degrades to NO_AD rather than an error:
		// §43 says an ad failure must not disturb the Partner's page.
		writeJSON(w, http.StatusOK, addecision.Decision{
			Decision: "NO_AD",
			Reason:   addecision.ReasonNoEligibleCampaign,
		})
		return
	}

	if req.PlacementID == "" {
		writeJSON(w, http.StatusOK, addecision.Decision{
			Decision: "NO_AD",
			Reason:   addecision.ReasonPlacementDisabled,
		})
		return
	}

	// §103: the whole decision is capped so a slow segment source cannot push
	// the Partner's page past the SDK's 150ms fallback.
	ctx, cancel := context.WithTimeout(r.Context(), s.Timeout)
	defer cancel()

	decision := s.Engine.Decide(ctx, s.Syncer.Snapshot(), addecision.Request{
		PartnerUserID: req.PartnerUserID,
		PlacementKey:  req.PlacementID,
		Context:       req.Context,
	})

	elapsed := time.Since(started)

	// §78.1: the log line carries the DECISION and its reason, never the user.
	// There is no field here that could identify a person.
	s.Logger.Debug("ad decision",
		"placement_id", req.PlacementID,
		"decision", decision.Decision,
		"reason", string(decision.Reason),
		"activation_id", decision.ActivationID,
		"duration_ms", elapsed.Milliseconds(),
	)

	if s.Metrics != nil {
		s.Metrics.ObserveDecision(decision.Decision, string(decision.Reason), elapsed)
	}

	// §103 budget breach is worth surfacing even when the answer was correct.
	if elapsed > 100*time.Millisecond {
		s.Logger.Warn("ad decision exceeded the p95 budget",
			"duration_ms", elapsed.Milliseconds(),
			"budget_ms", 100,
			"placement_id", req.PlacementID)
	}

	writeJSON(w, http.StatusOK, decision)
}

type clickRequest struct {
	ActivationID string `json:"activation_id"`
}

// handleClick records a click against the aggregate counter (§44 step 13).
//
// Counts only. §50 forbids paying a Partner from unverified client-side
// clicks, so this figure feeds delivery reporting and §77.3 reconciliation,
// never settlement.
func (s *Server) handleClick(w http.ResponseWriter, r *http.Request) {
	var req clickRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*1024)).Decode(&req); err != nil || req.ActivationID == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	_ = s.State.RecordClick(r.Context(), req.ActivationID)
	w.WriteHeader(http.StatusNoContent)
}

// handleHealthz is §69.2 liveness: process alive, NO dependency checks.
//
// Deliberately dependency-free: a database blip must remove the Agent from a
// load balancer, not have Kubernetes restart it repeatedly.
func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "version": controlsync.Version})
}

// handleReadyz is §69.2 readiness: control config loaded AND the connector
// healthy enough to decide.
func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	configAge := s.Syncer.ConfigAge()
	configOK := configAge < s.StaleGrace

	connectorErr := s.Connector.Health(ctx)
	connectorOK := connectorErr == nil

	// An authentication failure means this Agent's identity has been revoked
	// (§69.3) or its Partner suspended. The cached config may still be inside
	// its stale grace, so the clock alone would report healthy for another
	// fifteen minutes while the Agent is in fact cut off. Surface it now.
	lastErr := s.Syncer.LastError()
	authRevoked := strings.Contains(lastErr, "401") || strings.Contains(lastErr, "403")

	ready := configOK && connectorOK && !authRevoked
	status := http.StatusOK
	if !ready {
		status = http.StatusServiceUnavailable
	}

	body := map[string]any{
		"status":             map[bool]string{true: "ready", false: "not_ready"}[ready],
		"config_age_seconds": int(configAge.Seconds()),
		"config_fresh":       configOK,
		"connector_healthy":  connectorOK,
		"identity_valid":     !authRevoked,
		"version":            controlsync.Version,
	}
	if authRevoked {
		body["remediation"] = "Agent identity rejected by Oolix. Re-provision and restart (spec §69.3)."
	}
	if connectorErr != nil {
		body["connector_error"] = connectorErr.Error()
	}
	if lastErr != "" {
		body["last_sync_error"] = lastErr
	}
	writeJSON(w, status, body)
}

func (s *Server) handleVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version":         controlsync.Version,
		"contract":        "0.2.0",
		"decision_budget": "100ms",
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	// This API is private and its responses are never cacheable: a cached ad
	// decision could be replayed for a different user.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// handleMetrics serves Prometheus text exposition for the Partner's collector.
func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	if s.Metrics == nil {
		http.Error(w, "metrics are not enabled", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = io.WriteString(w, s.Metrics.Render())
}
