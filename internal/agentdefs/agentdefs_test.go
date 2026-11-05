// SPDX-License-Identifier: Apache-2.0

package agentdefs

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

func folders(t *testing.T) Folders {
	t.Helper()
	home := t.TempDir()
	return Folders{
		Account: filepath.Join(home, ".claude", "agents"),
		State:   filepath.Join(home, ".mabari", "agents-state.json"),
		Home:    home,
	}
}

func reviewer() models.AgentDef {
	return models.AgentDef{
		Name: "code-reviewer", Description: "Use after any change: review it for bugs.", Scope: models.DefAccount,
		Model: "sonnet", Tools: []string{"Read", "Grep", "Glob"}, Color: "#4FB3FF",
		Instructions: "You are a careful senior reviewer.\n\nNever edit files.",
	}
}

func scan(t *testing.T, library *Library) []models.AgentDef {
	t.Helper()
	defs, _, err := library.Scan()
	if err != nil {
		t.Fatal(err)
	}
	return defs
}

func TestRenderAndParseRoundTrip(t *testing.T) {
	def := reviewer()
	def.Skills = []string{"agent-improver"}
	text := string(Render(def))
	want := "---\nname: code-reviewer\ndescription: \"Use after any change: review it for bugs.\"\ntools: Read, Grep, Glob\n" +
		"model: sonnet\nskills: agent-improver\ncolor: blue\n---\n\nYou are a careful senior reviewer.\n\nNever edit files.\n"
	if text != want {
		t.Fatalf("rendered\n%s\nwant\n%s", text, want)
	}
	back, err := Parse([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	if back.Name != def.Name || back.Description != def.Description || strings.Join(back.Tools, ",") != "Read,Grep,Glob" ||
		back.Model != "sonnet" || back.Color != "#4FB3FF" || back.Instructions != def.Instructions ||
		strings.Join(back.Skills, ",") != "agent-improver" {
		t.Errorf("parsed %+v", back)
	}
}

// Files written by hand or by Claude Code itself read too: YAML lists, no model, CRLF lines.
func TestParseHandWrittenFiles(t *testing.T) {
	def, err := Parse([]byte("---\r\nname: helper\r\ndescription: Helps\r\ntools:\r\n  - Read\r\n  - Bash\r\n---\r\nDo it.\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if def.Model != "inherit" || strings.Join(def.Tools, ",") != "Read,Bash" || def.Instructions != "Do it." {
		t.Errorf("got %+v", def)
	}
	// A description with a colon in it isn't strict YAML, but Claude Code reads it, so Mabari does.
	loose, err := Parse([]byte("---\nname: backend\ndescription: Owns the API. Use for: services, workers\ntools: Read, Bash\nmodel: sonnet\neffort: xhigh\n---\nBuild it.\n"))
	if err != nil || loose.Description != "Owns the API. Use for: services, workers" || strings.Join(loose.Tools, ",") != "Read,Bash" || loose.Model != "sonnet" {
		t.Errorf("loose = %+v, %v", loose, err)
	}
	for _, bad := range []string{"no front matter", "---\nname: x\n", "---\n  - [\n---\n"} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestFirstScanWritesMabariAndNeverOverwritesIt(t *testing.T) {
	f := folders(t)
	library := New(f)
	defs := scan(t, library)
	if len(defs) != 1 || !defs[0].System || defs[0].Name != MabariName || defs[0].Path != "~/.claude/agents/mabari.md" {
		t.Fatalf("defs = %+v", defs)
	}
	text, err := os.ReadFile(filepath.Join(f.Account, "mabari.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{"skills: agent-creator, agent-improver", "tools: Task, Read, Grep, Glob, Edit, Write",
		"You manage every other agent and help each one get better at its job."} {
		if !strings.Contains(string(text), part) {
			t.Errorf("mabari.md lacks %q", part)
		}
	}
	edited := strings.Replace(string(text), "model: haiku", "model: sonnet", 1)
	if err := os.WriteFile(filepath.Join(f.Account, "mabari.md"), []byte(edited), 0o600); err != nil {
		t.Fatal(err)
	}
	if defs := scan(t, New(f)); defs[0].Model != "sonnet" {
		t.Errorf("Mabari's own edit was replaced: %q", defs[0].Model)
	}
}

// Agents live in their files: a new Library, as after a restart or reinstall, finds them, with
// the run counts and on or off state from the state file.
func TestAgentsSurviveARestart(t *testing.T) {
	f := folders(t)
	library := New(f)
	scan(t, library)
	saved, err := library.Save(reviewer(), "")
	if err != nil {
		t.Fatal(err)
	}
	if saved.ID != "account:code-reviewer" || saved.Path != "~/.claude/agents/code-reviewer.md" {
		t.Fatalf("saved = %+v", saved)
	}
	if err := library.CountRun(saved.ID); err != nil {
		t.Fatal(err)
	}
	if err := library.SetEnabled(saved.ID, false); err != nil {
		t.Fatal(err)
	}
	restarted := scan(t, New(f))
	if len(restarted) != 2 {
		t.Fatalf("after a restart: %+v", restarted)
	}
	got := restarted[1]
	if got.ID != saved.ID || got.Runs != 1 || got.Enabled || got.Description != reviewer().Description {
		t.Errorf("after a restart: %+v", got)
	}
}

func TestFilesAddedOutsideMabariAreFound(t *testing.T) {
	f := folders(t)
	library := New(f)
	scan(t, library)
	if library.Changed() {
		t.Fatal("changed with nothing new")
	}
	if err := os.WriteFile(filepath.Join(f.Account, "notes.md"), []byte("---\nname: notes\ndescription: Notes\ntools: Read\n---\nTake notes.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !library.Changed() {
		t.Fatal("a new file wasn't noticed")
	}
	defs := scan(t, library)
	if len(defs) != 2 || defs[1].Name != "notes" {
		t.Errorf("defs = %+v", defs)
	}
}

func TestProjectAgentsLiveInTheProjectFolder(t *testing.T) {
	f := folders(t)
	folder := t.TempDir()
	library := New(f)
	library.SetProjects([]Project{{ID: "shop", Folder: folder}})
	def := reviewer()
	def.Scope, def.ProjectID = models.DefProject, "shop"
	saved, err := library.Save(def, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(folder, ".claude", "agents", "code-reviewer.md")); err != nil {
		t.Fatal(err)
	}
	if saved.ID != "project:shop:code-reviewer" {
		t.Errorf("id = %q", saved.ID)
	}
	defs, report, err := library.Scan()
	if err != nil || report.Account != 1 || report.Projects["shop"] != 1 || len(defs) != 2 {
		t.Errorf("defs = %+v, report = %+v, err = %v", defs, report, err)
	}
	def.ProjectID = "nowhere"
	if _, err := library.Save(def, ""); err == nil || !strings.Contains(err.Error(), "no folder") {
		t.Errorf("a project without a folder: %v", err)
	}
}

func TestRenamingMovesTheFileAndKeepsItsRuns(t *testing.T) {
	f := folders(t)
	library := New(f)
	scan(t, library)
	saved, _ := library.Save(reviewer(), "")
	_ = library.CountRun(saved.ID)
	renamed := reviewer()
	renamed.Name = "reviewer"
	if _, err := library.Save(renamed, saved.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.Account, "code-reviewer.md")); !os.IsNotExist(err) {
		t.Error("the old file is still there")
	}
	defs := scan(t, library)
	if len(defs) != 2 || defs[1].Name != "reviewer" || defs[1].Runs != 1 {
		t.Errorf("defs = %+v", defs)
	}
}

func TestSaveChecksTheDefinition(t *testing.T) {
	f := folders(t)
	library := New(f)
	scan(t, library)
	cases := map[string]func(*models.AgentDef){
		"short name":     func(d *models.AgentDef) { d.Name = "Bad Name" },
		"Say when":       func(d *models.AgentDef) { d.Description = " " },
		"at least one":   func(d *models.AgentDef) { d.Tools = nil },
		"instructions":   func(d *models.AgentDef) { d.Instructions = "" },
		"doesn't know":   func(d *models.AgentDef) { d.Tools = []string{"Teleport"} },
		"office manager": func(d *models.AgentDef) { d.Name = MabariName },
		"Skill names":    func(d *models.AgentDef) { d.Skills = []string{"ok\nmodel: opus"} },
	}
	for want, change := range cases {
		def := reviewer()
		change(&def)
		if _, err := library.Save(def, ""); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", want, err)
		}
	}
	if _, err := library.Save(reviewer(), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := library.Save(reviewer(), ""); err == nil || !strings.Contains(err.Error(), "already an agent") {
		t.Errorf("duplicate: %v", err)
	}
}

func TestMabariCanBeEditedButNotRemoved(t *testing.T) {
	f := folders(t)
	library := New(f)
	defs := scan(t, library)
	mabari := defs[0]
	mabari.Name, mabari.Model, mabari.Skills = "renamed", "opus", nil
	saved, err := library.Save(mabari, mabari.ID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Name != MabariName || saved.Model != "opus" || len(saved.Skills) != 2 {
		t.Errorf("saved = %+v", saved)
	}
	if err := library.Delete(mabari.ID); err == nil {
		t.Error("Mabari was deleted")
	}
	if err := library.SetEnabled(mabari.ID, false); err == nil {
		t.Error("Mabari was turned off")
	}
}

func TestDeleteRemovesTheFile(t *testing.T) {
	f := folders(t)
	library := New(f)
	scan(t, library)
	saved, _ := library.Save(reviewer(), "")
	if err := library.Delete(saved.ID); err != nil {
		t.Fatal(err)
	}
	if defs := scan(t, library); len(defs) != 1 {
		t.Errorf("defs = %+v", defs)
	}
}

// A file that can't be read is reported and skipped, never deleted or rewritten.
func TestABrokenFileIsLeftAlone(t *testing.T) {
	f := folders(t)
	library := New(f)
	scan(t, library)
	broken := filepath.Join(f.Account, "broken.md")
	if err := os.WriteFile(broken, []byte("no front matter"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, report, err := library.Scan()
	if err != nil || len(report.Problems) != 1 || !strings.Contains(report.Problems[0], "broken.md") {
		t.Errorf("report = %+v, err = %v", report, err)
	}
	if data, _ := os.ReadFile(broken); string(data) != "no front matter" {
		t.Error("the broken file changed")
	}
}

// Editing an agent keeps the front matter fields Mabari doesn't edit.
func TestEditingKeepsOtherFields(t *testing.T) {
	f := folders(t)
	library := New(f)
	scan(t, library)
	path := filepath.Join(f.Account, "backend.md")
	text := "---\nname: backend\ndescription: Owns the API\ntools: Read\nmodel: sonnet\neffort: xhigh\npermissionMode: plan\n\"Model\": opus\n? tools\n: Bash\n!!str color: red\n---\nBuild it.\n"
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	defs := scan(t, library)
	def := defs[1]
	def.Model = "opus"
	if _, err := library.Save(def, def.ID); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	for _, want := range []string{"model: opus\n", "effort: xhigh\npermissionMode: plan\n---\n"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("file lacks %q:\n%s", want, data)
		}
	}
	if strings.Contains(string(data), `"Model"`) || strings.Contains(string(data), "? tools") ||
		strings.Contains(string(data), "!!str") || strings.Count(string(data), "tools:") != 1 {
		t.Errorf("a disguised copy of a field Mabari writes was kept:\n%s", data)
	}
	// Moving the agent to another scope doesn't carry the fields the builder never showed.
	folder := t.TempDir()
	library.SetProjects([]Project{{ID: "shop", Folder: folder}})
	moved := def
	moved.Scope, moved.ProjectID = models.DefProject, "shop"
	saved, err := library.Save(moved, def.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(filepath.Join(folder, ".claude", "agents", "backend.md"))
	if strings.Contains(string(data), "permissionMode") || saved.ID != "project:shop:backend" {
		t.Errorf("moved file kept hidden fields:\n%s", data)
	}
}

// A project's repository brings its own agents: once the project has the folder, they load, and
// a folder written with ~ is found in the home folder.
func TestARepositorysAgentsLoadWithItsProject(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	repo := filepath.Join(home, "code", "shop", ".claude", "agents")
	if err := os.MkdirAll(repo, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "billing.md"), []byte("---\nname: billing\ndescription: Use for invoices\ntools: Read\n---\nMoney in cents.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	s, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	engine, err := events.New(ctx, s, nil)
	if err != nil {
		t.Fatal(err)
	}
	library := New(Folders{Account: filepath.Join(home, ".claude", "agents"), State: filepath.Join(home, ".mabari", "state.json"), Home: home})
	if _, err := library.Refresh(engine); err != nil {
		t.Fatal(err)
	}
	sub := engine.Subscribe(events.Resume{}).Sub
	defer engine.Unsubscribe(sub)
	_ = engine.Do(func() {
		engine.SaveProject(models.Project{ID: "shop", Name: "Shop", Repository: &models.Repository{Path: "~/code/shop"}})
	})
	run, stop := context.WithCancel(ctx)
	defer stop()
	go library.Keep(run, engine, 20*time.Millisecond)
	deadline := time.After(3 * time.Second)
	for {
		select {
		case message := <-sub.C:
			if message.Type == models.MsgToast {
				if message.Text != "Loaded 1 agent from Shop's repository. They're in the agent builder." {
					t.Errorf("toast = %q", message.Text)
				}
				defs := engine.Snapshot().Defs
				if len(defs) != 2 || defs[1].ID != "project:shop:billing" || defs[1].Path != "~/code/shop/.claude/agents/billing.md" {
					t.Errorf("defs = %+v", defs)
				}
				return
			}
		case <-deadline:
			t.Fatal("the repository's agents never loaded")
		}
	}
}

// An agent whose file name differs from its name is saved back to its own file, never over
// another agent's file.
func TestEditingWritesBackToTheAgentsOwnFile(t *testing.T) {
	f := codexFolders(t)
	if err := os.MkdirAll(f.Codex, 0o750); err != nil {
		t.Fatal(err)
	}
	write := func(file, name string) {
		text := "name = \"" + name + "\"\ndescription = \"D\"\ndeveloper_instructions = \"I\"\n"
		if err := os.WriteFile(filepath.Join(f.Codex, file), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("a.toml", "bb")
	write("bb.toml", "cc")
	library := New(f)
	defs := scan(t, library)
	var bb models.AgentDef
	for _, def := range defs {
		if def.Name == "bb" {
			bb = def
		}
	}
	bb.Instructions = "Changed."
	if _, err := library.Save(bb, bb.ID); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(filepath.Join(f.Codex, "a.toml"))
	other, _ := os.ReadFile(filepath.Join(f.Codex, "bb.toml"))
	if !strings.Contains(string(a), "Changed.") || !strings.Contains(string(other), `name = "cc"`) {
		t.Errorf("a.toml:\n%s\nbb.toml:\n%s", a, other)
	}
}

// A project whose folder is the home folder doesn't read the account's agents a second time.
func TestAHomeFolderProjectDoesNotRepeatAccountAgents(t *testing.T) {
	f := folders(t)
	t.Setenv("HOME", f.Home)
	library := New(f)
	library.SetProjects([]Project{{ID: "home", Folder: "~"}})
	defs, report, err := library.Scan()
	if err != nil || len(defs) != 1 || report.Projects["home"] != 0 {
		t.Errorf("defs = %+v, report = %+v, %v", defs, report, err)
	}
}

func TestCodexNamesMayHaveUnderscores(t *testing.T) {
	f := codexFolders(t)
	library := New(f)
	scan(t, library)
	def := reviewerForCodex()
	def.Name = "pr_explorer"
	if saved, err := library.Save(def, ""); err != nil || saved.Path != "~/.codex/agents/pr_explorer.toml" {
		t.Errorf("saved = %+v, %v", saved, err)
	}
}

// Control characters and broken text can't make a Codex file unreadable.
func TestCodexFilesStayValidTOML(t *testing.T) {
	def := reviewerForCodex()
	def.Description = "bell\a here \x01 and \x7f and \xff"
	def.Instructions = "tab\there\x00 and \x7f"
	if _, err := ParseCodex(RenderCodex(def)); err != nil {
		t.Errorf("not valid TOML: %v\n%s", err, RenderCodex(def))
	}
}
