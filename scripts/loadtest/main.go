// SPDX-License-Identifier: Apache-2.0

// Command loadtest fills a running Mabari with 16 agents and 10,000 events through the hub API,
// while a WebSocket client watches, then reports throughput, latency, snapshot cost and the
// server's memory and CPU. Run it against a scratch Mabari, never one with your data:
//
//	go run ./scripts/loadtest -url http://127.0.0.1:4399 -pid <mabari pid>
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

func main() {
	base := flag.String("url", "http://127.0.0.1:4399", "the scratch Mabari to load")
	pid := flag.Int("pid", 0, "the server's process id, to measure memory and CPU")
	agents := flag.Int("agents", 16, "how many agents")
	events := flag.Int("events", 10000, "how many events")
	flag.Parse()
	if err := run(*base, *pid, *agents, *events); err != nil {
		fmt.Fprintln(os.Stderr, "loadtest:", err)
		os.Exit(1)
	}
}

func call(method, url, token string, body any) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequest(method, url, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	} else {
		request.Header.Set("Origin", strings.TrimSuffix(url[:strings.Index(url[8:], "/")+8], "/"))
	}
	return http.DefaultClient.Do(request)
}

func run(base string, pid, agents, events int) error {
	response, err := call(http.MethodPost, base+"/api/accounts/hub/token", "", nil)
	if err != nil {
		return err
	}
	var minted struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(response.Body).Decode(&minted)
	_ = response.Body.Close()
	if minted.Token == "" {
		return fmt.Errorf("no hub token: %s", response.Status)
	}

	// A WebSocket client counts every update, as a browser would receive them.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	options := &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {base}}}
	conn, _, err := websocket.Dial(ctx, strings.Replace(base, "http", "ws", 1)+"/ws", options) //nolint:bodyclose // The library closes it.
	if err != nil {
		return fmt.Errorf("websocket: %w", err)
	}
	conn.SetReadLimit(64 << 20)
	var received atomic.Int64
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
			received.Add(1)
		}
	}()

	for i := range agents {
		response, err := call(http.MethodPost, base+"/hub/v1/events", minted.Token, map[string]any{
			"agent": fmt.Sprintf("load-%02d", i), "name": fmt.Sprintf("Load %d", i), "state": "running", "task": "Load test",
		})
		if err != nil {
			return err
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("seat agent %d: %s", i, response.Status)
		}
	}

	var (
		mu        sync.Mutex
		latencies []time.Duration
		failures  atomic.Int64
		next      atomic.Int64
		wait      sync.WaitGroup
	)
	started := time.Now()
	for worker := range agents {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for {
				n := int(next.Add(1))
				if n > events {
					return
				}
				began := time.Now()
				response, err := call(http.MethodPost, base+"/hub/v1/events", minted.Token, map[string]any{
					"agent": fmt.Sprintf("load-%02d", worker), "state": "editing", "tool": "edit",
					"summary": "Edit file " + strconv.Itoa(n), "progress": float64(n%100) / 100,
				})
				if err != nil || response.StatusCode != http.StatusOK {
					failures.Add(1)
				}
				if response != nil {
					_ = response.Body.Close()
				}
				mu.Lock()
				latencies = append(latencies, time.Since(began))
				mu.Unlock()
			}
		}()
	}
	wait.Wait()
	elapsed := time.Since(started)
	slices.Sort(latencies)
	at := func(q float64) time.Duration { return latencies[int(q*float64(len(latencies)-1))] }
	fmt.Printf("events:     %d in %s (%.0f a second), %d failed\n", events, elapsed.Round(time.Millisecond),
		float64(events)/elapsed.Seconds(), failures.Load())
	fmt.Printf("latency:    p50 %s, p99 %s, max %s\n", at(0.5).Round(time.Microsecond), at(0.99).Round(time.Microsecond), latencies[len(latencies)-1].Round(time.Microsecond))

	time.Sleep(time.Second)
	fmt.Printf("websocket:  %d updates received, connection still open: %v\n", received.Load(), ctx.Err() == nil)

	began := time.Now()
	response, err = call(http.MethodGet, base+"/api/snapshot", "", nil)
	if err != nil {
		return err
	}
	size, _ := io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	fmt.Printf("snapshot:   %s, %d KB\n", time.Since(began).Round(time.Microsecond), size/1024)

	if pid > 0 {
		fmt.Printf("server:     %s after load\n", usage(pid))
		time.Sleep(10 * time.Second)
		fmt.Printf("server:     %s after 10 s idle\n", usage(pid))
	}
	return nil
}

// usage reads resident memory and CPU from ps, which macOS and Linux both have.
func usage(pid int) string {
	out, err := exec.Command("ps", "-o", "rss=,%cpu=", "-p", strconv.Itoa(pid)).Output() // #nosec G204 -- a number
	if err != nil {
		return "unknown"
	}
	fields := strings.Fields(string(out))
	if len(fields) < 2 {
		return "unknown"
	}
	rss, _ := strconv.Atoi(fields[0])
	return fmt.Sprintf("%d MB resident, %s%% CPU", rss/1024, fields[1])
}
