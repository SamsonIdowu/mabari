// SPDX-License-Identifier: Apache-2.0

// Command fakeclaude stands in for the claude program in tests, so no test ever spends the
// person's account or reads their configuration. Built as `claude` and put first on PATH, it
// speaks what Claude Code 2.1.318 documents for `claude -p` with stream-json in and out, runs the
// hooks it is given, and follows the documented permission rules:
//
//   - PreToolUse hooks run first. Exit 2 or "deny" blocks the call; deny beats ask beats allow.
//   - A call that needs approval runs only if a PermissionRequest hook says allow. With no decision
//     it is denied, because a -p run has nobody to ask.
//   - Without --permission-mode a run starts in default (Manual) mode.
//
// It refuses every flag Mabari must never pass, so a mistake fails the test rather than a person.
// An action that really runs appends a line to $FAKE_CLAUDE_RAN, which is how a test proves a
// denied action never happened.
//
// What it does in a turn depends on the message:
//
//	fake:bash <command>     a Bash call that needs approval
//	fake:allowed <command>  a Bash call an allow rule already covers
//	fake:hook-allowed <cmd> a Bash call a repository's PreToolUse hook has already allowed
//	fake:edit <path>        a Write call that needs approval
//	fake:read <path>        a Read call that needs no approval
//	fake:slow <words>       streams that many words, slowly
//	fake:hang               works until interrupted
//	fake:late <text>        reports Stop, then writes its reply once $FAKE_HOOK_DIR/gate exists
//	fake:trail <text>       works until interrupted, then writes that once the gate exists
//	fake:stall              says half a reply, then never finishes, whatever it is told
//	fake:big <bytes>        says that many bytes in one message
//	fake:silent             sends a message with no text in it
//	fake:secret             says a secret split across two deltas
//	fake:error <text>       ends the turn with an error result
//	fake:crash              dies mid-turn
//	anything else           replies "Done: <message>"
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// forbidden are the flags that would take a person's click away.
var forbidden = map[string]bool{
	"--dangerously-skip-permissions": true, "--allow-dangerously-skip-permissions": true,
	"--allowedTools": true, "--allowed-tools": true, "--bare": true,
}

type hookHandler struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Timeout int      `json:"timeout"`
}

type hookGroup struct {
	Matcher string        `json:"matcher"`
	Hooks   []hookHandler `json:"hooks"`
}

type settings struct {
	Hooks map[string][]hookGroup `json:"hooks"`
}

type fake struct {
	session    string
	mode       string
	model      string
	cwd        string
	transcript string
	hooks      map[string][]hookGroup
	out        *bufio.Writer
	outMu      sync.Mutex
	started    bool
	turns      float64

	interrupted chan struct{}
}

func main() {
	if code := run(os.Args[1:]); code != 0 {
		os.Exit(code)
	}
}

// hookBridge stands in for `mabari hook` where a test can't listen on a port. It leaves the call in
// a file named for its event, waits for the reply file, and prints it. A reply of "exit 2" exits 2.
// hookBridgeWait is the most a hook waits for its test to answer.
const hookBridgeWait = 5 * time.Minute

func hookBridge(args []string) int {
	dir := os.Getenv("FAKE_HOOK_DIR")
	if dir == "" {
		return 0
	}
	body, err := io.ReadAll(os.Stdin)
	if err != nil {
		return 1
	}
	kind := "settings"
	for _, arg := range args {
		if arg == "--run" {
			kind = "run"
		}
	}
	name := filepath.Join(dir, newUUID()+"."+kind+"."+args[len(args)-1])
	if err := os.WriteFile(name+".tmp", body, 0o600); err != nil { // #nosec G304,G703 -- a test double, using paths its test gave it
		return 1
	}
	if err := os.Rename(name+".tmp", name+".call"); err != nil { // #nosec G304,G703 -- a test double, using paths its test gave it
		return 1
	}
	// A test that has ended answers nobody, and its folder goes with it. Waiting on would leave this
	// process behind, polling for good.
	for deadline := time.Now().Add(hookBridgeWait); time.Now().Before(deadline); {
		reply, err := os.ReadFile(name + ".reply") // #nosec G304,G703 -- a test double, using paths its test gave it
		if err == nil {
			if string(reply) == "exit 2" {
				return 2
			}
			_, _ = os.Stdout.Write(reply)
			return 0
		}
		if _, err := os.Stat(dir); err != nil {
			return 1
		}
		time.Sleep(5 * time.Millisecond)
	}
	return 1
}

