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
	"syscall"
	"time"

	"github.com/SamsonIdowu/mabari/internal/config"
	"github.com/SamsonIdowu/mabari/internal/server"
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
	httpServer := &http.Server{
		Handler:           server.New(version, web.Files()),
		ReadHeaderTimeout: 10 * time.Second,
	}
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
