// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/config"
	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/secrets"
	"github.com/SamsonIdowu/mabari/internal/server"
)

// openSecrets opens the secret store the way serve does, for the hook and connect commands.
func openSecrets(cfg config.Config) (secrets.Store, error) {
	masterKey, err := secrets.MasterKey(cfg.MasterKeyFile, os.Getenv)
	if err != nil {
		return nil, err
	}
	return secrets.Open(secrets.Options{Backend: cfg.Secrets, DataDir: cfg.DataDir, MasterKey: masterKey})
}

// hookBinary is the path written into settings.json: this binary, with links resolved.
func hookBinary() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	if strings.Contains(path, string(filepath.Separator)+"go-build") {
		return "", errors.New("run `mabari connect claude` from a built binary, not `go run`, " +
			"because the hook must find this program again")
	}
	return path, nil
}

// actionBlocked says a hook that gates an action couldn't reach Mabari. It exits with 2, which is
// how a hook tells Claude Code to block the action.
type actionBlocked struct{ event string }

func (b actionBlocked) Error() string {
	return "couldn't reach Mabari, so " + b.event + " was blocked rather than left to go ahead"
}

// runHook is `mabari hook [--port N] <event>`, which Claude Code runs. It never fails: any
// problem leaves Claude Code's normal behaviour in place. With --run, which Mabari passes to
// sessions it runs, a problem blocks an action instead of letting it go ahead.
func runHook(args []string, stdin io.Reader, stdout io.Writer) error {
	flags := flag.NewFlagSet("hook", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	port := flags.Int("port", config.DefaultPort, "Mabari's port")
	tokenFile := flags.String("token-file", "", "read the token from this file")
	session := flags.Bool("run", false, "the hook of a session Mabari runs")
	if flags.Parse(args) != nil || flags.NArg() != 1 {
		return nil
	}
	event := flags.Arg(0)
	call := func(token func() (string, error)) error {
		if !*session {
			claudecode.RunHook(event, *port, stdin, stdout, token)
			return nil
		}
		if !claudecode.RunSessionHook(event, *port, stdin, stdout, token) && claudecode.Gates(event) {
			return actionBlocked{event}
		}
		return nil
	}
	if *tokenFile != "" {
		return call(func() (string, error) { return claudecode.ReadTokenFile(*tokenFile) })
	}
	cfg, err := config.Load(nil, os.Getenv, io.Discard)
	if err != nil {
		if *session && claudecode.Gates(event) {
			return actionBlocked{event}
		}
		return nil
	}
	return call(func() (string, error) {
		store, err := openSecrets(cfg)
		if err != nil {
			return "", err
		}
		return store.Get(claudecode.TokenName)
	})
}

// connectClaude is `mabari connect claude`: it shows the change to settings.json, asks, backs up
// and writes it.
func connectClaude(args []string, stdin io.Reader, stdout io.Writer) error {
	flags := flag.NewFlagSet("connect claude", flag.ContinueOnError)
	yes := flags.Bool("yes", false, "make the change without asking")
	tokenFile := flags.String("token-file", "", "keep the hook token in this file, for Mabari in Docker")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *tokenFile != "" {
		absolute, err := filepath.Abs(expandHome(*tokenFile))
		if err != nil {
			return err
		}
		*tokenFile = absolute
	}
	cfg, err := config.Load(nil, os.Getenv, io.Discard)
	if err != nil {
		return err
	}
	binary, err := hookBinary()
	if err != nil {
		return err
	}
	dir, err := claudecode.ConfigDir(os.Getenv)
	if err != nil {
		return err
	}
	plan, err := claudecode.PlanAttach(dir, claudecode.Hook{Binary: binary, Port: cfg.Port, TokenFile: *tokenFile})
	if err != nil {
		return err
	}
	if !plan.Changed() {
		_, err := fmt.Fprintln(stdout, "Claude Code is already connected.")
		return err
	}
	printPlan(stdout, plan)
	if !*yes && !confirm(stdin, stdout, "Change "+plan.Path+"?") {
		_, err := fmt.Fprintln(stdout, "Nothing was changed.")
		return err
	}
	if *tokenFile != "" {
		if err := claudecode.EnsureTokenFile(*tokenFile); err != nil {
			return err
		}
	} else {
		store, err := openSecrets(cfg)
		if err != nil {
			return err
		}
		if err := claudecode.EnsureToken(store); err != nil {
			return err
		}
	}
	if err := claudecode.Apply(plan); err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "Connected. The original is saved as %s%s. New Claude Code sessions take a desk.\n",
		plan.Path, claudecode.BackupSuffix)
	return err
}

