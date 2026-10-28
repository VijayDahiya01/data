//go:build !windows

package main

import "context"

// runAsService is for Windows. Elsewhere a service manager -- systemd, a
// container runtime -- stops the Agent with a signal, which run handles.
func runAsService(func(ctx context.Context) error) (handled bool, err error) {
	return false, nil
}