func run(args []string) int {
	if len(args) > 0 && (args[0] == "--version" || args[0] == "-v") {
		fmt.Println("2.1.318 (fake Claude Code)")
		return 0
	}
	if len(args) > 0 && args[0] == "hook" {
		return hookBridge(args)
	}
	options := map[string]string{}
	boolean := map[string]bool{"-p": true, "--print": true, "--verbose": true, "--include-partial-messages": true}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if forbidden[arg] {
			fmt.Fprintln(os.Stderr, "fake claude: refusing "+arg)
			return 9
		}
		if boolean[arg] {
			options[arg] = "true"
			continue
		}
		if strings.HasPrefix(arg, "-") && index+1 < len(args) {
			options[arg] = args[index+1]
			index++
		}
	}
	switch {
	case options["-p"] == "":
		fmt.Fprintln(os.Stderr, "fake claude: only -p is faked")
		return 9
	case options["--input-format"] != "stream-json" || options["--output-format"] != "stream-json":
		fmt.Fprintln(os.Stderr, "fake claude: only stream-json is faked")
		return 9
	case options["--verbose"] == "":
		fmt.Fprintln(os.Stderr, "Error: When using --print, --output-format=stream-json requires --verbose")
		return 1
	case options["--permission-prompts"] != "none":
		fmt.Fprintln(os.Stderr, "fake claude: Mabari must pass --permission-prompts none")
		return 9
	}
	mode := options["--permission-mode"]
	if mode == "" {
		mode = "default"
	}
	if mode != "default" && mode != "plan" {
		fmt.Fprintln(os.Stderr, "fake claude: refusing permission mode "+mode)
		return 9
	}
	cwd, _ := os.Getwd()
	f := &fake{
		mode: mode, model: options["--model"], cwd: cwd, out: bufio.NewWriter(os.Stdout),
		hooks: map[string][]hookGroup{}, interrupted: make(chan struct{}, 1),
	}
	if f.model == "" {
		f.model = "claude-sonnet-4-5"
	}
	f.loadHooks(options["--settings"])
	f.session = options["--session-id"]
	resuming := options["--resume"] != ""
	if resuming {
		f.session = options["--resume"]
	}
	if f.session == "" {
		f.session = newUUID()
	}
	f.transcript = transcriptPath(f.session, cwd)
	if resuming {
		if _, err := os.Stat(f.transcript); err != nil {
			fmt.Fprintln(os.Stderr, "No conversation found with session ID: "+f.session)
			return 1
		}
	}
	recordArgs(f.session, args)
	return f.serve()
}

// recordArgs keeps the command line, so a test can see exactly what Mabari passed.
func recordArgs(session string, args []string) {
	dir := os.Getenv("FAKE_CLAUDE_LOG")
	if dir == "" {
		return
	}
	// What the process was given to run with, which is what every command it runs inherits.
	_ = os.WriteFile(filepath.Join(dir, session+".env"), []byte(strings.Join(os.Environ(), "\n")), 0o600) // #nosec G304,G703 -- a test double, using paths its test gave it
	line, _ := json.Marshal(args)
	file, err := os.OpenFile(filepath.Join(dir, session+".args"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600) // #nosec G304,G703 -- a test double, using paths its test gave it
	if err != nil {
		return
	}
	defer func() { _ = file.Close() }()
	_, _ = file.Write(append(line, '\n'))
}

func configDir() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".fake-claude")
}

var notAlphanumeric = regexp.MustCompile(`[^A-Za-z0-9]`)

func transcriptPath(session, cwd string) string {
	return filepath.Join(configDir(), "projects", notAlphanumeric.ReplaceAllString(cwd, "-"), session+".jsonl")
}

