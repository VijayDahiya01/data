// Command release signs the Agent's releases, so Agents can update themselves
// (docs/DEPLOY-PARTNER-AGENT.md, "Updates"):
//
//	release keygen
//	    prints a new key pair: the private key for the
//	    AGENT_RELEASE_SIGNING_KEY secret, the public one for the
//	    AGENT_RELEASE_PUBLIC_KEY variable
//	release manifest -version V -built-at T -out release.json FILE...
//	    lists the binaries -- named oolix-agent-<os>-<arch>, .exe on
//	    Windows -- with their sizes and SHA-256
//	release sign -out release.json.sig release.json
//	    signs it with the private key in AGENT_RELEASE_SIGNING_KEY
//	release verify -key PUBLIC release.json release.json.sig
//	    checks a release as an Agent will
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/oolix/partner-agent/internal/update"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Getenv); err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer, getenv func(string) string) error {
	if len(args) == 0 {
		return errors.New("usage: release keygen | manifest | sign | verify")
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	switch args[0] {
	case "keygen":
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		fmt.Fprintf(stdout, "AGENT_RELEASE_SIGNING_KEY=%s\nAGENT_RELEASE_PUBLIC_KEY=%s\n",
			base64.StdEncoding.EncodeToString(priv.Seed()), base64.StdEncoding.EncodeToString(pub))
		return nil

	case "manifest":
		version := fs.String("version", "", "the release's version: the commit it was built from")
		built := fs.String("built-at", "", "when that commit was made, RFC 3339")
		out := fs.String("out", "release.json", "where to write it")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		at, err := time.Parse(time.RFC3339, *built)
		if err != nil || *version == "" || fs.NArg() == 0 {
			return errors.New("manifest needs -version, -built-at (RFC 3339) and the binaries")
		}
		rel := update.Release{Version: *version, BuiltAt: at.UTC(), Files: map[string]update.File{}}
		for _, path := range fs.Args() {
			name := filepath.Base(path)
			platform, ok := strings.CutPrefix(strings.TrimSuffix(name, ".exe"), "oolix-agent-")
			if !ok || !strings.Contains(platform, "-") {
				return fmt.Errorf("%s is not named oolix-agent-<os>-<arch>", name)
			}
			b, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			sum := sha256.Sum256(b)
			rel.Files[platform] = update.File{Name: name, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(b))}
		}
		b, err := json.MarshalIndent(rel, "", "  ")
		if err != nil {
			return err
		}
		return os.WriteFile(*out, append(b, '\n'), 0o644)

	case "sign":
		out := fs.String("out", "release.json.sig", "where to write the signature")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(getenv("AGENT_RELEASE_SIGNING_KEY")))
		if err != nil || len(seed) != ed25519.SeedSize || fs.NArg() != 1 {
			return errors.New("sign needs the manifest, and AGENT_RELEASE_SIGNING_KEY from release keygen")
		}
		manifest, err := os.ReadFile(fs.Arg(0))
		if err != nil {
			return err
		}
		return os.WriteFile(*out, update.Sign(ed25519.NewKeyFromSeed(seed), manifest), 0o644)

	case "verify":
		key := fs.String("key", "", "the release public key, base64")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		pub, err := update.Key(*key)
		if err != nil || fs.NArg() != 2 {
			return errors.New("verify needs -key and the manifest and its signature")
		}
		manifest, err := os.ReadFile(fs.Arg(0))
		if err != nil {
			return err
		}
		sig, err := os.ReadFile(fs.Arg(1))
		if err != nil {
			return err
		}
		rel, err := update.Open(pub, manifest, sig)
		if err != nil {
			return err
		}
		fmt.Fprintf(stdout, "Signed: release %s, built %s, %d binaries.\n", rel.Version,
			rel.BuiltAt.Format(time.RFC3339), len(rel.Files))
		return nil
	}
	return fmt.Errorf("unknown command %q", args[0])
}
