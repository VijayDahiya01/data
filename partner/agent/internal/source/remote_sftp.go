package source

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"github.com/oolix/partner-agent/internal/netx"
)

// sftpStore reads a folder on an SFTP server. The server's key is pinned: the
// first connection records its fingerprint (the setup page shows it), and a
// different key is refused afterwards -- what stops someone posing as the
// server to collect the password.
type sftpStore struct {
	conn   *ssh.Client
	client *sftp.Client
	folder string
	// SeenHostKey is the fingerprint the server presented.
	SeenHostKey string
}

// ErrHostKeyChanged means the SFTP server's key is not the one recorded.
var ErrHostKeyChanged = errors.New("the SFTP server's key has changed since it was first seen: " +
	"if that is expected, clear the recorded key and connect again")

func openSFTP(ctx context.Context, cfg Config) (*sftpStore, error) {
	st := &sftpStore{folder: cfg.Path}
	if st.folder == "" {
		st.folder = "."
	}
	auth := []ssh.AuthMethod{ssh.Password(cfg.Password)}
	if strings.Contains(cfg.Password, "PRIVATE KEY") {
		signer, err := ssh.ParsePrivateKey([]byte(cfg.Password))
		if err != nil {
			return nil, fmt.Errorf("the private key could not be read: %w", err)
		}
		auth = []ssh.AuthMethod{ssh.PublicKeys(signer)}
	}
	conf := &ssh.ClientConfig{
		User: cfg.User,
		Auth: auth,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			st.SeenHostKey = ssh.FingerprintSHA256(key)
			if cfg.HostKey != "" && cfg.HostKey != st.SeenHostKey {
				return ErrHostKeyChanged
			}
			return nil
		},
		Timeout: 15 * time.Second,
	}
	port := cfg.Port
	if port == 0 {
		port = 22
	}
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(port))
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	raw, err := netx.Dial(dialCtx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("could not connect: %w", err)
	}
	c, chans, reqs, err := ssh.NewClientConn(raw, addr, conf)
	if err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("could not sign in: %w", err)
	}
	st.conn = ssh.NewClient(c, chans, reqs)
	st.client, err = sftp.NewClient(st.conn)
	if err != nil {
		_ = st.conn.Close()
		return nil, fmt.Errorf("the server does not offer SFTP: %w", err)
	}
	return st, nil
}

func (s *sftpStore) list(context.Context) ([]remoteFile, error) {
	entries, err := s.client.ReadDir(s.folder)
	if err != nil {
		return nil, err
	}
	var out []remoteFile
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		out = append(out, remoteFile{Name: e.Name(), Size: e.Size(), Modified: e.ModTime(),
			Tag: fmt.Sprintf("%d-%d", e.Size(), e.ModTime().Unix())})
	}
	return out, nil
}

func (s *sftpStore) fetch(ctx context.Context, name string, w io.Writer) error {
	f, err := s.client.Open(path.Join(s.folder, path.Base(name)))
	if err != nil {
		return err
	}
	defer f.Close()
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(w, f)
		done <- err
	}()
	select {
	case <-ctx.Done():
		_ = f.Close()
		return ctx.Err()
	case err := <-done:
		return err
	}
}

func (s *sftpStore) close() error {
	_ = s.client.Close()
	return s.conn.Close()
}

// HostKeyOf is the key fingerprint an SFTP source saw when it connected, for
// the setup page to record; "" for other sources.
func HostKeyOf(src Source) string {
	if r, ok := src.(*remoteSource); ok {
		if st, ok := r.store.(*sftpStore); ok {
			return st.SeenHostKey
		}
	}
	return ""
}