// loadHooks reads hooks from the --settings value and the settings file, which merge rather than
// replace each other.
func (f *fake) loadHooks(inline string) {
	add := func(raw []byte) {
		var parsed settings
		if json.Unmarshal(raw, &parsed) != nil {
			return
		}
		for event, groups := range parsed.Hooks {
			f.hooks[event] = append(f.hooks[event], groups...)
		}
	}
	if inline != "" {
		add([]byte(inline))
	}
	if data, err := os.ReadFile(filepath.Join(configDir(), "settings.json")); err == nil {
		add(data)
	}
	if data, err := os.ReadFile(filepath.Join(f.cwd, ".claude", "settings.json")); err == nil {
		add(data)
	}
}

func newUUID() string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	text := hex.EncodeToString(raw)
	return text[:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:]
}

func (f *fake) emit(value any) {
	line, err := json.Marshal(value)
	if err != nil {
		return
	}
	f.outMu.Lock()
	defer f.outMu.Unlock()
	_, _ = f.out.Write(append(line, '\n'))
	_ = f.out.Flush()
}

// record appends a line to the transcript, as Claude Code keeps one for every session.
func (f *fake) record(kind string, message any) {
	if err := os.MkdirAll(filepath.Dir(f.transcript), 0o700); err != nil {
		return
	}
	file, err := os.OpenFile(f.transcript, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer func() { _ = file.Close() }()
	line, _ := json.Marshal(map[string]any{
		"type": kind, "uuid": newUUID(), "sessionId": f.session,
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano), "message": message,
	})
	_, _ = file.Write(append(line, '\n'))
}

func (f *fake) serve() int {
	if os.Getenv("FAKE_CLAUDE_DIE_AT_START") == "1" {
		fmt.Fprintln(os.Stderr, "fake claude: died before anything was saved")
		return 1
	}
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	ending := make(chan int, 1)
	go func() {
		for got := range signals {
			if got == syscall.SIGTERM {
				ending <- 143
				return
			}
			if os.Getenv("FAKE_CLAUDE_SIGINT_EXITS") == "1" {
				ending <- 130
				return
			}
			select {
			case f.interrupted <- struct{}{}:
			default:
			}
		}
	}()
	lines := make(chan string)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 1<<20), 16<<20)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()
	turnDone := make(chan struct{})
	var waiting []string
	running := false
	start := func(text string) {
		running = true
		go func() {
			f.turn(text)
			turnDone <- struct{}{}
		}()
	}
	open := true
	for {
		if !open && !running && len(waiting) == 0 {
			f.fire(context.Background(), "SessionEnd", map[string]any{"reason": "other"})
			return 0
		}
		select {
		case code := <-ending:
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			f.fire(ctx, "SessionEnd", map[string]any{"reason": "other"})
			return code
		case <-turnDone:
			running = false
			if len(waiting) > 0 {
				next := waiting[0]
				waiting = waiting[1:]
				start(next)
			}
		case line, ok := <-lines:
			if !ok {
				open, lines = false, nil
				continue
			}
			text, valid := userText(line)
			if !valid {
				continue
			}
			if running {
				waiting = append(waiting, text)
			} else {
				start(text)
			}
		}
	}
}

// userText reads one stdin line, as the Agent SDK's streaming input writes them.
func userText(line string) (string, bool) {
	var input struct {
		Type    string `json:"type"`
		Message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(line), &input) != nil || input.Type != "user" || input.Message.Role != "user" {
		return "", false
	}
	var text string
	if json.Unmarshal(input.Message.Content, &text) == nil {
		return text, true
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(input.Message.Content, &blocks) != nil {
		return "", false
	}
	var joined []string
	for _, block := range blocks {
		if block.Type == "text" {
			joined = append(joined, block.Text)
		}
	}
	return strings.Join(joined, "\n"), len(joined) > 0
}

// hookResult is what one hook printed, and whether it blocked by exiting 2.
type hookResult struct {
	output  map[string]any
	blocked bool
	reason  string
}

// fire runs every hook registered for an event, in parallel as Claude Code does, and returns what
// they printed. A hook that runs past its timeout is cancelled and counts as printing nothing.
func (f *fake) fire(ctx context.Context, event string, fields map[string]any) []hookResult {
	input := map[string]any{
		"session_id": f.session, "transcript_path": f.transcript, "cwd": f.cwd,
		"permission_mode": f.mode, "hook_event_name": event,
	}
	for key, value := range fields {
		input[key] = value
	}
	body, err := json.Marshal(input)
	if err != nil {
		return nil
	}
	tool, _ := fields["tool_name"].(string)
	var handlers []hookHandler
	for _, group := range f.hooks[event] {
		if group.Matcher == "" || group.Matcher == "*" || group.Matcher == tool {
			handlers = append(handlers, group.Hooks...)
		}
	}
	results := make([]hookResult, len(handlers))
	var wait sync.WaitGroup
	for index, handler := range handlers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			results[index] = runHook(ctx, handler, body)
		}()
	}
	wait.Wait()
	return results
}

