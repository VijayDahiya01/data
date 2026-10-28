package setupui

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/oolix/partner-agent/internal/controlsync"
	"github.com/oolix/partner-agent/internal/managed"
)

// Help with values the Agent could not read (docs/DESIGN-PARTNER-DATA.md
// §5.6): asking Oolix for suggested meanings, and sharing the Partner's
// answers so every Partner's Agent can learn them. Both are the Partner's
// choice, made on these pages, and both carry values and codes only.

// Helper is Oolix, once the Agent is registered and can reach it.
type Helper interface {
	SuggestCodes(ctx context.Context, attribute string, values []string) (map[string]string, error)
	ShareAnswers(ctx context.Context, answers []controlsync.SharedAnswer) error
}

type helperBox struct{ h Helper }

// SetHelper is called once the Agent can reach Oolix.
func (s *Server) SetHelper(h Helper) { s.helper.Store(&helperBox{h}) }

func (s *Server) help() Helper {
	if b := s.helper.Load(); b != nil {
		return b.h
	}
	return nil
}

// helpState is what the pages may offer.
type helpState struct {
	// CanAsk is true when this Oolix offers suggestions and the Agent can
	// reach it.
	CanAsk bool
	// Sharing is the Partner's choice to share their answers.
	Sharing bool
	// Asked are Oolix's suggestions from earlier asks, by attribute and value.
	Asked map[string]map[string]string
}

func (s *Server) helpState(ctx context.Context) helpState {
	on, _ := s.settings.SuggestionsAvailable(ctx)
	sharing, _ := s.settings.Sharing(ctx)
	asked, _ := s.settings.SuggestedCodes(ctx)
	return helpState{CanAsk: on && s.help() != nil, Sharing: sharing, Asked: asked}
}

const maxAsk = 50

// askable are the open values worth asking Oolix about: no answer and no
// suggestion of the Agent's own, and short phrases rather than anything that
// could be a person or a number.
func askable(answers []answer) []string {
	var out []string
	for _, a := range answers {
		if a.Count > 0 && a.Code == "" && shareable(a.Raw) && len(out) < maxAsk {
			out = append(out, a.Raw)
		}
	}
	return out
}

// shareable is the rule Oolix applies too: at most 80 characters and eight
// words, a letter in it, no "@" and fewer than five digits -- so a column
// holding addresses, phone numbers or IDs by mistake gives nothing away.
func shareable(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" || len([]rune(v)) > 80 || strings.Contains(v, "@") || len(strings.Fields(v)) > 8 {
		return false
	}
	digits, letter := 0, false
	for _, r := range v {
		switch {
		case unicode.IsDigit(r):
			digits++
		case unicode.IsLetter(r):
			letter = true
		}
	}
	return digits < 5 && letter
}

var errNothingToAsk = errors.New("nothing to ask about")

// ask asks Oolix about one attribute's open values and keeps the answers,
// which the page then shows chosen for the Partner to check.
func (s *Server) ask(ctx context.Context, key string, answers []answer) error {
	h := s.help()
	if h == nil {
		return errors.New("the Agent cannot reach Oolix yet")
	}
	values := askable(answers)
	if len(values) == 0 {
		return errNothingToAsk
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	codes, err := h.SuggestCodes(ctx, key, values)
	if err != nil {
		return err
	}
	return s.settings.SaveSuggestedCodes(ctx, key, codes)
}

// askNotice turns the outcome of an ask into the page's notice.
func (s *Server) askNotice(key string, err error) string {
	switch {
	case err == nil:
		return "asked"
	case errors.Is(err, errNothingToAsk):
		return "nothingtoask"
	}
	s.opts.Logger.Warn("asking Oolix for suggested meanings failed", "attribute", key, "error", err.Error())
	return "notasked"
}

// syncSharing sends the Partner's answers when they share them, and
// withdraws them when they stop. In the background: saving a page never
// waits on Oolix, and a failure is tried again at the next save.
func (s *Server) syncSharing(m managed.Mapping, was, now bool) {
	h := s.help()
	if h == nil || (!was && !now) {
		return
	}
	var answers []controlsync.SharedAnswer
	if now {
		for attr, values := range managed.Answers(m) {
			for raw, code := range values {
				if shareable(raw) {
					answers = append(answers, controlsync.SharedAnswer{Attribute: attr, Value: raw, Code: code})
				}
			}
		}
		sort.Slice(answers, func(i, j int) bool {
			if answers[i].Attribute != answers[j].Attribute {
				return answers[i].Attribute < answers[j].Attribute
			}
			return answers[i].Value < answers[j].Value
		})
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := h.ShareAnswers(ctx, answers); err != nil {
			s.opts.Logger.Warn("sharing answers with Oolix failed", "error", err.Error())
		}
	}()
}