// disconnectClaude is `mabari disconnect claude`: it takes Mabari's hooks out again.
func disconnectClaude(stdout io.Writer) error {
	cfg, err := config.Load(nil, os.Getenv, io.Discard)
	if err != nil {
		return err
	}
	dir, err := claudecode.ConfigDir(os.Getenv)
	if err != nil {
		return err
	}
	binary, _ := hookBinary() // hooks it wrote under another name are found too
	plan, err := claudecode.PlanDetach(dir, binary)
	if err != nil {
		return err
	}
	if err := claudecode.Apply(plan); err != nil {
		return err
	}
	if store, err := openSecrets(cfg); err == nil {
		_ = store.Delete(claudecode.TokenName)
	}
	_, err = fmt.Fprintln(stdout, "Disconnected. Mabari's hooks are out of "+plan.Path+".")
	return err
}

func printPlan(stdout io.Writer, plan claudecode.Plan) {
	_, _ = fmt.Fprintf(stdout, "Mabari will add its hooks to %s:\n\n", plan.Path)
	for _, line := range plan.Diff {
		mark := "  "
		switch line.Kind {
		case "add":
			mark = "+ "
		case "del":
			mark = "- "
		}
		_, _ = fmt.Fprintln(stdout, mark+line.Text)
	}
	_, _ = fmt.Fprintln(stdout)
}

func confirm(stdin io.Reader, stdout io.Writer, question string) bool {
	_, _ = fmt.Fprint(stdout, question+" [y/N] ")
	answer, _ := bufio.NewReader(stdin).ReadString('\n')
	answer = strings.ToLower(strings.TrimSpace(answer))
	return answer == "y" || answer == "yes"
}

// HookTokenSecret is where Docker mounts the hook token shared with Claude Code on the host.
const HookTokenSecret = "/run/secrets/mabari_hook_token" // #nosec G101 -- a path, not a credential

// claudeOptions turns on the Claude Code routes. A container can't reach the host's settings, so
// there the Accounts page shows the host command instead (Stage 11).
func claudeOptions(cfg config.Config, o *office) *server.ClaudeOptions {
	if os.Getenv("MABARI_IN_CONTAINER") == "1" && os.Getenv("MABARI_AGENTS_IMAGE") != "1" {
		// Claude Code on the host reports here when the hook token is shared as a Docker secret.
		if _, err := claudecode.ReadTokenFile(HookTokenSecret); err != nil {
			return nil
		}
		return &server.ClaudeOptions{Connector: o.claude, Secrets: o.secrets, TokenFile: HookTokenSecret}
	}
	dir, err := claudecode.ConfigDir(os.Getenv)
	if err != nil {
		return nil
	}
	// Questions are shown only while the hooks there wait long enough for an answer.
	o.claude.ConfigDir = dir
	// Under `go run` there is no binary to point at, so Connect explains, but hooks still report.
	binary, err := hookBinary()
	if err != nil {
		binary = ""
	}
	o.claude.HookBinary = binary
	return &server.ClaudeOptions{
		Connector: o.claude, Secrets: o.secrets, ConfigDir: dir,
		Hook: claudecode.Hook{Binary: binary, Port: cfg.Port},
	}
}

// watchClaude checks every half minute whether hooks have stopped reporting.
func watchClaude(ctx context.Context, o *office) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			_ = o.engine.Do(func() { o.claude.CheckStale(now) })
		}
	}
}

// expandHome turns a leading ~ into the home folder, since a quoted ~ reaches us unexpanded.
func expandHome(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(path, "~"))
		}
	}
	return path
}
