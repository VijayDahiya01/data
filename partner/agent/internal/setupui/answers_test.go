package setupui

import (
	"testing"

	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/standard"
)

// Unknown values come with their likely meaning chosen and the reason shown;
// the Partner's own answers are never second-guessed.
func TestAnswersCarrySuggestions(t *testing.T) {
	city, _ := standard.ByKey("city")
	ms := managed.Measurement{Unrecognised: []detect.ValueCount{
		{Value: "Gurgoan", Count: 7}, {Value: "South Delhi", Count: 3}, {Value: "Zzyzx", Count: 1},
	}}
	// Oolix was asked earlier: its answer fills only what the Agent could not,
	// and never with a code the attribute lacks.
	asked := map[string]string{"Zzyzx": "PUNE", "Gurgoan": "NOIDA", "Qqq": "ATLANTIS"}
	ms.Unrecognised = append(ms.Unrecognised, detect.ValueCount{Value: "Qqq", Count: 1})
	got := answersFor(city, map[string]string{"Bombay Central": "MUMBAI", "Navi Mumbai": ""}, ms, asked)
	want := []answer{
		{Raw: "Bombay Central", Code: "MUMBAI"},
		{Raw: "Navi Mumbai", Code: "-"},
		{Raw: "Gurgoan", Count: 7, Code: "GURUGRAM", Why: "a close spelling"},
		{Raw: "South Delhi", Count: 3, Code: "DELHI", Why: "a part of Delhi"},
		{Raw: "Zzyzx", Count: 1, Code: "PUNE", Why: "by Oolix's AI helper"},
		{Raw: "Qqq", Count: 1},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("answer %d = %+v, want %+v", i, got[i], want[i])
		}
	}

	// Age groups in words are answered with a group, not a code: no
	// suggestions there.
	age, _ := standard.ByKey("age")
	for _, a := range answersFor(age, nil, managed.Measurement{Unrecognised: []detect.ValueCount{{Value: "senior"}}}, nil) {
		if a.Why != "" || a.Code != "" {
			t.Errorf("age: %+v", a)
		}
	}
}
