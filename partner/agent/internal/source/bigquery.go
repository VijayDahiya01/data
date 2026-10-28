package source

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/detect"
	"github.com/oolix/partner-agent/internal/netx"
)

// BigQuery reads the tables of one dataset with a service account that has
// the BigQuery Data Viewer role. A table is read through tabledata.list --
// BigQuery's own paged reader, which runs no query and costs nothing -- with
// only the chosen columns; a view, which holds no data of its own, through a
// query. Nested records become dotted columns, as MongoDB documents do.
const BigQuery Kind = "bigquery"

const bigqueryReadOnly = "https://www.googleapis.com/auth/bigquery.readonly"

type bigquerySource struct {
	project, dataset string
	api              string
	auth             *googleAuth
	http             *http.Client
	pageSize         int
}

type bqField struct {
	Name   string    `json:"name"`
	Type   string    `json:"type"`
	Mode   string    `json:"mode"`
	Fields []bqField `json:"fields"`
}

func openBigQuery(ctx context.Context, cfg Config) (Source, error) {
	if cfg.Database == "" || cfg.Path == "" {
		return nil, errors.New("BigQuery needs the project ID and the dataset")
	}
	sa, err := parseServiceAccount(cfg.Password)
	if err != nil {
		return nil, err
	}
	api := "https://bigquery.googleapis.com"
	if cfg.Host != "" {
		api = strings.TrimRight(cfg.Host, "/")
	}
	client := netx.Client(5 * time.Minute)
	s := &bigquerySource{project: cfg.Database, dataset: cfg.Path, api: api,
		auth: newGoogleAuth(sa, bigqueryReadOnly, client), http: client, pageSize: pageSize}
	return s, s.Test(ctx)
}

func (s *bigquerySource) base() string {
	return s.api + "/bigquery/v2/projects/" + url.PathEscape(s.project) + "/datasets/" + url.PathEscape(s.dataset)
}

