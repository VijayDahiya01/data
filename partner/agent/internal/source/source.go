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
	"sync/atomic"
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
	Oracle    Kind = "oracle"
)

// Kinds lists every supported source, in the order the setup page offers them.
var Kinds = []Kind{Postgres, MySQL, SQLServer, Oracle, MongoDB, BigQuery, Snowflake, GoogleSheets, Shopify, File, SFTP, S3, GCS, AzureBlob}

// Label is how the setup page names a kind.
func (k Kind) Label() string {
	switch k {
	case Postgres:
		return "PostgreSQL"
	case MySQL:
		return "MySQL / MariaDB"
	case SQLServer:
		return "Microsoft SQL Server"
	case Oracle:
		return "Oracle Database"
	case BigQuery:
		return "Google BigQuery"
	case Snowflake:
		return "Snowflake"
	case Shopify:
		return "Shopify store"
	case GoogleSheets:
		return "Google Sheets"
	case MongoDB:
		return "MongoDB"
	case File:
		return "CSV, Excel or JSON-lines files"
	case SFTP:
		return "Files on an SFTP server"
	case S3:
		return "Files in Amazon S3 (or S3-compatible)"
	case GCS:
		return "Files in Google Cloud Storage"
	case AzureBlob:
		return "Files in Azure Blob Storage"
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
	case Oracle:
		return 1521
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
	// TLS is "prefer" (the default), "require" (encrypted, certificate not
	// checked), "verify" (encrypted, certificate checked) or "disable".
	TLS string `json:"tls,omitempty"`
	// URI is a full connection string, for sources that need one
	// (mongodb+srv://...). It overrides the fields above.
	URI string `json:"uri,omitempty"`
	// Folder is where File sources find their CSV and Excel files.
	Folder string `json:"folder,omitempty"`
	// Location is the time zone wall-clock times are written in, such as
	// "Asia/Kolkata"; see package clean. Used to render naive times correctly.
	Location string `json:"location,omitempty"`
	// RowsPerSecond caps how fast tables are read, for a database that is
	// busy at night too. 0 means no cap.
	RowsPerSecond int `json:"rows_per_second,omitempty"`

	// For files in a remote folder (SFTP, S3, Google Cloud Storage, Azure
	// Blob): the bucket, the folder inside it, and the region. User holds
	// the access key ID; Password the secret, the SFTP password or private
	// key, or the service-account key; URI an Azure container SAS link.
	Bucket string `json:"bucket,omitempty"`
	Path   string `json:"path,omitempty"`
	Region string `json:"region,omitempty"`
	// HostKey is the SFTP server's key fingerprint, recorded the first time
	// the Agent connects and required from then on.
	HostKey string `json:"host_key,omitempty"`
	// Warehouse and Role are Snowflake's: the compute that runs the reads,
	// and a role with SELECT on the customer table only.
	Warehouse string `json:"warehouse,omitempty"`
	Role      string `json:"role,omitempty"`
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
	if RequireVerifiedTLS.Load() {
		var err error
		if cfg, err = verifiedTLS(cfg); err != nil {
			return nil, err
		}
	}
	switch cfg.Kind {
	case Postgres, MySQL, SQLServer, Oracle:
		return openSQL(ctx, cfg)
	case MongoDB:
		return openMongo(ctx, cfg)
	case File:
		return openFile(cfg)
	case SFTP, S3, GCS, AzureBlob:
		return openRemote(ctx, cfg)
	case BigQuery:
		return openBigQuery(ctx, cfg)
	case Snowflake:
		return openSnowflake(ctx, cfg)
	case Shopify:
		return openShopify(ctx, cfg)
	case GoogleSheets:
		return openSheets(ctx, cfg)
	default:
		return nil, fmt.Errorf("unsupported source %q", cfg.Kind)
	}
}

// RequireVerifiedTLS makes every database connection encrypted with the
// server's certificate checked. An Agent hosted in an enclave sets it: its
// host carries the bytes, and must only ever see ciphertext.
var RequireVerifiedTLS atomic.Bool

// verifiedTLS turns a database connection's TLS to "verify". A connection
// string could ask for less, so only the separate fields are accepted --
// except a mongodb+srv:// address that does not turn checking off.
func verifiedTLS(cfg Config) (Config, error) {
	switch cfg.Kind {
	case Postgres, MySQL, SQLServer, Oracle, MongoDB:
	default:
		return cfg, nil // HTTPS, SSH or a local folder: encrypted and checked already
	}
	if cfg.URI != "" {
		lower := strings.ToLower(cfg.URI)
		if cfg.Kind != MongoDB || !strings.HasPrefix(lower, "mongodb+srv://") ||
			strings.Contains(lower, "tlsinsecure=true") || strings.Contains(lower, "tlsallowinvalid") ||
			strings.Contains(lower, "tls=false") || strings.Contains(lower, "ssl=false") {
			return cfg, errors.New("this Agent only connects with the server's certificate checked: " +
				"enter the host, port and login instead of a connection string")
		}
		return cfg, nil
	}
	cfg.TLS = "verify"
	return cfg, nil
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
