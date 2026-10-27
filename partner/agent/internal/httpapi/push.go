package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// Pusher applies what the Partner's own system tells its Agent directly,
// between nightly refreshes: consent withdrawn or given again, and customers
// who changed. Nil outside managed mode, where the Partner's own tables are
// the Agent's source and are changed there.
type Pusher interface {
	// Authorized checks the token sent with a push.
	Authorized(ctx context.Context, token string) bool
	WithdrawConsent(ctx context.Context, partnerUserID string) error
	RestoreConsent(ctx context.Context, partnerUserID string) error
	Customers(ctx context.Context, rows []map[string]any) (PushResult, error)
}

// PushResult is what a push of customers did. Counts only.
type PushResult struct {
	Received  int `json:"received"`
	Applied   int `json:"applied"`
	Removed   int `json:"removed"`
	WithoutID int `json:"without_id"`
}

// PushError is a push the Agent refused, with the status to answer it with.
type PushError struct {
	Status  int
	Message string
}

func (e *PushError) Error() string { return e.Message }

// maxPushBody bounds a push of customers: a thousand rows of a few dozen
// columns.
const maxPushBody = 8 << 20

func (s *Server) pushRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /private/v1/consent/withdraw", s.push(s.handleWithdraw))
	mux.HandleFunc("POST /private/v1/consent/restore", s.push(s.handleRestore))
	mux.HandleFunc("POST /private/v1/customers", s.push(s.handleCustomers))
}

// push guards a push route: managed mode only, and the token the setup page
// shows. The ad-decision route is open to the Partner's network; these change
// the copy, so they ask for more.
func (s *Server) push(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Pusher == nil {
			http.NotFound(w, r)
			return
		}
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || !s.Pusher.Authorized(r.Context(), strings.TrimSpace(token)) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{
				"error": "send the push token from the Agent's setup page as: Authorization: Bearer <token>",
			})
			return
		}
		next(w, r)
	}
}

type consentRequest struct {
	PartnerUserID string `json:"partner_user_id"`
}

func (s *Server) handleWithdraw(w http.ResponseWriter, r *http.Request) {
	var req consentRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&req); err != nil {
		pushFailed(w, &PushError{http.StatusBadRequest, "the body must be JSON: {\"partner_user_id\": \"...\"}"})
		return
	}
	if err := s.Pusher.WithdrawConsent(r.Context(), req.PartnerUserID); err != nil {
		pushFailed(w, err)
		return
	}
	// No identifier in the log, as for ad decisions.
	s.Logger.Info("consent withdrawn through the push API")
	writeJSON(w, http.StatusOK, map[string]bool{"withdrawn": true})
}

func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request) {
	var req consentRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&req); err != nil {
		pushFailed(w, &PushError{http.StatusBadRequest, "the body must be JSON: {\"partner_user_id\": \"...\"}"})
		return
	}
	if err := s.Pusher.RestoreConsent(r.Context(), req.PartnerUserID); err != nil {
		pushFailed(w, err)
		return
	}
	s.Logger.Info("consent restored through the push API")
	writeJSON(w, http.StatusOK, map[string]bool{"restored": true})
}

func (s *Server) handleCustomers(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Rows []map[string]any `json:"rows"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPushBody))
	dec.UseNumber()
	if err := dec.Decode(&req); err != nil {
		pushFailed(w, &PushError{http.StatusBadRequest, "the body must be JSON: {\"rows\": [{...}, ...]}"})
		return
	}
	for _, row := range req.Rows {
		for k, v := range row {
			// Numbers arrive as text and are read as the table's would be.
			if n, ok := v.(json.Number); ok {
				row[k] = n.String()
			}
		}
	}
	res, err := s.Pusher.Customers(r.Context(), req.Rows)
	if err != nil {
		pushFailed(w, err)
		return
	}
	s.Logger.Info("customers pushed", "received", res.Received, "applied", res.Applied, "removed", res.Removed)
	writeJSON(w, http.StatusOK, res)
}

func pushFailed(w http.ResponseWriter, err error) {
	var pe *PushError
	if errors.As(err, &pe) {
		if pe.Status == http.StatusServiceUnavailable {
			w.Header().Set("Retry-After", "300")
		}
		writeJSON(w, pe.Status, map[string]string{"error": pe.Message})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "the push could not be applied"})
}
