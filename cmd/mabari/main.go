// SPDX-License-Identifier: Apache-2.0

// Command mabari runs the Mabari server.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/SamsonIdowu/mabari/internal/config"
	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/server"
	"github.com/SamsonIdowu/mabari/internal/store"
	"github.com/SamsonIdowu/mabari/web"
)

// version is set at build time with -ldflags.
var version = "dev"

const usage = `Mabari shows your AI agents at work, in a little office.

Usage:
  mabari serve [flags]   Start Mabari (the default)
  mabari version         Print the version
`

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "mabari:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	command := "serve"
	if len(args) > 0 && args[0][0] != '-' {
		command, args = args[0], args[1:]
	}
	switch command {
	case "serve":
		return serve(args, stdout, stderr)
	case "version":
		_, err := fmt.Fprintln(stdout, version)
		return err
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
	httpServer := &http.Server{
		Handler: server.New(server.Options{
			Version:   version,
			Engine:    office.engine,
			Simulator: office.simulator,
			WebFiles:  web.Files(),
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go office.engine.Run(ctx)
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
	if err := httpServer.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

type office struct {
	store     *store.Store
	engine    *events.Engine
	simulator *simulator.Simulator
}

func openOffice(ctx context.Context, cfg config.Config) (*office, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data folder: %w", err)
	}
	// A folder needs its execute bit, so gosec's 0600 advice doesn't apply here.
	if err := os.Chmod(cfg.DataDir, 0o700); err != nil { // #nosec G302
		return nil, fmt.Errorf("protect data folder: %w", err)
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
	sim.Resume(demo == "1")
	return &office{store: database, engine: engine, simulator: sim}, nil
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
