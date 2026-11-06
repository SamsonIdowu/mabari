// SPDX-License-Identifier: Apache-2.0

//go:build windows

package claudecode

import (
	"os"
	"os/exec"
)

// Windows has no signals to send, so every way of ending a process is Kill. Sessions still resume,
// because Claude Code keeps the transcript as it goes.

func ownGroup(*exec.Cmd) {}

func interruptProcess(process *os.Process) error { return process.Kill() }

func terminateProcess(process *os.Process) error { return process.Kill() }

func killGroup(process *os.Process) { _ = process.Kill() }

// endLeftover does nothing here: there is no plain way to read another process's command line, so
// Mabari can't prove a process is the session's and leaves it alone.
func endLeftover(int, string) {}
