// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package claudecode

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ownGroup puts the process in a process group of its own, so what it starts can be ended with it.
func ownGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// interruptProcess ends the turn in progress, as Claude Code's docs say SIGINT does.
func interruptProcess(process *os.Process) error { return process.Signal(os.Interrupt) }

// terminateProcess asks the process to end. It stops the commands it runs and exits by itself.
func terminateProcess(process *os.Process) error { return process.Signal(syscall.SIGTERM) }

// killGroup ends the process and everything it started, for one that didn't end when asked.
func killGroup(process *os.Process) { _ = syscall.Kill(-process.Pid, syscall.SIGKILL) }

// endLeftover ends a session's process left behind by a crash, so a resume never runs beside it.
// The session id on its command line proves it is that process and not another that was given the
// same number since.
func endLeftover(pid int, session string) {
	if pid <= 0 || session == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output() // #nosec G204 -- a fixed program and a number
	if err != nil || !strings.Contains(string(out), session) {
		return
	}
	_ = syscall.Kill(pid, syscall.SIGTERM)
}
