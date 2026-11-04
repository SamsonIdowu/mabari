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

// runHook is `mabari hook [--port N] <event>`, which Claude Code runs. It never fails: any
// problem leaves Claude Code's normal behaviour in place.
func runHook(args []string, stdin io.Reader, stdout io.Writer) error {
	flags := flag.NewFlagSet("hook", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	port := flags.Int("port", config.DefaultPort, "Mabari's port")
	if flags.Parse(args) != nil || flags.NArg() != 1 {
		return nil
	}
	cfg, err := config.Load(nil, os.Getenv, io.Discard)
	if err != nil {
		return nil
	}
	token := func() (string, error) {
		store, err := openSecrets(cfg)
		if err != nil {
			return "", err
		}
		return store.Get(claudecode.TokenName)
	}
	claudecode.RunHook(flags.Arg(0), *port, stdin, stdout, token)
	return nil
}

// connectClaude is `mabari connect claude`: it shows the change to settings.json, asks, backs up
// and writes it.
func connectClaude(args []string, stdin io.Reader, stdout io.Writer) error {
	flags := flag.NewFlagSet("connect claude", flag.ContinueOnError)
	yes := flags.Bool("yes", false, "make the change without asking")
	if err := flags.Parse(args); err != nil {
		return err
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
	plan, err := claudecode.PlanAttach(dir, claudecode.Hook{Binary: binary, Port: cfg.Port})
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
	store, err := openSecrets(cfg)
	if err != nil {
		return err
	}
	if err := claudecode.EnsureToken(store); err != nil {
		return err
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
	plan, err := claudecode.PlanDetach(dir)
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

// claudeOptions turns on the Claude Code routes. A container can't reach the host's settings, so
// there the Accounts page shows the host command instead (Stage 11).
func claudeOptions(cfg config.Config, o *office) *server.ClaudeOptions {
	if os.Getenv("MABARI_IN_CONTAINER") == "1" {
		return nil
	}
	dir, err := claudecode.ConfigDir(os.Getenv)
	if err != nil {
		return nil
	}
	// Under `go run` there is no binary to point at, so Connect explains, but hooks still report.
	binary, err := hookBinary()
	if err != nil {
		binary = ""
	}
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
