package source

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/parquet-go/parquet-go"
	"github.com/parquet-go/parquet-go/deprecated"
)

type parquetAddress struct {
	City    string `parquet:"city"`
	Primary bool   `parquet:"primary"`
}

type parquetCustomer struct {
	ID       string  `parquet:"id"`
	DOB      int32   `parquet:"dob,date"`
	SignedUp int64   `parquet:"signed_up,timestamp(millisecond)"`
	LastSeen int64   `parquet:"last_seen,timestamp(microsecond:local)"`
	Email    *string `parquet:"email,optional"`
	// pandas writes a mobile number column with gaps as floats.
	Mobile  float64 `parquet:"mobile"`
	Spend   int64   `parquet:"spend,decimal(2:12)"`
	Consent bool    `parquet:"consent"`
	Profile struct {
		Gender string `parquet:"gender"`
	} `parquet:"profile"`
	Addresses []parquetAddress  `parquet:"addresses,list"`
	Tags      []string          `parquet:"tags,list"`
	Attrs     map[string]string `parquet:"attrs"`
	// Spark's old timestamps, a UUID, and text written without its
	// annotation by an older writer.
	Ordered deprecated.Int96 `parquet:"ordered"`
	Device  uuid.UUID        `parquet:"device"`
	Note    []byte           `parquet:"note"`
}

func writeParquet[T any](t *testing.T, path string, rows []T) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	w := parquet.NewGenericWriter[T](f)
	if _, err := w.Write(rows); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func days(y int, m time.Month, d int) int32 {
	return int32(time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix() / 86400)
}

// int96 is a moment as Impala and Spark store it: nanoseconds into the day,
// then the Julian day.
func int96(at time.Time) deprecated.Int96 {
	day := at.Unix()/86400 + 2440588
	nanos := uint64(at.Unix()%86400)*1e9 + uint64(at.Nanosecond())
	return deprecated.Int96{uint32(nanos), uint32(nanos >> 32), uint32(day)}
}

