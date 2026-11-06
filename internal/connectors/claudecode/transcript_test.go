// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// transcriptBench is a session started elsewhere, reporting through its settings hooks.
type transcriptBench struct {
	*bench
	session string
	path    string
}

func newTranscript(t *testing.T) *transcriptBench {
	t.Helper()
	b := newBench(t)
	path := filepath.Join(b.config, "projects", "-shop", "session.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	return &transcriptBench{bench: b, session: "elsewhere-1", path: path}
}

func (b *transcriptBench) write(lines ...string) {
	b.t.Helper()
	file, err := os.OpenFile(b.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		b.t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	for _, line := range lines {
		if _, err := file.WriteString(line + "\n"); err != nil {
			b.t.Fatal(err)
		}
	}
}

// hook reports an event, as Claude Code does after each step.
func (b *transcriptBench) hook(transcript string) {
	b.t.Helper()
	body, _ := json.Marshal(map[string]any{
		"session_id": b.session, "cwd": b.folder, "hook_event_name": "Notification", "transcript_path": transcript,
	})
	b.c.Handle(context.Background(), body)
}

const (
	transcriptUser      = `{"type":"user","uuid":"u1","timestamp":"2026-11-06T10:00:00.000Z","message":{"role":"user","content":"fix the cart"}}`
	transcriptAssistant = `{"type":"assistant","uuid":"a1","timestamp":"2026-11-06T10:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"On it."},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"cart.ts"}}]}}`
	transcriptResult    = `{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"contents"}]}}`
)

func TestASessionStartedElsewhereIsReadFromItsTranscript(t *testing.T) {
	b := newTranscript(t)
	b.write(transcriptUser, transcriptAssistant, transcriptResult)
	b.hook(b.path)
	id := agentID(b.session)
	b.until("the conversation", func() bool { return len(b.said(id)) == 3 })
	want := []string{"user: fix the cart", "assistant: On it.", "tool: Read done"}
	if got := b.said(id); !slices.Equal(got, want) {
		t.Fatalf("conversation = %q", got)
	}
	items := b.conversation(id)
	if items[0].From != models.SaidInSession || items[0].Time != time.Date(2026, 11, 6, 10, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("user item = %+v", items[0])
	}
	if items[2].Tool.Summary != "Read cart.ts" || items[2].Tool.Output != "contents" {
		t.Fatalf("tool = %+v", items[2].Tool)
	}
}

func TestATranscriptIsOnlyReadOnwards(t *testing.T) {
	b := newTranscript(t)
	b.write(transcriptUser)
	b.hook(b.path)
	id := agentID(b.session)
	b.until("the first line", func() bool { return len(b.said(id)) == 1 })
	before, err := os.ReadFile(b.path)
	if err != nil {
		t.Fatal(err)
	}
	b.write(transcriptAssistant)
	b.hook(b.path)
	b.until("what came next", func() bool { return len(b.said(id)) == 3 })
	after, err := os.ReadFile(b.path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(after), string(before)) {
		t.Fatal("reading changed the transcript")
	}
}

// Reading it all again, as after a restart, replaces entries rather than repeating them.
func TestReadingATranscriptTwiceRepeatsNothing(t *testing.T) {
	b := newTranscript(t)
	b.write(transcriptUser, transcriptAssistant, transcriptResult)
	b.hook(b.path)
	id := agentID(b.session)
	b.until("the conversation", func() bool { return len(b.said(id)) == 3 })
	b.c.mu.Lock()
	delete(b.c.tails, id)
	b.c.mu.Unlock()
	b.hook(b.path)
	time.Sleep(100 * time.Millisecond)
	if got := b.said(id); len(got) != 3 {
		t.Fatalf("conversation = %q", got)
	}
}

// A line still being written waits for its end, and a line nobody can read costs only that line.
func TestAPartOrUnreadableLineIsSkipped(t *testing.T) {
	b := newTranscript(t)
	b.write("not json", `{"type":"something-new","uuid":"x"}`, transcriptUser)
	if err := appendText(b.path, `{"type":"assistant","uuid":"half`); err != nil {
		t.Fatal(err)
	}
	b.hook(b.path)
	id := agentID(b.session)
	b.until("the good line", func() bool { return len(b.said(id)) == 1 })
	if err := appendText(b.path, `","message":{"content":[{"type":"text","text":"finished"}]}}`+"\n"); err != nil {
		t.Fatal(err)
	}
	b.hook(b.path)
	b.until("the finished line", func() bool { return slices.Contains(b.said(id), "assistant: finished") })
}

func appendText(path, text string) error {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600) // #nosec G304 -- a test's own file
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	_, err = file.WriteString(text)
	return err
}

// A hook's input says where to read. It can't point Mabari at anything else.
func TestATranscriptPathOutsideClaudesFolderIsRefused(t *testing.T) {
	b := newTranscript(t)
	b.write(transcriptUser)
	outside := filepath.Join(b.folder, "secrets.jsonl")
	if err := os.WriteFile(outside, []byte(transcriptUser+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(filepath.Dir(b.path), "link.jsonl")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	notes := filepath.Join(filepath.Dir(b.path), "notes.txt")
	if err := os.WriteFile(notes, []byte(transcriptUser+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{
		"outside":   outside,
		"traversal": filepath.Dir(b.path) + "/../../../" + filepath.Base(b.folder) + "/shop/secrets.jsonl",
		"link":      link,
		"not jsonl": notes,
		"relative":  "session.jsonl",
		"empty":     "",
		"folder":    filepath.Dir(b.path),
	} {
		if _, ok := b.c.transcriptFile(path); ok {
			t.Errorf("%s: %q was accepted", name, path)
		}
	}
	if _, ok := b.c.transcriptFile(b.path); !ok {
		t.Error("the real transcript was refused")
	}
	b.c.ConfigDir = ""
	if _, ok := b.c.transcriptFile(b.path); ok {
		t.Error("with no settings folder there is nothing to check against")
	}
}

// Mabari's stream speaks for a session it runs, so its transcript isn't read as well.
func TestASessionMabariRunsIsNotReadFromItsTranscript(t *testing.T) {
	b := newBench(t)
	agent := b.start("hello")
	b.untilState(agent.ID, models.StateDone)
	b.c.mu.Lock()
	defer b.c.mu.Unlock()
	if len(b.c.tails) != 0 {
		t.Fatalf("following %d transcripts", len(b.c.tails))
	}
}

func folderWith(t *testing.T, paths ...string) string {
	t.Helper()
	root := t.TempDir()
	for _, path := range paths {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(path, "/") {
			if err := os.MkdirAll(full, 0o700); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.WriteFile(full, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestAFolderThatBringsItsOwnCodeIsFound(t *testing.T) {
	for _, path := range []string{
		".claude/settings.json", ".claude/settings.local.json", ".mcp.json",
		".claude/skills/deploy/SKILL.md", ".claude/commands/go.md", ".claude/hooks/check.sh",
	} {
		if found := FolderConfig(folderWith(t, path)); len(found) != 1 {
			t.Errorf("%s: found %q", path, found)
		}
	}
}

func TestAFolderThatBringsNothingIsFine(t *testing.T) {
	for name, folder := range map[string]string{
		"empty":        t.TempDir(),
		"code":         folderWith(t, "src/app.ts", "README.md"),
		"agents only":  folderWith(t, ".claude/agents/reviewer.md"),
		"empty skills": folderWith(t, ".claude/skills/"),
	} {
		if found := FolderConfig(folder); len(found) != 0 {
			t.Errorf("%s: found %q", name, found)
		}
	}
}

// Claude Code reads a repository's settings from anywhere inside it.
func TestConfigAtTheTopOfARepositoryCounts(t *testing.T) {
	root := folderWith(t, ".git/HEAD", ".mcp.json", "packages/web/src/app.ts")
	if found := FolderConfig(filepath.Join(root, "packages", "web")); len(found) != 1 {
		t.Fatalf("found %q", found)
	}
}

// Outside a repository, a parent folder's files are no part of it.
func TestAParentOutsideARepositoryDoesNotCount(t *testing.T) {
	root := folderWith(t, ".mcp.json", "shop/src/app.ts")
	if found := FolderConfig(filepath.Join(root, "shop")); len(found) != 0 {
		t.Fatalf("found %q", found)
	}
}

// noCopies fails if anything came from the transcript of a session Mabari ran itself, or if a line
// shows twice.
func (b *bench) noCopies(id string, want ...string) {
	b.t.Helper()
	// What a late read would add comes after the hooks that started it, so give it the chance.
	time.Sleep(150 * time.Millisecond)
	if got := b.said(id); !slices.Equal(got, want) {
		b.t.Fatalf("conversation =\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
	for _, item := range b.conversation(id) {
		if item.From == models.SaidInSession {
			b.t.Fatalf("copied from the transcript: %+v", item)
		}
	}
	if saved := b.read(id); !saved.RunsHere() {
		b.t.Fatalf("session = %+v", b.read(id).Session)
	}
	if log := b.engine.Snapshot().Log; slices.ContainsFunc(log, func(entry models.LogEntry) bool {
		return entry.Message == "Carried on outside Mabari"
	}) {
		b.t.Fatalf("log = %+v", log)
	}
}

// With Claude Code attached, a process Mabari ends fires the settings file's hooks on its way out.
// Whatever made the process start again, nothing it wrote comes back from the transcript.
func TestASessionThatStartsAgainDoesNotShowItsConversationTwice(t *testing.T) {
	notice := func(b *bench) string { return "notice: Session started in " + b.folder + "." }
	t.Run("plan first", func(t *testing.T) {
		b := newBench(t)
		b.attach()
		agent := b.start("first")
		b.untilState(agent.ID, models.StateDone)
		var err error
		_ = b.engine.Do(func() {
			err = b.c.InstructWith(b.engine.Agent(agent.ID), "plan the tests", SendOptions{Plan: true})
		})
		if err != nil {
			t.Fatal(err)
		}
		b.decide(agent.ID, models.DecisionAllowed)
		b.until("the plan to go ahead", func() bool {
			return slices.Contains(b.said(agent.ID), "assistant: Done: "+planApproved)
		})
		b.untilState(agent.ID, models.StateDone)
		b.noCopies(agent.ID, notice(b), "user: first", "assistant: Done: first", "user: plan the tests",
			"assistant: Done: plan the tests", "user: "+planApproved, "assistant: Done: "+planApproved)
	})
	t.Run("model change", func(t *testing.T) {
		b := newBench(t)
		b.attach()
		agent := b.start("first")
		b.untilState(agent.ID, models.StateDone)
		var err error
		_ = b.engine.Do(func() {
			err = b.c.InstructWith(b.engine.Agent(agent.ID), "second", SendOptions{Model: "claude-haiku-4-5"})
		})
		if err != nil {
			t.Fatal(err)
		}
		b.until("the reply", func() bool { return slices.Contains(b.said(agent.ID), "assistant: Done: second") })
		b.untilState(agent.ID, models.StateDone)
		b.noCopies(agent.ID, notice(b), "user: first", "assistant: Done: first", "user: second", "assistant: Done: second")
	})
	t.Run("gave up its place", func(t *testing.T) {
		b := newBench(t)
		b.attach()
		_ = b.engine.Do(func() {
			settings := b.engine.Settings()
			settings.MaxSessions = 1
			b.engine.SaveSettings(settings)
		})
		agent := b.start("first")
		b.untilState(agent.ID, models.StateDone)
		pid := b.read(agent.ID).Session.PID
		other := b.start("second", func(spec *SessionSpec) { spec.Name = "Pepper" })
		b.until("the first process to end", func() bool { return processGone(pid) })
		b.untilState(other.ID, models.StateDone)
		b.instruct(agent.ID, "third")
		b.until("the reply", func() bool { return slices.Contains(b.said(agent.ID), "assistant: Done: third") })
		b.untilState(agent.ID, models.StateDone)
		b.noCopies(agent.ID, notice(b), "user: first", "assistant: Done: first", "user: third", "assistant: Done: third")
	})
}

// A session carried on in a terminal: what is typed there shows, even the same words Mabari sent,
// and what Mabari already has doesn't show again.
func TestTextTypedInATerminalShowsOnce(t *testing.T) {
	b := newBench(t)
	b.attach()
	agent := b.start("first")
	b.untilState(agent.ID, models.StateDone)
	pid := b.read(agent.ID).Session.PID
	_ = b.engine.Do(func() { _ = b.c.ReleaseSession(b.engine.Agent(agent.ID)) })
	b.until("the process to end", func() bool { return processGone(pid) })
	b.until("the session's end to be noted", func() bool { return b.read(agent.ID).Session.TranscriptEnd != nil })
	session := b.read(agent.ID).Session.ID
	path, ok := b.c.sessionTranscript(session)
	if !ok {
		t.Fatal("no transcript")
	}
	terminal := &transcriptBench{bench: b, session: session, path: path}
	terminal.write(`{"type":"user","uuid":"typed1","message":{"role":"user","content":"typed in the terminal"}}`,
		`{"type":"user","uuid":"typed2","message":{"role":"user","content":"first"}}`,
		`{"type":"assistant","uuid":"typed3","message":{"role":"assistant","content":[{"type":"text","text":"Answered there."}]}}`)
	terminal.hook(path)
	want := []string{"notice: Session started in " + b.folder + ".", "user: first", "assistant: Done: first",
		"user: typed in the terminal", "user: first", "assistant: Answered there."}
	b.until("the terminal's text", func() bool { return len(b.said(agent.ID)) >= len(want) })
	if got := b.said(agent.ID); !slices.Equal(got, want) {
		t.Fatalf("conversation = %q", got)
	}
	for _, item := range b.conversation(agent.ID)[3:5] {
		if item.From != models.SaidInSession {
			t.Fatalf("typed in the terminal, but %+v", item)
		}
	}
	// Another hook reads nothing new.
	terminal.hook(path)
	time.Sleep(100 * time.Millisecond)
	if got := b.said(agent.ID); len(got) != len(want) {
		t.Fatalf("conversation = %q", got)
	}
}

// With no hooks in the settings file a terminal reports nothing, so what was typed there is read
// when Mabari picks the session up again, and only that.
func TestTextTypedInATerminalIsReadWhenMabariCarriesOn(t *testing.T) {
	b := newBench(t)
	agent := b.start("first")
	b.untilState(agent.ID, models.StateDone)
	pid := b.read(agent.ID).Session.PID
	_ = b.engine.Do(func() { _ = b.c.ReleaseSession(b.engine.Agent(agent.ID)) })
	b.until("the process to end", func() bool { return processGone(pid) })
	b.until("the session's end to be noted", func() bool { return b.read(agent.ID).Session.TranscriptEnd != nil })
	session := b.read(agent.ID).Session.ID
	path, ok := b.c.sessionTranscript(session)
	if !ok {
		t.Fatal("no transcript")
	}
	terminal := &transcriptBench{bench: b, session: session, path: path}
	terminal.write(`{"type":"user","uuid":"typed1","message":{"role":"user","content":"typed in the terminal"}}`)
	b.instruct(agent.ID, "second")
	b.until("the reply", func() bool { return slices.Contains(b.said(agent.ID), "assistant: Done: second") })
	want := []string{"notice: Session started in " + b.folder + ".", "user: first", "assistant: Done: first",
		"user: typed in the terminal", "user: second", "assistant: Done: second"}
	if got := b.said(agent.ID); !slices.Equal(got, want) {
		t.Fatalf("conversation = %q", got)
	}
}

// A thread doubled by an earlier version stays as it is: copies already there are neither repeated
// nor joined by the messages sent since, once Mabari restarts and has counted the transcript.
func TestAThreadAlreadyDoubledIsNotMadeWorse(t *testing.T) {
	b := newBench(t)
	agent := b.start("first")
	b.untilState(agent.ID, models.StateDone)
	pid := b.read(agent.ID).Session.PID
	_ = b.engine.Do(func() { _ = b.c.ReleaseSession(b.engine.Agent(agent.ID)) })
	b.until("the process to end", func() bool { return processGone(pid) })
	b.until("the session's end to be noted", func() bool { return b.read(agent.ID).Session.TranscriptEnd != nil })
	path, ok := b.c.sessionTranscript(agent.Session.ID)
	if !ok {
		t.Fatal("no transcript")
	}
	// As saved by an earlier version: a copy of the first message, and no count of the transcript.
	_ = b.engine.Do(func() {
		saved := b.engine.Agent(agent.ID)
		session := *saved.Session
		session.TranscriptEnd = nil
		saved.Session = &session
		b.engine.Touch(saved)
		b.engine.Converse(agent.ID, models.ConversationItem{
			ID: "t-old-0", Kind: models.ConversationUser, Text: "first", From: models.SaidInSession,
		})
	})
	before := b.said(agent.ID)
	_ = b.engine.Do(b.c.Resume)
	if b.read(agent.ID).Session.TranscriptEnd == nil {
		t.Fatal("the restart didn't count the transcript")
	}
	terminal := &transcriptBench{bench: b, session: agent.Session.ID, path: path}
	terminal.hook(path)
	time.Sleep(100 * time.Millisecond)
	if got := b.said(agent.ID); !slices.Equal(got, before) {
		t.Fatalf("conversation = %q, was %q", got, before)
	}
}
