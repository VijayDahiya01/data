package source

import (
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/oolix/partner-agent/internal/detect"
)

// Files a Partner drops somewhere other than the Agent's own server: an SFTP
// folder, an S3 or Google Cloud Storage bucket, an Azure Blob container. The
// Agent lists the folder, downloads only the file a table needs into a
// temporary folder of its own, and reads it as it reads local files -- CSV,
// Excel, JSON lines, daily exports as one series. Nothing is written back.

const (
	SFTP      Kind = "sftp"
	S3        Kind = "s3"
	GCS       Kind = "gcs"
	AzureBlob Kind = "azure_blob"
)

// remoteFile is one file in a remote folder, relative to it.
type remoteFile struct {
	Name     string
	Size     int64
	Modified time.Time
	// Tag changes when the content does (an ETag, or size and time).
	Tag string
}

// remoteStore is what each kind of remote folder can do.
type remoteStore interface {
	list(ctx context.Context) ([]remoteFile, error)
	fetch(ctx context.Context, name string, w io.Writer) error
	close() error
}

type remoteSource struct {
	store remoteStore
	cache string
	files *fileSource

	mu         sync.Mutex
	downloaded map[string]string // name -> tag
}

func openRemote(ctx context.Context, cfg Config) (Source, error) {
	var (
		st  remoteStore
		err error
	)
	switch cfg.Kind {
	case SFTP:
		st, err = openSFTP(ctx, cfg)
	case S3:
		st, err = openS3(cfg)
	case GCS:
		st, err = openGCS(ctx, cfg)
	case AzureBlob:
		st, err = openAzure(cfg)
	default:
		return nil, fmt.Errorf("unknown remote folder %q", cfg.Kind)
	}
	if err != nil {
		return nil, err
	}
	cache, err := os.MkdirTemp("", "oolix-remote-*")
	if err != nil {
		_ = st.close()
		return nil, err
	}
	s := &remoteSource{store: st, cache: cache, files: &fileSource{folder: cache}, downloaded: map[string]string{}}
	if err := s.Test(ctx); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

func (s *remoteSource) Test(ctx context.Context) error {
	_, err := s.store.list(ctx)
	if err != nil {
		return fmt.Errorf("could not list the folder: %w", err)
	}
	return nil
}

// dataFiles lists the files the Agent can read, by name.
func (s *remoteSource) dataFiles(ctx context.Context) (map[string]remoteFile, error) {
	listed, err := s.store.list(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]remoteFile{}
	for _, f := range listed {
		switch strings.ToLower(path.Ext(f.Name)) {
		case ".csv", ".tsv", ".txt", ".jsonl", ".ndjson", ".xlsx", ".xlsm":
			out[f.Name] = f
		}
	}
	return out, nil
}

func (s *remoteSource) Tables(ctx context.Context) ([]Table, error) {
	files, err := s.dataFiles(ctx)
	if err != nil {
		return nil, err
	}
	var plain []string
	var out []Table
	for name := range files {
		switch strings.ToLower(path.Ext(name)) {
		case ".xlsx", ".xlsm":
			// A workbook's sheets are only known once it is downloaded.
			if err := s.ensure(ctx, files[name]); err != nil {
				return nil, err
			}
			sheets, err := s.files.Tables(ctx)
			if err != nil {
				return nil, err
			}
			for _, t := range sheets {
				if strings.HasPrefix(t.Name, localName(name)+":") {
					out = append(out, Table{Name: name + strings.TrimPrefix(t.Name, localName(name)), Rows: -1})
				}
			}
		default:
			plain = append(plain, name)
		}
	}
	series, _ := groupSeries(plain)
	for _, name := range series {
		out = append(out, Table{Name: name, Rows: -1})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// localName is where a remote file is kept in the cache: its base name, so a
// name from the remote side cannot reach outside the cache folder.
func localName(name string) string {
	return filepath.Base(strings.ReplaceAll(name, "/", "_"))
}

// ensure downloads a file unless the cache already has this version of it.
func (s *remoteSource) ensure(ctx context.Context, f remoteFile) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if tag, ok := s.downloaded[f.Name]; ok && tag == f.Tag {
		return nil
	}
	tmp, err := os.CreateTemp(s.cache, ".download-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := s.store.fetch(ctx, f.Name, tmp); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("downloading %s: %w", f.Name, err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(s.cache, localName(f.Name))); err != nil {
		return err
	}
	s.downloaded[f.Name] = f.Tag
	return nil
}

// local resolves a table to its file in the cache, downloading it first: a
// series reads its newest file, a sheet its workbook.
func (s *remoteSource) local(ctx context.Context, table string) (string, error) {
	files, err := s.dataFiles(ctx)
	if err != nil {
		return "", err
	}
	name, sheet, isSheet := strings.Cut(table, ":")
	if strings.Contains(name, "*") {
		var members []string
		for n := range files {
			if series, _, ok := seriesOf(n); ok && series == name {
				members = append(members, n)
			}
		}
		name = newest(members)
	}
	f, ok := files[name]
	if !ok {
		return "", fmt.Errorf("%w: %s", ErrUnknownTable, table)
	}
	if err := s.ensure(ctx, f); err != nil {
		return "", err
	}
	if isSheet {
		return localName(name) + ":" + sheet, nil
	}
	return localName(name), nil
}

func (s *remoteSource) Columns(ctx context.Context, table string) ([]detect.Column, error) {
	local, err := s.local(ctx, table)
	if err != nil {
		return nil, err
	}
	return s.files.Columns(ctx, local)
}

func (s *remoteSource) Sample(ctx context.Context, table string, n int) (map[string][]any, error) {
	local, err := s.local(ctx, table)
	if err != nil {
		return nil, err
	}
	return s.files.Sample(ctx, local, n)
}

func (s *remoteSource) Stream(ctx context.Context, table string, columns []string, fn func(Row) error) error {
	local, err := s.local(ctx, table)
	if err != nil {
		return err
	}
	return s.files.Stream(ctx, local, columns, fn)
}

// Close deletes the downloaded files.
func (s *remoteSource) Close() error {
	err := s.store.close()
	_ = os.RemoveAll(s.cache)
	return err
}

// remoteKinds are the kinds read through a remote folder.
func remoteKind(k Kind) bool {
	return k == SFTP || k == S3 || k == GCS || k == AzureBlob
}

// joinPrefix puts a folder in front of a name, with exactly one slash.
func joinPrefix(prefix, name string) string {
	prefix = strings.Trim(prefix, "/")
	if prefix == "" {
		return name
	}
	return prefix + "/" + name
}
