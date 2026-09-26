package source

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/xuri/excelize/v2"
)

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestFileSourceReadsCSVExports(t *testing.T) {
	dir := t.TempDir()
	// An Excel "CSV UTF-8" export: byte-order mark, semicolons, a blank cell.
	writeFile(t, dir, "customers.csv",
		"\xEF\xBB\xBFcustomer_id;DOB;City;email\n"+
			"C1;14/04/1992;Mumbai;a@example.com\n"+
			"C2;;Bangalore;b@example.com\n")
	writeFile(t, dir, "notes.pdf", "not a table")

	ctx := context.Background()
	s, err := Open(ctx, Config{Kind: File, Folder: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	tables, err := s.Tables(ctx)
	if err != nil || len(tables) != 1 || tables[0].Name != "customers.csv" {
		t.Fatalf("tables: %v, %v", tables, err)
	}
	cols, err := s.Columns(ctx, "customers.csv")
	if err != nil || len(cols) != 4 || cols[0].Name != "customer_id" {
		t.Fatalf("columns (the BOM must not leak into the first name): %+v, %v", cols, err)
	}

	var rows []Row
	err = s.Stream(ctx, "customers.csv", []string{"customer_id", "DOB"}, func(r Row) error {
		rows = append(rows, r)
		return nil
	})
	if err != nil || len(rows) != 2 {
		t.Fatalf("stream: %v, %v", rows, err)
	}
	if rows[0]["DOB"] != "14/04/1992" || rows[1]["DOB"] != nil {
		t.Errorf("values: %+v", rows)
	}
	if _, leaked := rows[0]["email"]; leaked {
		t.Error("a column that was not asked for was read")
	}
}

func TestFileSourceReadsExcelSheets(t *testing.T) {
	dir := t.TempDir()
	f := excelize.NewFile()
	_ = f.SetSheetRow("Sheet1", "A1", &[]any{"id", "Gender", "Tier"})
	_ = f.SetSheetRow("Sheet1", "A2", &[]any{"C1", "F", "Gold"})
	_ = f.SetSheetRow("Sheet1", "A3", &[]any{"C2", "M", "Silver"})
	if err := f.SaveAs(filepath.Join(dir, "export.xlsx")); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	s, err := Open(ctx, Config{Kind: File, Folder: dir})
	if err != nil {
		t.Fatal(err)
	}
	sample, err := s.Sample(ctx, "export.xlsx:Sheet1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(sample["Gender"]) != 2 || sample["Gender"][0] != "F" {
		t.Errorf("sample: %+v", sample)
	}
}

func TestFileSourceStaysInsideItsFolder(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "customers.csv", "id\nC1\n")
	s, _ := Open(context.Background(), Config{Kind: File, Folder: dir})
	for _, name := range []string{"../customers.csv", "/etc/passwd", "customers.csv/../../x.csv"} {
		if _, err := s.Sample(context.Background(), name, 5); !errors.Is(err, ErrUnknownTable) {
			t.Errorf("%q: got %v, want ErrUnknownTable", name, err)
		}
	}
}

func TestDelimiter(t *testing.T) {
	for in, want := range map[string]rune{
		"a,b,c\n": ',', "a;b;c\n": ';', "a\tb\tc\n": '\t', "a|b|c\n": '|', "single\n": ',',
	} {
		if got := delimiter([]byte(in)); got != want {
			t.Errorf("delimiter(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTimeType(t *testing.T) {
	for typ, want := range map[string]bool{
		"timestamp without time zone": true, "timestamp with time zone": true, "date": true,
		"datetime": true, "datetime2": true, "datetimeoffset": true, "smalldatetime": true,
		"time.time": true, "text": false, "varchar": false, "time": false, "string": false,
	} {
		if TimeType(typ) != want {
			t.Errorf("TimeType(%q) = %v", typ, !want)
		}
	}
}

// Files cannot be read from a date on; they are read whole.
func TestFilesAreReadWhole(t *testing.T) {
	var src Source = &fileSource{}
	if _, ok := src.(SinceStreamer); ok {
		t.Error("a file source claims it can read from a date on")
	}
}
