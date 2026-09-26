// Package source reads a Partner's customer data, whatever database it lives
// in -- read-only, and only the columns the Partner chose.
//
// Every connector answers the same five questions: can I connect, what tables
// are there, what columns does one have, what do a few rows look like, and
// give me every row. Everything after that -- cleaning, storing, matching
// audiences -- is the same for every database, which is what makes a new
// database a connector's worth of work rather than a rewrite.
//
// Values come back as plain Go values: nil, string, int64, float64, bool or
// time.Time. A date or time the database stores WITHOUT a time zone comes
// back as text ("2024-05-01 10:30:00"), so the cleaner reads it as local wall
// clock time instead of mistaking it for UTC.
package source

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/detect"
)

// Kind is a supported source.
type Kind string

const (
	Postgres  Kind = "postgres"
	MySQL     Kind = "mysql"
	SQLServer Kind = "sqlserver"
	MongoDB   Kind = "mongodb"
	File      Kind = "file"
)

// Kinds lists every supported source, in the order the setup page offers them.
var Kinds = []Kind{Postgres, MySQL, SQLServer, MongoDB, File}

// Label is how the setup page names a kind.
func (k Kind) Label() string {
	switch k {
	case Postgres:
		return "PostgreSQL"
	case MySQL:
		return "MySQL / MariaDB"
	case SQLServer:
		return "Microsoft SQL Server"
	case MongoDB:
		return "MongoDB"
	case File:
		return "CSV or Excel files"
	}
	return string(k)
}

// DefaultPort is the usual port for a kind, or 0.
func (k Kind) DefaultPort() int {
	switch k {
	case Postgres:
		return 5432
	case MySQL:
		return 3306
	case SQLServer:
		return 1433
	case MongoDB:
		return 27017
	}
	return 0
}

// Config is how to reach one source. It is stored encrypted in the Agent's
// local store; the password never appears in a log or on a page.
type Config struct {
	Kind     Kind   `json:"kind"`
	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	Database string `json:"database,omitempty"`
	User     string `json:"user,omitempty"`
	Password string `json:"password,omitempty"`
	// TLS is "prefer" (the default), "require" or "disable".
	TLS string `json:"tls,omitempty"`
	// URI is a full connection string, for sources that need one
	// (mongodb+srv://...). It overrides the fields above.
	URI string `json:"uri,omitempty"`
	// Folder is where File sources find their CSV and Excel files.
	Folder string `json:"folder,omitempty"`
	// Location is the time zone wall-clock times are written in, such as
	// "Asia/Kolkata"; see package clean. Used to render naive times correctly.
	Location string `json:"location,omitempty"`
}

// Table is one table, view, collection, file or sheet.
type Table struct {
	Name string
	// Rows is an estimate, or -1 when the source cannot say cheaply.
	Rows int64
}

// Row is one record: column name to value.
type Row map[string]any

// Source is one connected Partner database.
type Source interface {
	// Test connects and runs the cheapest possible query.
	Test(ctx context.Context) error
	// Tables lists what can be read.
	Tables(ctx context.Context) ([]Table, error)
	// Columns describes one table's columns or fields.
	Columns(ctx context.Context, table string) ([]detect.Column, error)
	// Sample reads up to n rows, column by column.
	Sample(ctx context.Context, table string, n int) (map[string][]any, error)
	// Stream reads every row, calling fn for each. Only the named columns are
	// read; nothing else in the table leaves the Partner's database.
	Stream(ctx context.Context, table string, columns []string, fn func(Row) error) error
	Close() error
}

// ErrUnknownTable is returned for a table the source does not list.
var ErrUnknownTable = errors.New("no such table")

// SinceStreamer is a Source that can read only the rows whose date column is
// on or after a moment -- what keeps a nightly read of a large orders table to
// the last two years, or a customer table to the rows changed since the last
// sync. It may return a day or two more than asked for; callers filter
// exactly. Files cannot, and are read whole.
type SinceStreamer interface {
	StreamSince(ctx context.Context, table string, columns []string, dateColumn string,
		since time.Time, fn func(Row) error) error
}

// TimeType reports whether a column's type holds a date or a time natively --
// the only kind a source can filter on without reading every row. It takes
// the types Columns reports: database type names, or "time.time" for a
// MongoDB date.
func TimeType(typ string) bool {
	t := strings.ToLower(typ)
	return t == "date" || t == "time.time" || t == "smalldatetime" ||
		strings.HasPrefix(t, "timestamp") || strings.HasPrefix(t, "datetime")
}

// Open connects to a source.
func Open(ctx context.Context, cfg Config) (Source, error) {
	switch cfg.Kind {
	case Postgres, MySQL, SQLServer:
		return openSQL(ctx, cfg)
	case MongoDB:
		return openMongo(ctx, cfg)
	case File:
		return openFile(cfg)
	default:
		return nil, fmt.Errorf("unsupported source %q", cfg.Kind)
	}
}

// columnsFromSample builds a column list from sampled rows, for sources with
// no fixed schema. Columns are ordered by how often they appear.
func columnsFromSample(rows []Row, pk string) []detect.Column {
	count := map[string]int{}
	types := map[string]map[string]int{}
	for _, r := range rows {
		for name, v := range r {
			count[name]++
			if types[name] == nil {
				types[name] = map[string]int{}
			}
			types[name][typeName(v)]++
		}
	}
	names := make([]string, 0, len(count))
	for n := range count {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool {
		if count[names[i]] != count[names[j]] {
			return count[names[i]] > count[names[j]]
		}
		return names[i] < names[j]
	})
	out := make([]detect.Column, 0, len(names))
	for _, n := range names {
		out = append(out, detect.Column{Name: n, Type: dominant(types[n]), PrimaryKey: n == pk})
	}
	return out
}

func typeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case int64:
		return "integer"
	case float64:
		return "number"
	case bool:
		return "boolean"
	default:
		return strings.ToLower(fmt.Sprintf("%T", v))
	}
}

func dominant(counts map[string]int) string {
	best, n := "", -1
	for t, c := range counts {
		if t != "null" && c > n {
			best, n = t, c
		}
	}
	return best
}

// transpose turns sampled rows into column-wise values.
func transpose(rows []Row) map[string][]any {
	out := map[string][]any{}
	for _, r := range rows {
		for k, v := range r {
			out[k] = append(out[k], v)
		}
	}
	return out
}
