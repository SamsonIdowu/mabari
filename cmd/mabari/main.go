// SPDX-License-Identifier: Apache-2.0

// Command mabari runs the Mabari server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/SamsonIdowu/mabari/internal/agentdefs"
	"github.com/SamsonIdowu/mabari/internal/config"
	"github.com/SamsonIdowu/mabari/internal/connectors/claudecode"
	"github.com/SamsonIdowu/mabari/internal/connectors/codex"
	"github.com/SamsonIdowu/mabari/internal/connectors/hub"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/launch"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/secrets"
	"github.com/SamsonIdowu/mabari/internal/server"
	"github.com/SamsonIdowu/mabari/internal/store"
	"github.com/SamsonIdowu/mabari/internal/whisper"
	"github.com/SamsonIdowu/mabari/web"
)

// version is set at build time with -ldflags.
var version = "dev"

const usage = `Mabari shows your AI agents at work, in a little office.

Usage:
  mabari serve [flags]        Start Mabari (the default)
  mabari connect claude       Add Mabari's hooks to Claude Code, after showing the change
  mabari disconnect claude    Take Mabari's hooks out of Claude Code again
  mabari hook <event>         Run by Claude Code itself; not for typing
  mabari service <action>     Run Mabari at login: install, uninstall, start, stop,
                              restart, status or logs
  mabari healthcheck          Ask a running Mabari whether it is well
  mabari access-key           Print the key browsers sign in with (--rotate makes a new one)
  mabari version              Print the version
`

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "mabari:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	command := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command, args = args[0], args[1:]
	}
	switch command {
	case "serve":
		return serve(args, stdout, stderr)
	case "version":
		_, err := fmt.Fprintln(stdout, version)
		return err
	case "healthcheck":
		return healthcheck(args, stdout, stderr)
	case "access-key":
		return accessKey(args, stdout, stderr)
	case "service":
		return runService(args, os.Stdin, stdout)
	case "hook":
		return runHook(args, os.Stdin, stdout)
	case "connect", "disconnect":
		if len(args) == 0 || args[0] != "claude" {
			return fmt.Errorf("usage: mabari %s claude", command)
		}
		if command == "connect" {
			return connectClaude(args[1:], os.Stdin, stdout)
		}
		return disconnectClaude(stdout)
	case "help":
		_, err := fmt.Fprint(stdout, usage)
		return err
	default:
		return fmt.Errorf("unknown command %q\n\n%s", command, usage)
	}
}

func serve(args []string, stdout, stderr io.Writer) error {
	cfg, err := config.Load(args, os.Getenv, stderr)
	if err != nil {
		return err
	}
	if cfg.PrintConfig {
		_, err := fmt.Fprint(stdout, cfg.Printable())
		return err
	}
	if level, err := cfg.Level(); err == nil {
		slog.SetLogLoggerLevel(level)
	}
	if cfg.LogFile != "" {
		logFile, err := openLogFile(cfg.LogFile, stderr)
		if err != nil {
			return err
		}
		defer func() { _ = logFile.Close() }()
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	listener, err := listen(ctx, cfg)
	if err != nil {
		return err
	}
	office, err := openOffice(ctx, cfg)
	if err != nil {
		return err
	}
	defer office.close(stderr)
	var login server.LoginService
	loginReason := ""
	if s, err := thisService(); err != nil {
		loginReason = err.Error()
	} else {
		login = s
	}
	inContainer := os.Getenv("MABARI_IN_CONTAINER") == "1"
	// The LAN listeners can start inside server.New, before it returns the handler, so they read
	// it through an atomic pointer.
	var handler atomic.Pointer[http.Handler]
	access := &server.Access{Secrets: office.secrets}
	network := &lan{port: cfg.Port, handler: func() http.Handler {
		if h := handler.Load(); h != nil {
			return *h
		}
		return nil
	}}
	if !inContainer && config.IsLoopback(cfg.Bind) {
		access.SetLAN = network.set
		// Browser tests switch LAN access without opening this computer to the network.
		if os.Getenv("MABARI_TEST_FAKE_LAN") == "1" {
			access.SetLAN = func(on bool) ([]string, error) {
				if on {
					return []string{"http://192.0.2.10:" + strconv.Itoa(cfg.Port)}, nil
				}
				return nil, nil
			}
		}
	}
	defer func() { _, _ = network.set(false) }()
	defs := agentLibrary(ctx, cfg, office)
	built := server.New(server.Options{
		Version:   version,
		Engine:    office.engine,
		Simulator: office.simulator,
		WebFiles:  web.Files(),
		Claude:    claudeOptions(cfg, office),
		Secrets:   office.secrets,
		Hub:       office.hub,
		Codex:     office.codex,
		Whisper:   whisper.New(filepath.Join(cfg.DataDir, "whisper"), whisper.Medium),
		Login:     login, LoginReason: loginReason, Defs: defs, Launcher: launcher(inContainer),
		Access: access, AnyHost: !config.IsLoopback(cfg.Bind),
	})
	handler.Store(&built)
	httpServer := &http.Server{Handler: built, ReadHeaderTimeout: 10 * time.Second}
	go office.engine.Run(ctx)
	go watchClaude(ctx, office)
	go func() {
		if err := office.codex.Launch(ctx); err != nil {
			slog.Info("Codex is not connected", "reason", err)
		}
	}()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdown); err != nil {
			_, _ = fmt.Fprintln(stderr, "mabari: shutdown:", err)
		}
	}()

	if _, err := fmt.Fprintf(stdout, "Mabari is running at http://%s\n", listener.Addr()); err != nil {
		return err
	}
	if !config.IsLoopback(cfg.Bind) {
		how := "mabari access-key"
		if inContainer {
			how = "docker compose exec mabari /mabari access-key"
		}
		_, _ = fmt.Fprintln(stderr, "mabari: listening beyond this computer, so browsers sign in with the access key. "+
			"See it with: "+how)
	}
	if err := httpServer.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

