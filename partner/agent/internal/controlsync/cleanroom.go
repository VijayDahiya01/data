package controlsync

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/oolix/partner-agent/internal/managed"
)

// Cross-Partner matching (docs/DESIGN-PARTNER-DATA.md phase 7). Oolix carries
// what goes between the Agent and the clean room; everything it carries is
// sealed to one or the other.

// CleanRoomTasks are runs waiting for this Partner's customers.
func (s *Syncer) CleanRoomTasks(ctx context.Context) ([]managed.CleanRoomTask, error) {
	var out struct {
		Tasks []managed.CleanRoomTask `json:"tasks"`
	}
	err := s.call(ctx, http.MethodGet, "/agent/v1/cleanroom/tasks", nil, &out)
	return out.Tasks, err
}

// cleanRoomPart is how much sealed input goes in one request: the API takes
// bodies of 1 MB, and this is 512 KiB before base64.
const cleanRoomPart = 512 << 10

// SubmitCleanRoomInput hands over this Partner's customers, sealed to the
// clean room, in parts; with the last, for a joint audience, the key to seal
// the result to.
func (s *Syncer) SubmitCleanRoomInput(ctx context.Context, runID string, sealed, recipient []byte) error {
	parts := (len(sealed) + cleanRoomPart - 1) / cleanRoomPart
	if parts > 256 {
		return fmt.Errorf("the sealed customers are %d MB, more than the clean room takes", len(sealed)>>20)
	}
	for i := 0; i < parts; i++ {
		chunk := sealed[i*cleanRoomPart : min(len(sealed), (i+1)*cleanRoomPart)]
		body := map[string]any{"parts": parts, "data": chunk}
		if i == parts-1 && recipient != nil {
			body["recipient"] = recipient
		}
		path := "/agent/v1/cleanroom/tasks/" + url.PathEscape(runID) + "/parts/" + strconv.Itoa(i)
		if err := s.call(ctx, http.MethodPut, path, body, nil); err != nil {
			return err
		}
	}
	return nil
}

// CleanRoomResults are joint audiences sealed to this Agent.
func (s *Syncer) CleanRoomResults(ctx context.Context) ([]managed.CleanRoomResult, error) {
	var out struct {
		Results []managed.CleanRoomResult `json:"results"`
	}
	err := s.call(ctx, http.MethodGet, "/agent/v1/cleanroom/results", nil, &out)
	return out.Results, err
}

// AckCleanRoomResult says a joint audience was received, so Oolix can drop
// the sealed copy it carried.
func (s *Syncer) AckCleanRoomResult(ctx context.Context, runID string) error {
	return s.call(ctx, http.MethodPost, "/agent/v1/cleanroom/results/"+url.PathEscape(runID)+"/ack", nil, nil)
}