func runHook(parent context.Context, handler hookHandler, body []byte) hookResult {
	timeout := time.Duration(handler.Timeout) * time.Second
	if timeout == 0 {
		timeout = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, handler.Command, handler.Args...) // #nosec G204 -- a test double
	cmd.Stdin = bytes.NewReader(body)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 2 {
		return hookResult{blocked: true, reason: strings.TrimSpace(stderr.String())}
	}
	var output map[string]any
	if err == nil {
		_ = json.Unmarshal(stdout.Bytes(), &output)
	}
	return hookResult{output: output}
}

func specific(result hookResult) map[string]any {
	inner, _ := result.output["hookSpecificOutput"].(map[string]any)
	return inner
}

// preToolUse combines what the PreToolUse hooks said, with deny above ask above allow.
func preToolUse(results []hookResult) (decision, reason string) {
	rank := map[string]int{"": 0, "allow": 1, "ask": 2, "deny": 3}
	for _, result := range results {
		if result.blocked {
			return "deny", result.reason
		}
		said, _ := specific(result)["permissionDecision"].(string)
		if rank[said] > rank[decision] {
			decision = said
			reason, _ = specific(result)["permissionDecisionReason"].(string)
		}
	}
	return decision, reason
}

// permissionRequest is the first decision any PermissionRequest hook gave. No decision means the
// call is denied, since nobody can be asked.
func permissionRequest(results []hookResult) (behavior, message string) {
	for _, result := range results {
		decision, _ := specific(result)["decision"].(map[string]any)
		if said, _ := decision["behavior"].(string); said != "" {
			message, _ = decision["message"].(string)
			return said, message
		}
	}
	return "", ""
}

func (f *fake) init() {
	if f.started {
		return
	}
	f.started = true
	f.fire(context.Background(), "SessionStart", map[string]any{"source": "startup", "model": f.model})
	reported := f.mode
	if mode := os.Getenv("FAKE_CLAUDE_REPORT_MODE"); mode != "" {
		reported = mode
	}
	f.emit(map[string]any{
		"type": "system", "subtype": "init", "uuid": newUUID(), "session_id": f.session, "cwd": f.cwd,
		"tools": []string{"Bash", "Read", "Write"}, "mcp_servers": []any{}, "model": f.model,
		"permissionMode": reported, "slash_commands": []any{}, "apiKeySource": "none",
		"claude_code_version": "2.1.318", "output_style": "default", "skills": []any{}, "plugins": []any{},
	})
}

