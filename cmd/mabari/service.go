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
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/service"
)

const serviceUsage = "usage: mabari service install|uninstall|start|stop|restart|status|logs"

// serviceBinary is the mabari the service runs. A name found on PATH is kept as it is, so a
// Homebrew or Scoop link keeps working after an upgrade moves the real file.
func serviceBinary() (string, error) {
	path := ""
	if name := os.Args[0]; !strings.ContainsRune(name, filepath.Separator) {
		if found, err := exec.LookPath(name); err == nil {
			path = found
		}
	}
	if path == "" {
		executable, err := os.Executable()
		if err != nil {
			return "", err
		}
		path = executable
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if strings.Contains(path, string(filepath.Separator)+"go-build") {
		return "", errors.New("install the service from a built mabari, not `go run`, " +
			"because the service must find this program again at every login")
	}
	return path, nil
}

// thisService describes the service for the logged-in user on this computer.
func thisService() (service.Service, error) {
	if os.Getenv("MABARI_IN_CONTAINER") == "1" {
		return service.Service{}, errors.New("inside Docker, compose's restart policy runs Mabari instead")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return service.Service{}, err
	}
	binary, err := serviceBinary()
	if err != nil {
		return service.Service{}, err
	}
	return service.Service{
		OS: runtime.GOOS, Home: home, AppData: os.Getenv("APPDATA"), ConfigHome: os.Getenv("XDG_CONFIG_HOME"),
		UID: os.Getuid(), Binary: binary, Env: service.Environment(os.Getenv), Run: service.Exec,
	}, nil
}

// runService is `mabari service <action>`.
func runService(args []string, stdin io.Reader, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New(serviceUsage)
	}
	action, args := args[0], args[1:]
	flags := flag.NewFlagSet("service "+action, flag.ContinueOnError)
	yes := flags.Bool("yes", false, "install without asking")
	lines := flags.Int("lines", 50, "how many log lines to show")
	if err := flags.Parse(args); err != nil {
		return err
	}
	s, err := thisService()
	if err != nil {
		return err
	}
	ctx := context.Background()
	switch action {
	case "install":
		file, err := s.File()
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(stdout, "Mabari will write %s:\n\n%s\n", file.Path, file.Show)
		if !*yes && !confirm(stdin, stdout, "Install Mabari to start at login?") {
			_, err := fmt.Fprintln(stdout, "Nothing was changed.")
			return err
		}
		if err := s.Enable(ctx, true); err != nil {
			return err
		}
		_, err = fmt.Fprintf(stdout, "Installed. Mabari starts at login and is starting now. Logs: %s\n", s.LogPath())
		if err == nil && runtime.GOOS == "linux" {
			_, err = fmt.Fprintln(stdout, "To keep it running after you log out, run: loginctl enable-linger "+os.Getenv("USER"))
		}
		return err
	case "uninstall":
		if err := s.Disable(ctx, true); err != nil {
			return err
		}
		_, err := fmt.Fprintln(stdout, "Uninstalled. Mabari no longer starts at login. Your data is kept.")
		return err
	case "start", "stop", "restart":
		act := map[string]func(context.Context) error{"start": s.Start, "stop": s.Stop, "restart": s.Restart}[action]
		if err := act(ctx); err != nil {
			return err
		}
		_, err := fmt.Fprintln(stdout, "Done.")
		return err
	case "status":
		_, err := fmt.Fprintln(stdout, s.Status(ctx).Detail)
		return err
	case "logs":
		return tail(s.LogPath(), *lines, stdout)
	default:
		return errors.New(serviceUsage)
	}
}

// tail prints the last lines of the log.
func tail(path string, count int, stdout io.Writer) error {
	file, err := os.Open(path) // #nosec G304 -- the service's own log
	if errors.Is(err, os.ErrNotExist) {
		_, err := fmt.Fprintln(stdout, "No log yet at", path)
		return err
	}
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	var kept []string
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		kept = append(kept, scanner.Text())
		if len(kept) > count {
			kept = kept[1:]
		}
	}
	for _, line := range kept {
		if _, err := fmt.Fprintln(stdout, line); err != nil {
			return err
		}
	}
	return scanner.Err()
}
