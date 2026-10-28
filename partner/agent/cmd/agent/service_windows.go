//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/svc"
)

// serviceName is the Windows service the install script registers.
const serviceName = "OolixAgent"

// runAsService runs the Agent under the Windows service manager when it was
// started as a service, so Stop and a shutdown end it cleanly. handled is
// false when started any other way.
func runAsService(run func(ctx context.Context) error) (handled bool, err error) {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return false, err
	}
	logToStateFolder()
	return true, svc.Run(serviceName, serviceHandler{run: run})
}

// logToStateFolder sends the log to agent.log in the Agent's state folder: a
// service has no console, and the first start writes the setup page password
// to the log. The folder is readable by administrators only.
func logToStateFolder() {
	dir := os.Getenv("OOLIX_STATE_DIR")
	if dir == "" {
		return
	}
	path := filepath.Join(dir, "agent.log")
	if info, err := os.Stat(path); err == nil && info.Size() > 50<<20 {
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	os.Stdout, os.Stderr = f, f
}

type serviceHandler struct {
	run func(ctx context.Context) error
}

func (h serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.run(ctx) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case req := <-requests:
			switch req.Cmd {
			case svc.Interrogate:
				status <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			}
		case err := <-done:
			if err != nil {
				return false, 1
			}
			return false, 0
		}
	}
}