// turn answers one message.
func (f *fake) turn(text string) {
	f.init()
	select {
	case <-f.interrupted: // A signal from before this turn doesn't belong to it.
	default:
	}
	for _, results := range [][]hookResult{f.fire(context.Background(), "UserPromptSubmit", map[string]any{"prompt": text})} {
		for _, result := range results {
			if extra, _ := specific(result)["additionalContext"].(string); extra != "" {
				text += "\n" + extra
			}
		}
	}
	f.record("user", map[string]any{"role": "user", "content": text})
	verb, rest, _ := strings.Cut(strings.TrimSpace(text), " ")
	var last string
	failed := ""
	switch verb {
	case "fake:bash":
		last = f.tool("Bash", map[string]any{"command": rest}, true, false)
	case "fake:allowed":
		last = f.tool("Bash", map[string]any{"command": rest}, false, false)
	case "fake:hook-allowed":
		last = f.tool("Bash", map[string]any{"command": rest}, true, true)
	case "fake:edit":
		last = f.tool("Write", map[string]any{"file_path": rest, "content": "hello"}, true, false)
	case "fake:read":
		last = f.tool("Read", map[string]any{"file_path": rest}, false, false)
	case "fake:slow":
		count, _ := strconv.Atoi(rest)
		last = strings.TrimSpace(strings.Repeat("word ", count))
		f.say(last, 60*time.Millisecond)
	case "fake:hang":
		f.say("Working on it.", 0)
		select {
		case <-f.interrupted:
			f.result("error_during_execution", "", true)
		case <-time.After(10 * time.Minute):
		}
		return
	case "fake:late":
		id := "msg_" + newUUID()
		f.open(id)
		f.fire(context.Background(), "Stop", map[string]any{"stop_hook_active": false, "last_assistant_message": rest})
		waitForGate()
		f.finish(id, strings.SplitAfter(rest, " "), rest, 5*time.Millisecond)
		f.result("success", rest, false)
		return
	case "fake:trail":
		f.say("Working on it.", 0)
		<-f.interrupted
		id := "msg_" + newUUID()
		f.open(id)
		waitForGate()
		f.finish(id, strings.SplitAfter(rest, " "), rest, 5*time.Millisecond)
		f.result("error_during_execution", "", true)
		return
	case "fake:stall":
		f.say("Working on it.", 0)
		f.open("msg_" + newUUID())
		f.delta("Half a reply ")
		select {}
	case "fake:silent":
		f.stream("msg_"+newUUID(), nil, "", 0)
	case "fake:big":
		size, _ := strconv.Atoi(rest)
		last = strings.Repeat("x", size)
		f.say(last, 0)
	case "fake:secret":
		last = "the key is sk-ant-abcdefghijklmnop1234 ok"
		f.sayPieces([]string{"the key is sk-ant-abcd", "efghijklmnop1234 ok"}, last)
	case "fake:error":
		failed = rest
	case "fake:crash":
		fmt.Fprintln(os.Stderr, "fake claude: crashing with token=abcd1234secret")
		os.Exit(3)
	default:
		last = "Done: " + strings.TrimSpace(text)
		f.say(last, 0)
	}
	if failed != "" {
		f.result("success", failed, true)
		return
	}
	// A Stop hook can keep the turn going, which is how waiting instructions reach it.
	for range 8 {
		results := f.fire(context.Background(), "Stop", map[string]any{"stop_hook_active": false, "last_assistant_message": last})
		reason := ""
		for _, result := range results {
			if said, _ := result.output["decision"].(string); said == "block" {
				reason, _ = result.output["reason"].(string)
			}
		}
		if reason == "" {
			break
		}
		last = "Done: " + reason
		f.say(last, 0)
	}
	f.result("success", last, false)
}

func (f *fake) result(subtype, text string, isError bool) {
	f.turns++
	f.emit(map[string]any{
		"type": "result", "subtype": subtype, "uuid": newUUID(), "session_id": f.session, "is_error": isError,
		"result": text, "total_cost_usd": 0.05 * f.turns, "num_turns": 1, "duration_ms": 10, "duration_api_ms": 5,
		"stop_reason": "end_turn", "usage": map[string]any{"input_tokens": 100, "output_tokens": 20},
		"modelUsage": map[string]any{}, "permission_denials": []any{},
	})
}

// say streams text as one assistant message, word by word, then sends it whole.
func (f *fake) say(text string, gap time.Duration) {
	words := strings.SplitAfter(text, " ")
	if len(text) > 4096 {
		words = []string{text}
	}
	id := "msg_" + newUUID()
	f.stream(id, words, text, gap)
}

func (f *fake) sayPieces(pieces []string, text string) {
	f.stream("msg_"+newUUID(), pieces, text, 0)
}

func (f *fake) stream(id string, pieces []string, text string, gap time.Duration) {
	f.open(id)
	f.finish(id, pieces, text, gap)
}

func (f *fake) event(body map[string]any) {
	f.emit(map[string]any{"type": "stream_event", "uuid": newUUID(), "session_id": f.session, "parent_tool_use_id": nil, "event": body})
}