func (s *bigquerySource) call(ctx context.Context, method, u string, body any, out any) error {
	token, err := s.auth.token(ctx)
	if err != nil {
		return err
	}
	var reader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("BigQuery answered %d: %s", res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (s *bigquerySource) Test(ctx context.Context) error {
	var ds map[string]any
	if err := s.call(ctx, http.MethodGet, s.base(), nil, &ds); err != nil {
		return fmt.Errorf("could not open the dataset: %w", err)
	}
	return nil
}

func (s *bigquerySource) Tables(ctx context.Context) ([]Table, error) {
	var out []Table
	page := ""
	for {
		var res struct {
			Tables []struct {
				TableReference struct {
					TableID string `json:"tableId"`
				} `json:"tableReference"`
			} `json:"tables"`
			NextPageToken string `json:"nextPageToken"`
		}
		u := s.base() + "/tables?maxResults=1000"
		if page != "" {
			u += "&pageToken=" + url.QueryEscape(page)
		}
		if err := s.call(ctx, http.MethodGet, u, nil, &res); err != nil {
			return nil, err
		}
		for _, t := range res.Tables {
			out = append(out, Table{Name: t.TableReference.TableID, Rows: -1})
		}
		if res.NextPageToken == "" {
			sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
			return out, nil
		}
		page = res.NextPageToken
	}
}

type bqTable struct {
	Type   string `json:"type"`
	Schema struct {
		Fields []bqField `json:"fields"`
	} `json:"schema"`
}

func (s *bigquerySource) table(ctx context.Context, name string) (bqTable, error) {
	var t bqTable
	listed, err := s.Tables(ctx)
	if err != nil {
		return t, err
	}
	found := false
	for _, l := range listed {
		found = found || l.Name == name
	}
	if !found {
		return t, fmt.Errorf("%w: %s", ErrUnknownTable, name)
	}
	err = s.call(ctx, http.MethodGet, s.base()+"/tables/"+url.PathEscape(name), nil, &t)
	return t, err
}

// columnNames flattens a schema into dotted names: records become their
// fields; a repeated record is read as its first element.
func columnNames(prefix string, fields []bqField, out *[]detect.Column) {
	for _, f := range fields {
		name := f.Name
		if prefix != "" {
			name = prefix + "." + f.Name
		}
		if f.Type == "RECORD" || f.Type == "STRUCT" {
			columnNames(name, f.Fields, out)
			continue
		}
		*out = append(*out, detect.Column{Name: name, Type: strings.ToLower(bqType(f.Type))})
	}
}

// bqType names BigQuery's types the way TimeType recognises them.
func bqType(t string) string {
	switch t {
	case "TIMESTAMP", "DATETIME":
		return "timestamp"
	case "DATE":
		return "date"
	}
	return t
}

func (s *bigquerySource) Columns(ctx context.Context, table string) ([]detect.Column, error) {
	t, err := s.table(ctx, table)
	if err != nil {
		return nil, err
	}
	var cols []detect.Column
	columnNames("", t.Schema.Fields, &cols)
	return cols, nil
}

func (s *bigquerySource) Sample(ctx context.Context, table string, n int) (map[string][]any, error) {
	var rows []Row
	err := s.read(ctx, table, nil, n, func(r Row) error {
		rows = append(rows, r)
		return nil
	})
	return transpose(rows), err
}

func (s *bigquerySource) Stream(ctx context.Context, table string, columns []string, fn func(Row) error) error {
	return s.read(ctx, table, columns, 0, fn)
}

func (s *bigquerySource) Close() error { return nil }

// read reads a table's rows, or up to limit of them, keeping only columns
// (all when nil).
func (s *bigquerySource) read(ctx context.Context, table string, columns []string, limit int,
	fn func(Row) error) error {
	t, err := s.table(ctx, table)
	if err != nil {
		return err
	}
	// The top-level fields the chosen columns live in, in schema order.
	top := map[string]bool{}
	for _, c := range columns {
		head, _, _ := strings.Cut(c, ".")
		top[head] = true
	}
	var fields []bqField
	for _, f := range t.Schema.Fields {
		if columns == nil || top[f.Name] {
			fields = append(fields, f)
		}
	}
	if len(fields) == 0 {
		return errors.New("none of the chosen columns are in the table")
	}
	keep := map[string]bool{}
	for _, c := range columns {
		keep[c] = true
	}
	emit := func(cells []any) error {
		row := Row{}
		bqFlatten("", fields, cells, row)
		if columns != nil {
			for k := range row {
				if !keep[k] {
					delete(row, k)
				}
			}
		}
		return fn(row)
	}

	size := s.pageSize
	if limit > 0 && limit < size {
		size = limit
	}
	read := 0
	if t.Type == "TABLE" || t.Type == "" {
		names := make([]string, len(fields))
		for i, f := range fields {
			names[i] = f.Name
		}
		page := ""
		for {
			q := url.Values{"maxResults": {strconv.Itoa(size)}, "formatOptions.useInt64Timestamp": {"true"},
				"selectedFields": {strings.Join(names, ",")}}
			if page != "" {
				q.Set("pageToken", page)
			}
			var res struct {
				Rows      []struct{ F []struct{ V any } } `json:"rows"`
				PageToken string                          `json:"pageToken"`
			}
			if err := s.call(ctx, http.MethodGet, s.base()+"/tables/"+url.PathEscape(table)+"/data?"+q.Encode(),
				nil, &res); err != nil {
				return err
			}
			for _, r := range res.Rows {
				cells := make([]any, len(r.F))
				for i, c := range r.F {
					cells[i] = c.V
				}
				if err := emit(cells); err != nil {
					return err
				}
				if read++; limit > 0 && read >= limit {
					return nil
				}
			}
			if res.PageToken == "" {
				return nil
			}
			page = res.PageToken
		}
	}
	return s.query(ctx, table, fields, limit, size, emit)
}

// query reads a view through a query job, page by page.
func (s *bigquerySource) query(ctx context.Context, table string, fields []bqField, limit, size int,
	emit func([]any) error) error {
	names := make([]string, len(fields))
	for i, f := range fields {
		names[i] = "`" + strings.ReplaceAll(f.Name, "`", "") + "`"
	}
	sql := "SELECT " + strings.Join(names, ", ") + " FROM `" + s.project + "." + s.dataset + "." + table + "`"
	if limit > 0 {
		sql += " LIMIT " + strconv.Itoa(limit)
	}
	type queryResult struct {
		JobComplete  bool `json:"jobComplete"`
		JobReference struct{ JobID, Location string }
		Rows         []struct{ F []struct{ V any } } `json:"rows"`
		PageToken    string                          `json:"pageToken"`
	}
	var res queryResult
	if err := s.call(ctx, http.MethodPost, s.api+"/bigquery/v2/projects/"+url.PathEscape(s.project)+"/queries",
		map[string]any{"query": sql, "useLegacySql": false, "maxResults": size, "timeoutMs": 60000,
			"formatOptions": map[string]any{"useInt64Timestamp": true}}, &res); err != nil {
		return err
	}
	for {
		if res.JobComplete {
			for _, r := range res.Rows {
				cells := make([]any, len(r.F))
				for i, c := range r.F {
					cells[i] = c.V
				}
				if err := emit(cells); err != nil {
					return err
				}
			}
			if res.PageToken == "" {
				return nil
			}
		}
		q := url.Values{"maxResults": {strconv.Itoa(size)}, "timeoutMs": {"60000"},
			"location": {res.JobReference.Location}, "formatOptions.useInt64Timestamp": {"true"}}
		if res.PageToken != "" {
			q.Set("pageToken", res.PageToken)
		}
		job := res.JobReference.JobID
		res = queryResult{}
		if err := s.call(ctx, http.MethodGet, s.api+"/bigquery/v2/projects/"+url.PathEscape(s.project)+
			"/queries/"+url.PathEscape(job)+"?"+q.Encode(), nil, &res); err != nil {
			return err
		}
		res.JobReference.JobID = job
	}
}

// bqFlatten turns one row's cells into named values, records as dotted paths.
func bqFlatten(prefix string, fields []bqField, cells []any, out Row) {
	for i, f := range fields {
		if i >= len(cells) {
			return
		}
		name := f.Name
		if prefix != "" {
			name = prefix + "." + f.Name
		}
		v := cells[i]
		if f.Mode == "REPEATED" {
			// A list: its first element.
			list, _ := v.([]any)
			if len(list) == 0 {
				continue
			}
			v = list[0]
			if m, ok := v.(map[string]any); ok {
				v = m["v"]
			}
		}
		if f.Type == "RECORD" || f.Type == "STRUCT" {
			rec, _ := v.(map[string]any)
			list, _ := rec["f"].([]any)
			sub := make([]any, len(list))
			for j, c := range list {
				if m, ok := c.(map[string]any); ok {
					sub[j] = m["v"]
				}
			}
			bqFlatten(name, f.Fields, sub, out)
			continue
		}
		out[name] = bqValue(f.Type, v)
	}
}

// bqValue makes a cell plain. Timestamps arrive as microseconds since 1970;
// DATETIME, which has no zone, stays wall-clock text for the cleaner.
func bqValue(typ string, v any) any {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	if typ == "TIMESTAMP" {
		if us, err := strconv.ParseInt(s, 10, 64); err == nil {
			return time.UnixMicro(us).UTC()
		}
	}
	return s
}