func TestParquetFile(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	email := "asha@example.com"
	signedUp := time.Date(2026, 10, 1, 10, 30, 0, 250e6, time.UTC)
	device := uuid.MustParse("6f1c1d2e-8a4b-4c3d-9e5f-0a1b2c3d4e5f")
	asha := parquetCustomer{ID: "C1", DOB: days(1990, 4, 14), SignedUp: signedUp.UnixMilli(),
		LastSeen: time.Date(2026, 10, 27, 18, 45, 0, 0, time.UTC).UnixMicro(), Email: &email,
		Mobile: 9876543210, Spend: 123456, Consent: true,
		Addresses: []parquetAddress{{City: "Mumbai"}, {City: "Pune", Primary: true}},
		Tags:      []string{"travel", "cricket"}, Attrs: map[string]string{"tier": "gold"},
		Ordered: int96(time.Date(2026, 10, 1, 10, 30, 0, 0, time.UTC)), Device: device, Note: []byte("vip")}
	asha.Profile.Gender = "F"
	ravi := parquetCustomer{ID: "C2", DOB: days(1985, 1, 1), Spend: -5}
	writeParquet(t, filepath.Join(dir, "customers.parquet"), []parquetCustomer{asha, ravi})

	s := &fileSource{folder: dir}
	tables, err := s.Tables(ctx)
	if err != nil || len(tables) != 1 || tables[0].Name != "customers.parquet" {
		t.Fatalf("tables %+v, %v", tables, err)
	}
	cols, err := s.Columns(ctx, "customers.parquet")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, c := range cols {
		names = append(names, c.Name)
	}
	// Every column is known from the file's schema, and a list's wrappers
	// take no name.
	for _, want := range []string{"id", "dob", "email", "profile.gender", "addresses.city", "addresses.primary", "tags", "attrs.tier"} {
		if !slices.Contains(names, want) {
			t.Errorf("column %s missing from %v", want, names)
		}
	}

	var rows []Row
	if err := s.Stream(ctx, "customers.parquet", names, func(r Row) error {
		rows = append(rows, r)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("read %d rows", len(rows))
	}
	want := map[string]any{
		"id": "C1", "dob": "1990-04-14", "signed_up": "2026-10-01T10:30:00.25Z",
		// Local time: the clock reading, so the Partner's time zone applies.
		"last_seen": "2026-10-27T18:45:00", "email": email, "mobile": "9876543210",
		"spend": "1234.56", "consent": "true", "profile.gender": "F",
		// The primary address, not the first; a list of values, its first.
		"addresses.city": "Pune", "tags": "travel", "attrs.tier": "gold",
		"ordered": "2026-10-01T10:30:00Z", "device": device.String(), "note": "vip",
	}
	for k, v := range want {
		if rows[0][k] != v {
			t.Errorf("%s: %v, want %v", k, rows[0][k], v)
		}
	}
	// No value is no value: an empty list, a missing email.
	for _, k := range []string{"email", "addresses.city", "tags"} {
		if rows[1][k] != nil {
			t.Errorf("C2 %s: %v, want nothing", k, rows[1][k])
		}
	}
	if rows[1]["spend"] != "-0.05" {
		t.Errorf("C2 spend %v", rows[1]["spend"])
	}

	// Only the columns asked for.
	if err := s.Stream(ctx, "customers.parquet", []string{"id", "dob"}, func(r Row) error {
		if len(r) != 2 {
			t.Errorf("asked for two columns, read %v", r)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestParquetSeriesAndDamage(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	type row struct {
		ID   string `parquet:"id"`
		City string `parquet:"city"`
	}
	writeParquet(t, filepath.Join(dir, "customers_2026-10-26.parquet"), []row{{"C9", "Agra"}})
	writeParquet(t, filepath.Join(dir, "customers_2026-10-27.parquet"), []row{{"C1", "Mumbai"}, {"C2", "Pune"}})
	s := &fileSource{folder: dir}
	tables, err := s.Tables(ctx)
	if err != nil || len(tables) != 1 || tables[0].Name != "customers_*.parquet" {
		t.Fatalf("daily exports listed as %+v, %v", tables, err)
	}
	sample, err := s.Sample(ctx, "customers_*.parquet", 10)
	if err != nil || len(sample["city"]) != 2 || sample["city"][0] != "Mumbai" {
		t.Fatalf("the newest export read as %v, %v", sample, err)
	}

	// A damaged export is an error, never a crash.
	good, err := os.ReadFile(filepath.Join(dir, "customers_2026-10-27.parquet"))
	if err != nil {
		t.Fatal(err)
	}
	broken := t.TempDir()
	for name, body := range map[string][]byte{
		"cut.parquet":     good[:len(good)/2],
		"garbage.parquet": []byte("PAR1 this is not really a parquet file PAR1"),
		"zeros.parquet":   append(append([]byte("PAR1"), make([]byte, 64)...), []byte("\x10\x00\x00\x00PAR1")...),
	} {
		if err := os.WriteFile(filepath.Join(broken, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
		err := (&fileSource{folder: broken}).Stream(ctx, name, nil, func(Row) error { return nil })
		if err == nil || !strings.Contains(err.Error(), "could not be read as Parquet") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

type listOnly []remoteFile

func (l listOnly) list(context.Context) ([]remoteFile, error)   { return l, nil }
func (listOnly) fetch(context.Context, string, io.Writer) error { return errors.New("not fetched") }
func (listOnly) close() error                                   { return nil }

// A bucket's Parquet exports are tables like its CSVs.
func TestRemoteFolderListsParquet(t *testing.T) {
	s := &remoteSource{store: listOnly{{Name: "exports/customers.parquet"}, {Name: "exports/logo.png"}}}
	files, err := s.dataFiles(context.Background())
	if err != nil || len(files) != 1 || files["exports/customers.parquet"].Name == "" {
		t.Fatalf("data files %v, %v", files, err)
	}
}

func TestDecimalText(t *testing.T) {
	for _, c := range []struct {
		raw   []byte
		scale int
		want  string
	}{
		{[]byte{0x30, 0x39}, 2, "123.45"},
		{[]byte{0xFF, 0xFB}, 2, "-0.05"},
		{[]byte{0x07}, 0, "7"},
		{[]byte{0x07}, -2, "700"},
	} {
		if got := decimalText(signedBigEndian(c.raw), c.scale); got != c.want {
			t.Errorf("%x scale %d: %s, want %s", c.raw, c.scale, got, c.want)
		}
	}
}
