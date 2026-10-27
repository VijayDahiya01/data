package source

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// --- JSON Lines -----------------------------------------------------------------
//
// One JSON object per line (.jsonl, .ndjson): what many systems export and most
// logging pipelines write. Nested objects are read as dotted paths, as MongoDB
// documents are, and a list as its primary element.

func eachJSONLines(ctx context.Context, path string, fn func([]string, []string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	line := 0
	for sc.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line++
		text := strings.TrimSpace(sc.Text())
		if text == "" {
			continue
		}
		var obj map[string]any
		dec := json.NewDecoder(strings.NewReader(text))
		dec.UseNumber()
		if err := dec.Decode(&obj); err != nil {
			return fmt.Errorf("%s line %d is not a JSON object: %w", filepath.Base(path), line, err)
		}
		flat := map[string]string{}
		flattenJSON("", obj, flat)
		header := make([]string, 0, len(flat))
		for k := range flat {
			header = append(header, k)
		}
		sort.Strings(header)
		rec := make([]string, len(header))
		for i, k := range header {
			rec[i] = flat[k]
		}
		if err := fn(header, rec); err != nil {
			return err
		}
	}
	return sc.Err()
}

func flattenJSON(prefix string, obj map[string]any, out map[string]string) {
	for k, v := range obj {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		switch x := v.(type) {
		case map[string]any:
			flattenJSON(key, x, out)
		case []any:
			// As for MongoDB lists: the primary object, else the first value.
			var chosen map[string]any
			for _, item := range x {
				if m, ok := item.(map[string]any); ok {
					if chosen == nil {
						chosen = m
					}
					for _, mark := range primaryMarks {
						if b, ok := m[mark].(bool); ok && b {
							chosen = m
						}
					}
				}
			}
			if chosen != nil {
				flattenJSON(key, chosen, out)
				continue
			}
			for _, item := range x {
				if s := jsonText(item); s != "" {
					out[key] = s
					break
				}
			}
		default:
			if s := jsonText(x); s != "" {
				out[key] = s
			}
		}
	}
}

func jsonText(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case json.Number:
		return x.String()
	case bool:
		return strconv.FormatBool(x)
	case map[string]any, []any:
		return ""
	}
	return fmt.Sprint(v)
}

// --- dated exports --------------------------------------------------------------
//
// A Partner who exports every day leaves a folder of customers_2026-10-26.csv,
// customers_2026-10-27.csv... Those are one table, "customers_*.csv", and the
// Agent reads the newest export each night.

var dateInName = regexp.MustCompile(`(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})|(\d{2})[-_.](\d{2})[-_.](\d{4})`)

// seriesOf is the series a file name belongs to, and the date it carries as
// YYYYMMDD; ok is false for a name without a date.
func seriesOf(name string) (series, date string, ok bool) {
	loc := dateInName.FindStringSubmatchIndex(name)
	if loc == nil {
		return "", "", false
	}
	m := dateInName.FindStringSubmatch(name)
	if m[1] != "" {
		date = m[1] + m[2] + m[3]
	} else {
		date = m[6] + m[5] + m[4]
	}
	return name[:loc[0]] + "*" + name[loc[1]:], date, true
}

// groupSeries lists dated exports as one table per series, when a series has
// two or more files; a lone dated file stays itself.
func groupSeries(names []string) (tables []string, members map[string][]string) {
	members = map[string][]string{}
	for _, n := range names {
		if series, _, ok := seriesOf(n); ok {
			members[series] = append(members[series], n)
		}
	}
	inSeries := map[string]bool{}
	for series, files := range members {
		if len(files) < 2 {
			delete(members, series)
			continue
		}
		tables = append(tables, series)
		for _, f := range files {
			inSeries[f] = true
		}
	}
	for _, n := range names {
		if !inSeries[n] {
			tables = append(tables, n)
		}
	}
	return tables, members
}

// newest is the file of a series with the latest date in its name.
func newest(files []string) string {
	best, bestDate := "", ""
	for _, f := range files {
		if _, date, ok := seriesOf(f); ok && date > bestDate {
			best, bestDate = f, date
		}
	}
	return best
}
