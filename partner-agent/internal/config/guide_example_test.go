package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// The configuration a Partner is TOLD to write must be one the Agent accepts.
//
// This existed as a real defect, not a hypothetical one. The guide documented
// `mappings:` while the parser read `mapping:`, and the two never met: the key
// was skipped, audience evaluation switched itself off, and the Agent logged a
// single INFO line and reported healthy. A Partner following the guide exactly
// would have been live, matching nobody, with nothing to show them why.
//
// The same block also documented `column:` and `derive:`, which the config
// struct could not represent at all -- so the indexable query path was
// unreachable from configuration while its own unit tests passed.
//
// Parsing the guide's own YAML is the only version of this test that cannot
// drift away from what a Partner reads.
func TestTheGuideExampleParses(t *testing.T) {
	guide := filepath.Join("..", "..", "..", "implementation_examples", "INTEGRATION-GUIDE.md")
	raw, err := os.ReadFile(guide)
	if err != nil {
		t.Skipf("integration guide not present: %v", err)
	}

	block := yamlBlockContaining(string(raw), "attribute_table")
	if block == "" {
		t.Fatal("the guide no longer contains a connector mapping example")
	}

	var doc struct {
		Connector ConnectorConfig `yaml:"connector"`
	}
	dec := yaml.NewDecoder(bytes.NewReader([]byte(block)))
	dec.KnownFields(true) // exactly how Load reads a real config
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("the guide documents a config the agent rejects: %v\n\n%s", err, block)
	}

	got := doc.Connector.Audience.Mapping
	if len(got) == 0 {
		t.Fatal("the guide's mapping parsed to nothing: audience evaluation would be silently off")
	}

	// The derived attributes must arrive complete, or they quietly fall back to
	// the full-table form the `column:`/`derive:` keys exist to avoid.
	age, ok := got["age"]
	if !ok {
		t.Fatal("the guide no longer documents a derived `age` mapping")
	}
	if age.Column == "" || age.Derive == "" {
		t.Errorf("derived mapping lost its column/derive: %+v", age)
	}
}

// yamlBlockContaining returns the fenced yaml block holding needle.
func yamlBlockContaining(md, needle string) string {
	for rest := md; ; {
		open := strings.Index(rest, "```yaml")
		if open < 0 {
			return ""
		}
		rest = rest[open+len("```yaml"):]
		end := strings.Index(rest, "```")
		if end < 0 {
			return ""
		}
		if block := rest[:end]; strings.Contains(block, needle) {
			return block
		}
		rest = rest[end+3:]
	}
}
