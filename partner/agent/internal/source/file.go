package source

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/xuri/excelize/v2"

	"github.com/oolix/partner-agent/internal/detect"
)

// fileSource reads CSV and Excel exports from a folder the Partner drops them
// into -- for a Partner who cannot give the Agent database access at all.
// Each CSV is a table; each sheet of an Excel workbook is one, named
// "workbook.xlsx:Sheet1". The first row holds the column names.
type fileSource struct {
	folder string
}

func openFile(cfg Config) (Source, error) {
	if cfg.Folder == "" {
		return nil, fmt.Errorf("a folder is required for file sources")
	}
	s := &fileSource{folder: cfg.Folder}
	return s, s.Test(context.Background())
}

func (s *fileSource) Test(context.Context) error {
	info, err := os.Stat(s.folder)
	if err != nil {
		return fmt.Errorf("cannot read the folder %s: %w", s.folder, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a folder", s.folder)
	}
	return nil
}

func (s *fileSource) Tables(context.Context) ([]Table, error) {
	entries, err := os.ReadDir(s.folder)
	if err != nil {
		return nil, err
	}
	var out []Table
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		switch strings.ToLower(filepath.Ext(name)) {
		case ".csv", ".tsv", ".txt":
			out = append(out, Table{Name: name, Rows: -1})
		case ".xlsx", ".xlsm":
			f, err := excelize.OpenFile(filepath.Join(s.folder, name))
			if err != nil {
				continue
			}
			for _, sheet := range f.GetSheetList() {
				out = append(out, Table{Name: name + ":" + sheet, Rows: -1})
			}
			_ = f.Close()
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// each reads a table row by row. The name must be one Tables lists, and the
// file is resolved inside the folder only -- a name from a form cannot reach
// anywhere else on the server.
func (s *fileSource) each(ctx context.Context, table string, fn func(header []string, record []string) error) error {
	tables, err := s.Tables(ctx)
	if err != nil {
		return err
	}
	listed := false
	for _, t := range tables {
		if t.Name == table {
			listed = true
			break
		}
	}
	if !listed {
		return fmt.Errorf("%w: %s", ErrUnknownTable, table)
	}

	file, sheet, isSheet := strings.Cut(table, ":")
	path := filepath.Join(s.folder, filepath.Base(file))
	if isSheet {
		return eachSheet(ctx, path, sheet, fn)
	}
	return eachCSV(ctx, path, fn)
}

func eachCSV(ctx context.Context, path string, fn func([]string, []string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	br := bufio.NewReader(f)
	// An Excel "CSV UTF-8" export starts with a byte-order mark that would
	// otherwise become part of the first column's name.
	if bom, _ := br.Peek(3); bytes.Equal(bom, []byte{0xEF, 0xBB, 0xBF}) {
		_, _ = br.Discard(3)
	}
	first, _ := br.Peek(4096)
	r := csv.NewReader(br)
	r.Comma = delimiter(first)
	r.LazyQuotes = true
	r.FieldsPerRecord = -1
	r.ReuseRecord = false

	header, err := r.Read()
	if err != nil {
		return fmt.Errorf("reading the header row: %w", err)
	}
	for i := range header {
		header[i] = strings.TrimSpace(header[i])
	}
	for n := 0; ; n++ {
		if n%1000 == 0 && ctx.Err() != nil {
			return ctx.Err()
		}
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("line %d: %w", n+2, err)
		}
		if err := fn(header, rec); err != nil {
			return err
		}
	}
}

// delimiter picks whichever of , ; tab or | the header line uses most. Excel
// in much of the world writes semicolons.
func delimiter(sample []byte) rune {
	line := sample
	if i := bytes.IndexByte(sample, '\n'); i >= 0 {
		line = sample[:i]
	}
	best, bestN := ',', -1
	for _, d := range []rune{',', ';', '\t', '|'} {
		if n := bytes.Count(line, []byte(string(d))); n > bestN {
			best, bestN = d, n
		}
	}
	return best
}

func eachSheet(ctx context.Context, path, sheet string, fn func([]string, []string) error) error {
	f, err := excelize.OpenFile(path)
	if err != nil {
		return err
	}
	defer f.Close()
	rows, err := f.Rows(sheet)
	if err != nil {
		return err
	}
	defer rows.Close()
	var header []string
	for n := 0; rows.Next(); n++ {
		if n%1000 == 0 && ctx.Err() != nil {
			return ctx.Err()
		}
		// Formatted as Excel shows them: a date cell arrives as the date
		// text, which the cleaner reads like any other.
		rec, err := rows.Columns()
		if err != nil {
			return err
		}
		if header == nil {
			for _, h := range rec {
				header = append(header, strings.TrimSpace(h))
			}
			continue
		}
		if err := fn(header, rec); err != nil {
			return err
		}
	}
	return rows.Error()
}

func toRow(header, rec []string, keep map[string]bool) Row {
	row := Row{}
	for i, h := range header {
		if h == "" || (keep != nil && !keep[h]) {
			continue
		}
		var v any
		if i < len(rec) && strings.TrimSpace(rec[i]) != "" {
			v = rec[i]
		}
		row[h] = v
	}
	return row
}

func (s *fileSource) Columns(ctx context.Context, table string) ([]detect.Column, error) {
	var cols []detect.Column
	err := s.each(ctx, table, func(header, _ []string) error {
		for _, h := range header {
			if h != "" {
				cols = append(cols, detect.Column{Name: h, Type: "text"})
			}
		}
		return errStop
	})
	if errors.Is(err, errStop) {
		err = nil
	}
	return cols, err
}

func (s *fileSource) Sample(ctx context.Context, table string, n int) (map[string][]any, error) {
	var rows []Row
	err := s.each(ctx, table, func(header, rec []string) error {
		rows = append(rows, toRow(header, rec, nil))
		if len(rows) >= n {
			return errStop
		}
		return nil
	})
	if errors.Is(err, errStop) {
		err = nil
	}
	return transpose(rows), err
}

func (s *fileSource) Stream(ctx context.Context, table string, columns []string, fn func(Row) error) error {
	keep := map[string]bool{}
	for _, c := range columns {
		keep[c] = true
	}
	return s.each(ctx, table, func(header, rec []string) error {
		return fn(toRow(header, rec, keep))
	})
}

func (s *fileSource) Close() error { return nil }

var errStop = errors.New("stop")