func (f *fake) delta(piece string) {
	f.event(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": piece}})
}

// open starts a message, before any of its text.
func (f *fake) open(id string) {
	f.event(map[string]any{"type": "message_start", "message": map[string]any{"id": id, "role": "assistant", "model": f.model}})
	f.event(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
}

// finish writes the text of a message already opened, then sends it whole.
func (f *fake) finish(id string, pieces []string, text string, gap time.Duration) {
	for _, piece := range pieces {
		f.delta(piece)
		if gap > 0 {
			time.Sleep(gap)
		}
	}
	f.event(map[string]any{"type": "content_block_stop", "index": 0})
	f.event(map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}})
	f.event(map[string]any{"type": "message_stop"})
	message := map[string]any{
		"id": id, "type": "message", "role": "assistant", "model": f.model,
		"content": []any{map[string]any{"type": "text", "text": text}},
	}
	f.emit(map[string]any{"type": "assistant", "uuid": newUUID(), "session_id": f.session, "parent_tool_use_id": nil, "message": message})
	f.record("assistant", message)
}

// waitForGate holds a reply back until the test lets it go, so what happens meanwhile doesn't depend
// on how fast anything runs.
func waitForGate() {
	gate := filepath.Join(os.Getenv("FAKE_HOOK_DIR"), "gate")
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(2 * time.Millisecond) {
		if _, err := os.Stat(gate); err == nil { // #nosec G703 -- a test double, using paths its test gave it
			return
		}
	}
}

// tool makes one tool call and follows the documented order of hooks and rules, then says how it
// went. needsApproval is false for calls an allow rule covers or that need none. repoAllowed is a
// repository's own PreToolUse hook answering allow, which must not get past Mabari's ask.
func (f *fake) tool(name string, input map[string]any, needsApproval, repoAllowed bool) string {
	id := "toolu_" + newUUID()
	message := map[string]any{
		"id": "msg_" + newUUID(), "type": "message", "role": "assistant", "model": f.model,
		"content": []any{map[string]any{"type": "tool_use", "id": id, "name": name, "input": input}},
	}
	f.emit(map[string]any{"type": "assistant", "uuid": newUUID(), "session_id": f.session, "parent_tool_use_id": nil, "message": message})
	f.record("assistant", message)
	fields := map[string]any{"tool_name": name, "tool_input": input, "tool_use_id": id}
	decision, reason := preToolUse(f.fire(context.Background(), "PreToolUse", fields))
	if repoAllowed && decision == "" {
		decision = "allow"
	}
	denied := func(why string) string {
		f.emit(map[string]any{
			"type": "system", "subtype": "permission_denied", "uuid": newUUID(), "session_id": f.session,
			"tool_name": name, "tool_use_id": id, "message": why,
		})
		f.toolResult(id, why, true)
		f.say("It was denied.", 0)
		return "It was denied."
	}
	switch {
	case decision == "deny":
		return denied(reason)
	case decision == "allow":
	case decision == "ask" || needsApproval:
		behavior, message := permissionRequest(f.fire(context.Background(), "PermissionRequest", map[string]any{"tool_name": name, "tool_input": input}))
		if behavior != "allow" {
			if message == "" {
				message = "This tool needs approval, and nobody can answer in this run."
			}
			return denied(message)
		}
	}
	ran(name, input)
	f.fire(context.Background(), "PostToolUse", fields)
	f.toolResult(id, "ok: "+name, false)
	f.say("Ran it.", 0)
	return "Ran it."
}

func (f *fake) toolResult(id, text string, isError bool) {
	message := map[string]any{
		"role":    "user",
		"content": []any{map[string]any{"type": "tool_result", "tool_use_id": id, "content": text, "is_error": isError}},
	}
	f.emit(map[string]any{"type": "user", "uuid": newUUID(), "session_id": f.session, "parent_tool_use_id": nil, "message": message})
	f.record("user", message)
}

// ran writes down an action that really happened.
func ran(name string, input map[string]any) {
	path := os.Getenv("FAKE_CLAUDE_RAN")
	if path == "" {
		return
	}
	line, _ := json.Marshal(map[string]any{"tool": name, "input": input})
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600) // #nosec G304,G703 -- a test double, using paths its test gave it
	if err != nil {
		return
	}
	defer func() { _ = file.Close() }()
	_, _ = file.Write(append(line, '\n'))
}
