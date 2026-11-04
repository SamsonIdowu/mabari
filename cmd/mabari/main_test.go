// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"io"
	"net"
	"os"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/config"
)

func TestVersion(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"version"}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out.String()) != version {
		t.Errorf("output = %q", out.String())
	}
}

func TestUnknownCommand(t *testing.T) {
	err := run([]string{"nope"}, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), `unknown command "nope"`) {
		t.Errorf("err = %v", err)
	}
}

// --help prints the flags and is not an error, and an empty argument is an unknown command.
func TestHelpAndEmptyArgument(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"--help"}, io.Discard, &out); !errors.Is(err, flag.ErrHelp) {
		t.Errorf("--help err = %v", err)
	}
	if !strings.Contains(out.String(), "-port") {
		t.Errorf("--help output = %q", out.String())
	}
	if err := run([]string{""}, io.Discard, io.Discard); err == nil ||
		!strings.Contains(err.Error(), "unknown command") {
		t.Errorf("empty argument err = %v", err)
	}
}

func TestPrintConfigWithoutACommandMeansServe(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"--print-config"}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "bind=") {
		t.Errorf("output = %q", out.String())
	}
}

func TestListenExplainsAPortThatIsTaken(t *testing.T) {
	var listenConfig net.ListenConfig
	taken, err := listenConfig.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("binding a local port is not allowed here: %v", err)
	}
	defer func() { _ = taken.Close() }()

	port := taken.Addr().(*net.TCPAddr).Port
	_, err = listen(context.Background(), config.Config{Bind: "127.0.0.1", Port: port})
	if err == nil || !strings.Contains(err.Error(), "--port or MABARI_PORT") {
		t.Errorf("err = %v", err)
	}
}

func TestMain(m *testing.M) {
	// Keep tests away from any real configuration on this machine.
	for _, key := range []string{"MABARI_BIND", "MABARI_PORT", "MABARI_DATA_DIR", "MABARI_SECRETS"} {
		_ = os.Unsetenv(key)
	}
	os.Exit(m.Run())
}
