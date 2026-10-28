package managed

import (
	"testing"
	"time"

	"github.com/oolix/partner-agent/internal/standard"
)

// The setup page counts places outside Oolix's list apart: left empty, not
// against the column, and not asked about.
func TestMeasureCountsPlacesOutsideTheList(t *testing.T) {
	city, _ := standard.ByKey("city")
	sample := map[string][]any{
		"pin": {"400001", "400001", "226001", "226001", "226001", "Lucknow", "999999", ""},
	}
	ms, err := Measure(city, AttributeMapping{Column: "pin"}, "", sample, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if ms.Sampled != 3 || ms.Readable != 2 || ms.Outside != 4 {
		t.Errorf("sampled %d, readable %d, outside %d", ms.Sampled, ms.Readable, ms.Outside)
	}
	if len(ms.OutsideExamples) == 0 || ms.OutsideExamples[0].Value != "226001" {
		t.Errorf("outside examples: %+v", ms.OutsideExamples)
	}
	if len(ms.Unrecognised) != 1 || ms.Unrecognised[0].Value != "999999" {
		t.Errorf("unrecognised: %+v", ms.Unrecognised)
	}
	if len(ms.Examples) == 0 || ms.Examples[0].Clean != "MUMBAI" {
		t.Errorf("examples: %+v", ms.Examples)
	}
}
