package setupui

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/clean"
	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/managed"
	"github.com/oolix/partner-agent/internal/source"
	"github.com/oolix/partner-agent/internal/standard"
)

// --- more tables (joins) -------------------------------------------------------
//
// When the customer table does not hold everything -- dates of birth in a
// profiles table, cities in an addresses table, fields in a key-value table
// such as wp_usermeta -- the Partner adds those tables here. The Agent joins
// them in its own read-only query; nothing is created in their database.

// joinedPreview is a sample of the customer table with its joins.
func (s *Server) joinedPreview(ctx context.Context, st state) (*preview, error) {
	m := st.draft
	key := m.Table
	if b, err := json.Marshal(m.Joins); err == nil {
		key += "|" + m.IDColumn + "|" + string(b)
	}
	s.mu.Lock()
	p := s.previews[key]
	s.mu.Unlock()
	if p != nil && s.opts.Now().Sub(p.takenAt) < previewMaxAge {
		return p, nil
	}
	base, err := s.previewOf(ctx, st, m.Table)
	if err != nil {
		return nil, err
	}
	if m.IDColumn == "" {
		return nil, errors.New("choose the customer ID column first")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	src, err := s.opts.OpenSource(ctx, *st.source)
	if err != nil {
		return nil, err
	}
	defer src.Close()
	sample, err := source.SampleJoined(ctx, src, m.Table, m.IDColumn, m.Joins, sampleRows)
	if err != nil {
		return nil, err
	}
	cols := slices.Clone(base.columns)
	var joined []string
	for name := range sample {
		if _, _, ok := source.JoinedColumn(name, m.Joins); ok {
			joined = append(joined, name)
		}
	}
	sort.Strings(joined)
	for _, name := range joined {
		cols = append(cols, detect.Column{Name: name})
	}
	p = &preview{table: m.Table, columns: cols, sample: sample, takenAt: s.opts.Now()}
	s.mu.Lock()
	s.previews[key] = p
	s.mu.Unlock()
	return p, nil
}

type joinRow struct {
	Table, Key, Kind string
}

type nameOption struct {
	Name  string
	Count int
}

type joinsData struct {
	Table, IDColumn string
	Joins           []joinRow
	// Tables can still be added.
	Tables []string
	// Adding is the table being added, once chosen, with its columns.
	Adding      string
	Columns     []string
	Key         string
	NameColumn  string
	ValueColumn string
	// Names are the field names a key-value table holds, most common first.
	Names []nameOption
}

func describeJoin(j source.Join) string {
	switch {
	case j.KeyValue():
		return "one row per field: " + strings.Join(j.Fields, ", ")
	case j.Latest != "":
		return "several rows per customer; the latest by " + j.Latest
	}
	return "one row per customer"
}

func (s *Server) joinsPage(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	if st.draft == nil || st.draft.Table == "" {
		redirect(w, r, "/table")
		return
	}
	if st.draft.IDColumn == "" {
		redirect(w, r, "/review?problem=id")
		return
	}
	v := s.view(r, sess, st, "More tables", "/review")
	d := joinsData{Table: st.draft.Table, IDColumn: st.draft.IDColumn}
	joined := map[string]bool{st.draft.Table: true}
	for _, j := range st.draft.Joins {
		joined[j.Table] = true
		d.Joins = append(d.Joins, joinRow{Table: j.Table, Key: j.Key, Kind: describeJoin(j)})
	}
	tables, err := s.tables(ctx, *st.source)
	if err != nil {
		v.Error = "Could not list the tables: " + err.Error()
	}
	for _, t := range tables {
		if !joined[t.Name] {
			d.Tables = append(d.Tables, t.Name)
		}
	}
	if adding := r.URL.Query().Get("table"); slices.Contains(d.Tables, adding) {
		p, err := s.previewOf(ctx, st, adding)
		if err != nil {
			v.Error = "Could not read a sample of " + adding + ": " + err.Error()
		} else {
			d.Adding = adding
			for _, c := range p.columns {
				d.Columns = append(d.Columns, c.Name)
			}
			d.Key = joinKey(d.Columns, st.draft.IDColumn)
			d.NameColumn, d.ValueColumn = keyValueColumns(d.Columns)
			if d.NameColumn != "" {
				counts := map[string]int{}
				for _, v := range p.sample[d.NameColumn] {
					if t := strings.TrimSpace(clean.Text(v)); t != "" {
						counts[t]++
					}
				}
				for name, n := range counts {
					d.Names = append(d.Names, nameOption{name, n})
				}
				sort.Slice(d.Names, func(i, j int) bool {
					if d.Names[i].Count != d.Names[j].Count {
						return d.Names[i].Count > d.Names[j].Count
					}
					return d.Names[i].Name < d.Names[j].Name
				})
				if len(d.Names) > 60 {
					d.Names = d.Names[:60]
				}
			}
		}
	}
	v.Data = d
	s.render(w, "joins.html", v)
}

// joinKey suggests the column of another table holding the customer ID: the
// customer table's own ID column name, or one named like a customer ID.
func joinKey(columns []string, idColumn string) string {
	for _, c := range columns {
		if c == idColumn {
			return c
		}
	}
	for _, hint := range standard.IDHints {
		if hint == "id" || hint == "_id" {
			continue
		}
		for _, c := range columns {
			if detect.Words(c) == hint {
				return c
			}
		}
	}
	return ""
}

// keyValueColumns spots a key-value table's name and value columns:
// meta_key/meta_value, attribute/value, field_name/field_value...
func keyValueColumns(columns []string) (name, value string) {
	for _, c := range columns {
		w := detect.Words(c)
		switch {
		case name == "" && (strings.HasSuffix(w, "_key") || w == "key" || w == "attribute" || w == "field" ||
			strings.HasSuffix(w, "_name") && strings.Contains(w, "field") || w == "property"):
			name = c
		case value == "" && (strings.HasSuffix(w, "_value") || w == "value" || w == "val"):
			value = c
		}
	}
	if name == "" || value == "" {
		return "", ""
	}
	return name, value
}

func (s *Server) saveJoins(w http.ResponseWriter, r *http.Request, sess *session) {
	ctx := r.Context()
	st, err := s.state(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	if st.draft == nil || st.draft.Table == "" {
		redirect(w, r, "/table")
		return
	}
	f := r.PostFormValue
	m := *st.draft
	switch f("action") {
	case "choose":
		redirect(w, r, "/joins?table="+url.QueryEscape(f("table")))
		return
	case "remove":
		m.Joins = slices.DeleteFunc(slices.Clone(m.Joins), func(j source.Join) bool { return j.Table == f("table") })
		// Matches to its columns go with it.
		for key, am := range m.Attributes {
			if _, _, ok := source.JoinedColumn(am.Column, []source.Join{{Table: f("table")}}); ok {
				delete(m.Attributes, key)
			}
		}
	case "add":
		table := f("table")
		p, err := s.previewOf(ctx, st, table)
		if err != nil || table == m.Table {
			redirect(w, r, "/joins")
			return
		}
		cols := map[string]bool{}
		for _, c := range p.columns {
			cols[c.Name] = true
		}
		j := source.Join{Table: table, Key: f("key")}
		switch f("kind") {
		case "latest":
			j.Latest = f("latest")
		case "kv":
			j.NameColumn, j.ValueColumn = f("name_column"), f("value_column")
			j.Fields = r.PostForm["fields"]
		}
		if !cols[j.Key] || (j.Latest != "" && !cols[j.Latest]) ||
			(f("kind") == "kv" && (!cols[j.NameColumn] || !cols[j.ValueColumn] || len(j.Fields) == 0)) {
			redirect(w, r, "/joins?table="+url.QueryEscape(table)+"&problem=incomplete")
			return
		}
		m.Joins = append(m.Joins, j)
	default:
		redirect(w, r, "/joins")
		return
	}
	if err := s.settings.SaveDraft(ctx, m); err != nil {
		s.fail(w, err)
		return
	}
	s.clearPreview()
	if f("action") == "add" {
		// Suggest matches among the new columns for what is not matched yet.
		st.draft = &m
		if p, err := s.joinedPreview(ctx, st); err == nil {
			s.suggestJoined(ctx, p, &m)
		}
	}
	redirect(w, r, "/review?notice=joined")
}

// suggestJoined matches attributes not matched yet to joined columns.
func (s *Server) suggestJoined(ctx context.Context, p *preview, m *managed.Mapping) {
	var joined []detect.Column
	for _, c := range p.columns {
		if _, _, ok := source.JoinedColumn(c.Name, m.Joins); ok {
			joined = append(joined, c)
		}
	}
	changed := false
	for _, sg := range detect.Suggest(joined, p.sample, s.opts.Now()) {
		if sg.Column == "" || m.Attributes[sg.Attribute].Column != "" {
			continue
		}
		am := managed.AttributeMapping{Column: sg.Column, Order: sg.Order, Publish: true, Form: sg.Form, Days: sg.Days}
		if sg.Form.NeedsAsOf() {
			am.AsOf = managed.AsOfAsk
		}
		if m.Attributes == nil {
			m.Attributes = map[string]managed.AttributeMapping{}
		}
		m.Attributes[sg.Attribute] = am
		changed = true
	}
	if changed {
		_ = s.settings.SaveDraft(ctx, *m)
	}
}
