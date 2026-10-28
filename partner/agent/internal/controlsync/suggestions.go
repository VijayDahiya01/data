package controlsync

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// Help with values the Agent could not read (docs/DESIGN-PARTNER-DATA.md
// §5.6). Each call carries values and codes only -- never a customer, a row
// or a count -- and each is something the Partner chose on the setup page.

// SuggestCodes asks Oolix what each value most likely means: one of the
// attribute's codes, by value. Values with no likely code are left out.
func (s *Syncer) SuggestCodes(ctx context.Context, attribute string, values []string) (map[string]string, error) {
	var out struct {
		Suggestions []struct {
			Value string  `json:"value"`
			Code  *string `json:"code"`
		} `json:"suggestions"`
	}
	body := map[string]any{"attribute_key": attribute, "values": values}
	if err := s.call(ctx, http.MethodPost, "/agent/v1/suggestions/codes", body, &out); err != nil {
		return nil, err
	}
	codes := map[string]string{}
	for _, sg := range out.Suggestions {
		if sg.Code != nil && *sg.Code != "" {
			codes[sg.Value] = *sg.Code
		}
	}
	return codes, nil
}

// SharedAnswer is one answer the Partner gave and chose to share.
type SharedAnswer struct {
	Attribute string `json:"attribute_key"`
	Value     string `json:"value"`
	Code      string `json:"code"`
}

// ShareAnswers replaces the answers this Partner shares; none withdraws them.
func (s *Syncer) ShareAnswers(ctx context.Context, answers []SharedAnswer) error {
	if answers == nil {
		answers = []SharedAnswer{}
	}
	return s.call(ctx, http.MethodPut, "/agent/v1/synonyms/contributions",
		map[string]any{"answers": answers}, nil)
}

// SharedSynonyms downloads the synonyms Oolix approved for every Agent: by
// attribute, normalised value -> code, with the list's version.
func (s *Syncer) SharedSynonyms(ctx context.Context) (string, map[string]map[string]string, error) {
	var out struct {
		Version  string `json:"version"`
		Synonyms []struct {
			Attribute string `json:"attribute_key"`
			ValueKey  string `json:"value_key"`
			Code      string `json:"code"`
		} `json:"synonyms"`
	}
	if err := s.call(ctx, http.MethodGet, "/agent/v1/synonyms", nil, &out); err != nil {
		return "", nil, err
	}
	byAttr := map[string]map[string]string{}
	for _, sy := range out.Synonyms {
		if byAttr[sy.Attribute] == nil {
			byAttr[sy.Attribute] = map[string]string{}
		}
		byAttr[sy.Attribute][sy.ValueKey] = sy.Code
	}
	return out.Version, byAttr, nil
}

// call sends one authenticated JSON request and decodes the reply into out,
// when out is not nil.
func (s *Syncer) call(ctx context.Context, method, path string, body, out any) error {
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return err
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.opts.APIBaseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Agent-Id", s.opts.AgentID)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("%s %s returned %d: %s", method, path, res.StatusCode, string(detail))
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
}