type office struct {
	store     *store.Store
	engine    *events.Engine
	simulator *simulator.Simulator
	secrets   secrets.Store
	claude    *claudecode.Connector
	hub       *hub.Connector
	codex     *codex.Connector
}

func openOffice(ctx context.Context, cfg config.Config) (*office, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data folder: %w", err)
	}
	// A folder needs its execute bit, so gosec's 0600 advice doesn't apply here.
	if err := os.Chmod(cfg.DataDir, 0o700); err != nil { // #nosec G302
		return nil, fmt.Errorf("protect data folder: %w", err)
	}
	masterKey, err := secrets.MasterKey(cfg.MasterKeyFile, os.Getenv)
	if err != nil {
		return nil, err
	}
	// Without a usable secret store Mabari refuses to start, rather than keep keys in plain text.
	vault, err := secrets.Open(secrets.Options{
		Backend: cfg.Secrets, DataDir: cfg.DataDir, MasterKey: masterKey,
	})
	if err != nil {
		return nil, err
	}
	database, err := store.Open(ctx, filepath.Join(cfg.DataDir, "mabari.db"))
	if err != nil {
		return nil, err
	}
	engine, err := events.New(ctx, database, nil)
	if err != nil {
		_ = database.Close()
		return nil, err
	}
	sim := simulator.New(engine, nil, time.Second)
	demo, err := database.Meta(ctx, store.MetaDemo)
	if err != nil {
		_ = database.Close()
		return nil, err
	}
	if err := sim.Resume(demo == "1"); err != nil {
		_ = database.Close()
		return nil, err
	}
	claude := claudecode.New(engine)
	engine.AddConnector(claudecode.Source, claude)
	_ = engine.Do(func() {
		claude.TidyNames()
		// Earlier versions stored the demo's pretend Claude Code connection. Without Mabari's
		// hooks in Claude Code's settings, nothing can be connected.
		if dir, err := claudecode.ConfigDir(os.Getenv); err == nil && !claudecode.Attached(dir) {
			for _, account := range engine.StoredAccounts() {
				if account.Kind == models.AccountClaudeCode && account.Status == models.AccountConnected {
					account.Status = models.AccountOff
					engine.SetAccount(account)
				}
			}
		}
	})
	hubConnector := hub.New(engine)
	engine.AddConnector(hub.Source, hubConnector)
	codexConnector := codex.New(engine, version)
	engine.AddConnector(codex.Source, codexConnector)
	return &office{
		store: database, engine: engine, simulator: sim, secrets: vault,
		claude: claude, hub: hubConnector, codex: codexConnector,
	}, nil
}

func (o *office) close(stderr io.Writer) {
	o.simulator.Stop()
	if err := o.store.Close(); err != nil {
		_, _ = fmt.Fprintln(stderr, "mabari: close database:", err)
	}
}

func listen(ctx context.Context, cfg config.Config) (net.Listener, error) {
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(ctx, "tcp", cfg.Address())
	if errors.Is(err, syscall.EADDRINUSE) {
		return nil, fmt.Errorf(
			"port %d is already in use, possibly by another Mabari or an OpenTelemetry collector. "+
				"Choose another with --port or MABARI_PORT", cfg.Port)
	}
	return listener, err
}

// agentLibrary reads the agent folders now and keeps watching them. Agent files are the source of
// truth, so a problem reading them is reported and Mabari carries on without the builder.
func agentLibrary(ctx context.Context, cfg config.Config, o *office) *agentdefs.Library {
	dir, err := claudecode.ConfigDir(os.Getenv)
	if err != nil {
		slog.Warn("the agent builder is off: no home folder", "error", err)
		return nil
	}
	home, _ := os.UserHomeDir()
	// Codex keeps its home in CODEX_HOME, or ~/.codex.
	codexHome := os.Getenv("CODEX_HOME")
	if codexHome == "" && home != "" {
		codexHome = filepath.Join(home, ".codex")
	}
	codexAgents := ""
	if codexHome != "" {
		codexAgents = filepath.Join(codexHome, "agents")
	}
	library := agentdefs.New(agentdefs.Folders{
		Account: filepath.Join(dir, "agents"),
		Codex:   codexAgents,
		State:   filepath.Join(cfg.DataDir, "agents-state.json"),
		Home:    home,
	})
	report, err := library.Refresh(o.engine)
	if err != nil {
		slog.Warn("could not read the agent folders", "error", err)
	}
	for _, problem := range report.Problems {
		slog.Warn("skipped an agent file", "problem", problem)
	}
	go library.Keep(ctx, o.engine, agentWatchEvery)
	return library
}

// agentWatchEvery is how often the agent folders are checked for changes.
const agentWatchEvery = 1500 * time.Millisecond

// launcher opens Claude Code in a terminal window, except in a container, which has none, and
// when MABARI_NO_TERMINAL=1, as in the end-to-end tests. Then Mabari says what to run instead.
func launcher(inContainer bool) launch.Launcher {
	if inContainer || os.Getenv("MABARI_NO_TERMINAL") == "1" {
		return nil
	}
	return launch.Terminal{}
}
