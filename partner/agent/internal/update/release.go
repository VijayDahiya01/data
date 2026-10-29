// Package update installs new releases of the Agent (docs/DESIGN-PARTNER-DATA.md
// §6): signed with Oolix's release key, whose public half is built into the
// Agent; offered by Oolix's API to a share of Agents at a time, a staged
// rollout; and installed only when the Partner allows it -- automatically at
// night, or when they press Update now on the setup page.
//
// Installing never touches the binary the Partner installed. The new one is
// kept in the Agent's state folder and run in its place at every start, once
// it checks out again; one that fails to start three times is set aside, and
// the installed binary runs. A binary the Partner installs that is newer than
// what was kept wins over it. On Windows, where a process cannot be replaced
// in place, the service's executable is swapped and the old one kept beside
// it.
package update

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"runtime"
	"strings"
	"time"
)

var (
	// ReleaseKey is the Ed25519 public key releases are signed with, in
	// base64, set when the release is built. Without it the Agent does not
	// update itself.
	ReleaseKey string
	// BuiltAt is when this binary's commit was made (RFC 3339), set with
	// it. A release older than this binary is never installed.
	BuiltAt string
)

// Release is a release's signed manifest, release.json: its version, when its
// commit was made, and each platform's binary.
type Release struct {
	Version string          `json:"version"`
	BuiltAt time.Time       `json:"built_at"`
	Files   map[string]File `json:"files"`
}

// File is one platform's binary.
type File struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Platform names this binary's platform as releases do: linux-amd64.
func Platform() string { return runtime.GOOS + "-" + runtime.GOARCH }

// Key reads a base64 Ed25519 public key.
func Key(encoded string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("not an Ed25519 public key in base64")
	}
	return ed25519.PublicKey(b), nil
}

// Sign signs a manifest, for the release tool: the signature file's content.
func Sign(key ed25519.PrivateKey, manifest []byte) []byte {
	return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(key, manifest)) + "\n")
}

// Open checks a manifest's signature and reads it. Every file name must be a
// plain name: a release cannot point the Agent anywhere but beside itself.
func Open(key ed25519.PublicKey, manifest, signature []byte) (*Release, error) {
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signature)))
	if err != nil || !ed25519.Verify(key, manifest, sig) {
		return nil, errors.New("the release is not signed with Oolix's release key")
	}
	var r Release
	if err := json.Unmarshal(manifest, &r); err != nil {
		return nil, fmt.Errorf("reading the release: %w", err)
	}
	if r.Version == "" || r.BuiltAt.IsZero() {
		return nil, errors.New("the release names no version or build time")
	}
	for platform, f := range r.Files {
		if f.Name == "" || path.Base(f.Name) != f.Name || strings.ContainsAny(f.Name, `\:`) || f.Name == ".." ||
			len(f.SHA256) != 64 || f.Size <= 0 {
			return nil, fmt.Errorf("the release's %s file is not one the Agent can take", platform)
		}
	}
	return &r, nil
}

// builtAt is this binary's build time, or zero for a build without one.
func builtAt() time.Time {
	t, err := time.Parse(time.RFC3339, BuiltAt)
	if err != nil {
		return time.Time{}
	}
	return t
}
