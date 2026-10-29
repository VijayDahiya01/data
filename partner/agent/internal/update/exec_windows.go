//go:build windows

package update

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
)

// activate swaps the service's program for the release's, keeping the old one
// beside it as oolix-agent.exe.old: Windows will not replace a running
// program, but it will rename one.
func activate(dir, bin string, rel *Release) error {
	exe, err := executable()
	if err != nil {
		return err
	}
	old := exe + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return fmt.Errorf("the Agent cannot replace its own program (%w): install new versions by hand", err)
	}
	if err := copyFile(bin, exe); err != nil {
		_ = os.Rename(old, exe)
		return err
	}
	return writeJSON(filepath.Join(dir, "starts.json"), starts{Version: rel.Version})
}

// Launch counts this start when this program is the release installed last.
// After maxStarts starts that did not prove healthy it puts the old program
// back and exits, for the service manager to start that one.
func Launch(stateDir string, logger *slog.Logger) {
	dir := filepath.Join(stateDir, "updates")
	if stateDir == "" {
		return
	}
	n, ok := readNext(dir)
	if !ok || !n.BuiltAt.Equal(builtAt()) {
		return
	}
	var s starts
	if !readJSON(filepath.Join(dir, "starts.json"), &s) || s.Version != n.Version {
		return // proved healthy already
	}
	if s.Count < maxStarts {
		s.Count++
		_ = writeJSON(filepath.Join(dir, "starts.json"), s)
		return
	}
	exe, err := executable()
	if err != nil {
		return
	}
	_ = os.Remove(exe + ".failed")
	if os.Rename(exe, exe+".failed") != nil || os.Rename(exe+".old", exe) != nil {
		logger.Error("the update keeps failing to start, and the previous version could not be put back")
		return
	}
	_ = putAside(dir, n.Version)
	logger.Error("the update failed to start three times; the previous version is back", "version", n.Version)
	os.Exit(1)
}

// Relaunch restarts the Agent into the program it has just installed: it
// exits as a failed service does, which the service's recovery settings
// (install-windows.ps1) answer by starting it again.
func Relaunch(string, *slog.Logger) { os.Exit(1) }

func executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	return out.Close()
}
