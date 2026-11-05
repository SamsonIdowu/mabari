// SPDX-License-Identifier: Apache-2.0

package agentdefs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

func codexFolders(t *testing.T) Folders {
	t.Helper()
	f := folders(t)
	f.Codex = filepath.Join(f.Home, ".codex", "agents")
	return f
}

func reviewerForCodex() models.AgentDef {
	def := reviewer()
	def.Kind, def.Model, def.Tools = models.DefCodex, "gpt-5-codex", nil
	def.Instructions = `Review for "correctness".` + "\n\nUse \\ carefully. A \"\"\" can't end this early."
	return def
}

func TestCodexAgentsAreTOMLFiles(t *testing.T) {
	text := string(RenderCodex(reviewerForCodex()))
	want := "name = \"code-reviewer\"\ndescription = \"Use after any change: review it for bugs.\"\nmodel = \"gpt-5-codex\"\n" +
		"developer_instructions = \"\"\"\nReview for \\\"correctness\\\".\n\nUse \\\\ carefully. A \\\"\\\"\\\" can't end this early.\n\"\"\"\n"
	if text != want {
		t.Fatalf("rendered\n%s\nwant\n%s", text, want)
	}
	back, err := ParseCodex([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	if back.Name != "code-reviewer" || back.Model != "gpt-5-codex" || back.Instructions != reviewerForCodex().Instructions ||
		back.Kind != models.DefCodex {
		t.Errorf("parsed %+v", back)
	}
	// A description can't add a key or a table, whatever it holds.
	sneaky := reviewerForCodex()
	sneaky.Description = "fine\"\nmodel = \"o3\"\n[tools]"
	parsed, err := ParseCodex(RenderCodex(sneaky))
	if err != nil || parsed.Model != "gpt-5-codex" || !strings.Contains(parsed.Description, "[tools]") {
		t.Errorf("parsed = %+v, %v", parsed, err)
	}
}

func TestCodexAgentsLoadSaveAndKeepTheirSettings(t *testing.T) {
	f := codexFolders(t)
	if err := os.MkdirAll(f.Codex, 0o750); err != nil {
		t.Fatal(err)
	}
	existing := "name = \"explorer\"\ndescription = \"Reads code\"\nmodel_reasoning_effort = \"high\"\n" +
		"developer_instructions = \"Explore.\"\n\n[skills.config]\nfoo = false\n"
	if err := os.WriteFile(filepath.Join(f.Codex, "explorer.toml"), []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}
	library := New(f)
	defs, report, err := library.Scan()
	if err != nil || report.Codex != 1 {
		t.Fatalf("report = %+v, %v", report, err)
	}
	explorer := defs[1]
	if explorer.ID != "codex:account:explorer" || explorer.Kind != models.DefCodex || explorer.Path != "~/.codex/agents/explorer.toml" {
		t.Fatalf("explorer = %+v", explorer)
	}
	explorer.Instructions = "Explore carefully."
	if _, err := library.Save(explorer, explorer.ID); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(f.Codex, "explorer.toml"))
	for _, want := range []string{"Explore carefully.", "model_reasoning_effort = 'high'", "[skills.config]", "foo = false"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("file lacks %q:\n%s", want, data)
		}
	}
	if _, err := ParseCodex(data); err != nil {
		t.Errorf("the saved file isn't valid TOML: %v\n%s", err, data)
	}
	// A new Codex agent needs no tools, and the same name can be a Claude agent too.
	fresh := reviewerForCodex()
	saved, err := library.Save(fresh, "")
	if err != nil || saved.ID != "codex:account:code-reviewer" || saved.Path != "~/.codex/agents/code-reviewer.toml" {
		t.Fatalf("saved = %+v, %v", saved, err)
	}
	if _, err := library.Save(reviewer(), ""); err != nil {
		t.Errorf("a Claude agent with the same name: %v", err)
	}
	bad := reviewerForCodex()
	bad.Name, bad.Model = "other", "gpt 5; rm"
	if _, err := library.Save(bad, ""); err == nil {
		t.Error("an odd model was accepted")
	}
}

func TestAProjectsCodexAgentsLoadToo(t *testing.T) {
	f := codexFolders(t)
	folder := t.TempDir()
	dir := filepath.Join(folder, ".codex", "agents")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tester.toml"), []byte("name = \"tester\"\ndescription = \"Tests\"\ndeveloper_instructions = \"Test.\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	library := New(f)
	library.SetProjects([]Project{{ID: "shop", Folder: folder}})
	defs, report, err := library.Scan()
	if err != nil || report.Projects["shop"] != 1 {
		t.Fatalf("report = %+v, %v", report, err)
	}
	if got := defs[len(defs)-1]; got.ID != "codex:project:shop:tester" || got.Kind != models.DefCodex {
		t.Errorf("got %+v", got)
	}
}
