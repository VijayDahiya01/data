package channel

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Member is one person's matching identifiers, as read from the Partner's own
// database.
//
// RAW VALUES. This struct is the only place in the Agent that holds
// unhashed customer identifiers outside the connector, and instances of it
// must never be logged, buffered to disk, or included in an error. Every
// adapter hashes on the way out; nothing hands a Member to anything else.
type Member struct {
	Email     string
	Phone     string
	FirstName string
	LastName  string
	Country   string
	Zip       string
	MobileID  string
}

// SyncRequest is one audience upload.
type SyncRequest struct {
	ActivationID string
	// AudienceName is what a human sees in the platform's UI. It names the
	// activation, never the segment's rules -- an audience called
	// "high-value lapsed customers" tells everyone with access to the ad
	// account something the Partner did not agree to publish.
	AudienceName string
	Members      []Member
	// ExistingResourceID is set on a refresh, empty on first upload.
	ExistingResourceID string
	// Consent travels with the upload because Google requires it as a field
	// (§48.7) and refuses the request without one.
	//
	// It is NOT defaulted to granted. A hardcoded "consent granted" would be
	// this system asserting a lawful basis it never checked -- the assertion
	// has to originate from the Partner's own consent state, which the
	// eligibility gate establishes at audience level before any upload is
	// authorised at all (§47.5, §48.4).
	Consent ConsentState
}

// ConsentState mirrors the platform vocabulary rather than inventing one, so
// nothing has to be translated at the boundary where it matters most.
type ConsentState string

const (
	// ConsentUnspecified is the zero value on purpose: a caller that forgets
	// to set consent gets a refusal, not an assumption.
	ConsentUnspecified ConsentState = ""
	ConsentGranted     ConsentState = "CONSENT_GRANTED"
	ConsentDenied      ConsentState = "CONSENT_DENIED"
)

// SyncResult reports what happened, in terms Oolix can store centrally.
//
// Deliberately only counts and a resource id: §47.11 is explicit that "raw
// matching payload is not stored in Oolix DB", and anything richer than this
// starts to describe the audience itself.
type SyncResult struct {
	ResourceID string
	// Accepted is how many members produced at least one usable identifier.
	Accepted int
	// Skipped is how many were dropped for having none. A high number here is
	// the signal that a Partner's attribute mapping is wrong -- it is the
	// difference between "the campaign under-delivered" and knowing why.
	Skipped int
}

// Adapter is one external platform.
type Adapter interface {
	Provider() Provider
	// Sync creates or refreshes the audience and returns its resource id.
	Sync(ctx context.Context, req SyncRequest) (SyncResult, error)
	// Remove withdraws the audience at expiry or revocation (§47.14, §48.12).
	Remove(ctx context.Context, resourceID string) error
}

// ErrNotConfigured is returned when an adapter is asked to work without the
// credentials or account context it needs.
//
// A distinct error because the response to it is different: this is an
// operator fixing configuration, not a retry.
var ErrNotConfigured = errors.New("channel adapter is not configured")

// RetryableError marks a failure worth trying again.
//
// Platform APIs rate-limit and have transient 5xx. Treating those the same as
// "this audience is invalid" would either give up on a recoverable upload or
// hammer a permanently broken one.
type RetryableError struct {
	Err        error
	RetryAfter time.Duration
}

func (e *RetryableError) Error() string { return e.Err.Error() }
func (e *RetryableError) Unwrap() error { return e.Err }

func retryable(err error, after time.Duration) error {
	return &RetryableError{Err: err, RetryAfter: after}
}

// IsRetryable reports whether a failure is worth another attempt.
func IsRetryable(err error) bool {
	var r *RetryableError
	return errors.As(err, &r)
}

// batch splits members into chunks of at most n.
//
// Both platforms cap how many members one request may carry, and exceeding it
// fails the whole request rather than truncating -- so a large audience that
// was not batched uploads nothing at all.
func batch[T any](items []T, n int) [][]T {
	if n <= 0 || len(items) == 0 {
		return nil
	}
	out := make([][]T, 0, (len(items)+n-1)/n)
	for i := 0; i < len(items); i += n {
		end := i + n
		if end > len(items) {
			end = len(items)
		}
		out = append(out, items[i:end])
	}
	return out
}

// redactedCount describes an upload without describing its contents.
//
// Used in logs. "uploaded 4,812 members" is operationally useful and reveals
// nothing about who they are; anything more specific starts to.
func redactedCount(n int) string {
	return fmt.Sprintf("%d members", n)
}
