package main

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/oolix/partner-agent/internal/httpapi"
	"github.com/oolix/partner-agent/internal/localstore"
	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/source"
)

// pushAPI serves the private API's push routes from managed mode's local
// copy: what the Partner's own system tells its Agent between refreshes.
type pushAPI struct {
	store  *localstore.Store
	runner *managed.Runner
}

func (p pushAPI) Authorized(ctx context.Context, token string) bool {
	return managed.PushAuthorized(ctx, p.store, token)
}

func (p pushAPI) WithdrawConsent(ctx context.Context, partnerUserID string) error {
	return pushError(managed.WithdrawConsent(ctx, p.store, partnerUserID, time.Now()))
}

func (p pushAPI) RestoreConsent(ctx context.Context, partnerUserID string) error {
	return pushError(managed.RestoreConsent(ctx, p.store, partnerUserID))
}

func (p pushAPI) Customers(ctx context.Context, rows []map[string]any) (httpapi.PushResult, error) {
	in := make([]source.Row, len(rows))
	for i, r := range rows {
		in[i] = source.Row(r)
	}
	rep, err := p.runner.ApplyPushed(ctx, in)
	if err != nil {
		return httpapi.PushResult{}, pushError(err)
	}
	return httpapi.PushResult{Received: len(rows), Applied: rep.Changed - rep.NotConsented,
		Removed: rep.NotConsented, WithoutID: rep.WithoutID}, nil
}

// pushError gives a refused push the status the caller should see.
func pushError(err error) error {
	var rowsErr *managed.PushRowsError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &rowsErr):
		return &httpapi.PushError{Status: http.StatusBadRequest, Message: rowsErr.Problem}
	case errors.Is(err, managed.ErrBusy):
		return &httpapi.PushError{Status: http.StatusServiceUnavailable, Message: err.Error()}
	case errors.Is(err, managed.ErrNotPublished):
		return &httpapi.PushError{Status: http.StatusConflict, Message: err.Error()}
	}
	return err
}
