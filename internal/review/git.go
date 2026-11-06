// SPDX-License-Identifier: Apache-2.0

// Package review reads what changed in a folder, for the review view. It only reads. Git is run by
// name with a list of arguments and never through a shell, only in a folder Mabari already knows
// for an agent or a project, and nothing a request says reaches a command line. It offers no
// commit, push, checkout or discard.
package review

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// A call to Git gives up after callWait, and a read as a whole after readWait.
const (
	callWait = 10 * time.Second
	readWait = 25 * time.Second
	// maxGit is how many Git programs run at once, so a page asking often can't start a crowd.
	maxGit = 4
	// stderrKept is as much of Git's complaint as is kept.
	stderrKept = 4096
)

// hardening is put before every Git command. A repository can carry its own settings, and a
// folder an agent worked in is not one to trust: these keep Git from running programs a setting
// names, or from writing anything. Command-line settings beat the repository's, the user's and the
// system's.
//
//   - core.fsmonitor is a program Git runs for status and diff.
//   - diff.autoRefreshIndex is Git's own rewrite of the index to cache what it found.
//   - safe.bareRepository stops Git from taking a bare repository inside the folder as its own.
//   - color and pager settings can't change what is printed.
//
// Every diff also gets --no-ext-diff and --no-textconv, so a program named by a repository's diff
// settings is never run.
var hardening = []string{
	"--no-pager",
	"--no-optional-locks",
	"--literal-pathspecs",
	"-c", "core.fsmonitor=false",
	"-c", "core.hooksPath=" + os.DevNull,
	"-c", "diff.autoRefreshIndex=false",
	"-c", "safe.bareRepository=explicit",
	"-c", "status.aheadBehind=false",
	"-c", "core.quotePath=false",
	"-c", "color.ui=false",
}

// environment is the process's own, without anything Git reads to find a repository or to change
// how it behaves, so a variable set for Mabari can't point it at another repository.
func environment() []string {
	var env []string
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		upper := strings.ToUpper(name)
		if strings.HasPrefix(upper, "GIT_") || upper == "PAGER" || upper == "LC_ALL" {
			continue
		}
		env = append(env, entry)
	}
	return append(env,
		"GIT_TERMINAL_PROMPT=0",
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_PAGER=cat",
		"GIT_ATTR_NOSYSTEM=1",
		"LC_ALL=C",
	)
}

// result is what a Git call printed.
type result struct {
	out []byte
	// cut is true when the output was longer than asked for and the command was stopped.
	cut    bool
	stderr string
	code   int
}

// run runs Git in dir with args, keeping at most limit bytes of its output. A command that prints
// more is stopped, and its output so far is kept, cut. A failing exit isn't an error: code says
// what it was, and err is only for not being able to run Git at all or for taking too long.
func (r *Reader) run(ctx context.Context, dir string, limit int, args ...string) (result, error) {
	select {
	case r.gate <- struct{}{}:
		defer func() { <-r.gate }()
	case <-ctx.Done():
		return result{}, ctx.Err()
	}
	wait := r.wait
	if wait == 0 {
		wait = callWait
	}
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	// The arguments are Mabari's own and what git printed earlier, never text from a request.
	cmd := exec.CommandContext(ctx, r.git, append(append([]string{}, hardening...), args...)...) // #nosec G204 -- no shell, fixed options
	cmd.Dir = dir
	cmd.Env = environment()
	cmd.WaitDelay = 2 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return result{}, err
	}
	var stderr cappedBuffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return result{}, err
	}
	out, readErr := io.ReadAll(io.LimitReader(stdout, int64(limit)+1))
	cut := len(out) > limit
	if cut {
		out = out[:limit]
		cancel() // Enough: stop it rather than wait for the rest.
	}
	waitErr := cmd.Wait()
	res := result{out: out, cut: cut, stderr: strings.TrimSpace(stderr.String())}
	switch {
	case cut:
		return res, nil
	// A command that ran out of time has its pipe closed under the read, so the time is the cause.
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return res, errTooSlow
	case ctx.Err() != nil:
		return res, ctx.Err()
	case readErr != nil:
		return res, readErr
	}
	var exit *exec.ExitError
	if errors.As(waitErr, &exit) {
		res.code = exit.ExitCode()
		return res, nil
	}
	return res, waitErr
}

var errTooSlow = errors.New("git took too long")

// cappedBuffer keeps the first stderrKept bytes written to it and drops the rest.
type cappedBuffer struct{ buf bytes.Buffer }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := stderrKept - b.buf.Len(); room > 0 {
		b.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

func (b *cappedBuffer) String() string { return b.buf.String() }
