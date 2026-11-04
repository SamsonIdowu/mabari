// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/SamsonIdowu/mabari/internal/config"
	"gopkg.in/natefinch/lumberjack.v2"
)

// healthcheck asks a running Mabari whether it is well. Docker runs it, because the distroless
// image has no curl. It always asks 127.0.0.1, whatever address Mabari listens on.
func healthcheck(args []string, stdout, stderr io.Writer) error {
	cfg, err := config.Load(args, os.Getenv, stderr)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	url := "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)) + "/api/health"
	version, err := checkHealth(ctx, url)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, "Mabari", version, "is well")
	return err
}

func checkHealth(ctx context.Context, url string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("nothing is answering on that port: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	var body struct {
		OK      bool   `json:"ok"`
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&body); err != nil ||
		response.StatusCode != http.StatusOK || !body.OK {
		return "", fmt.Errorf("unhealthy: the server answered %s", response.Status)
	}
	return body.Version, nil
}

// openLogFile sends the log to stderr and to a rotated file as well. The local service uses it,
// since a LaunchAgent or scheduled task has no terminal to show stderr.
func openLogFile(path string, stderr io.Writer) (io.Closer, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create log folder: %w", err)
	}
	file := &lumberjack.Logger{Filename: path, MaxSize: 10, MaxBackups: 3, MaxAge: 28}
	log.SetOutput(io.MultiWriter(stderr, file))
	return file, nil
}
