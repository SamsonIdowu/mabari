// SPDX-License-Identifier: Apache-2.0

package server

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// A fake Claude Code: it takes instructions the way the real one queues them, so a test can see
// what a reviewer was sent.
type recordingConnector struct {
	office *office
	mu     sync.Mutex
	sent   []string
}

func (f *recordingConnector) Start() {}
func (f *recordingConnector) Stop()  {}
func (f *recordingConnector) Instruct(agent *models.LiveAgent, text string) {
	f.mu.Lock()
	f.sent = append(f.sent, text)
	f.mu.Unlock()
	f.office.engine.Queue(agent, text)
}
func (f *recordingConnector) Decide(*models.LiveAgent, models.Approval) {}
func (f *recordingConnector) Interrupt(*models.LiveAgent)               {}
func (f *recordingConnector) Continue(*models.LiveAgent)                {}
func (f *recordingConnector) StopAgent(*models.LiveAgent)               {}
func (f *recordingConnector) Retry(*models.LiveAgent)                   {}
func (f *recordingConnector) AddSubagent(*models.LiveAgent, string, string, string) *models.LiveAgent {
	return nil
}
func (f *recordingConnector) Models() []string { return nil }

func (f *recordingConnector) last(t *testing.T) string {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sent) == 0 {
		t.Fatal("nothing was sent to a Claude Code session")
	}
	return f.sent[len(f.sent)-1]
}

func (f *recordingConnector) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git isn't installed")
	}
	// Nothing here reads the person's own Git settings.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
}

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	full := append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"}, args...)
	cmd := exec.Command("git", full...) // #nosec G204 -- a test, with its own arguments
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// repoWithChanges is a repository with an edited file, a new file and a deleted one.
func repoWithChanges(t *testing.T) string {
	t.Helper()
	requireGit(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gitIn(t, dir, "init", "-q", "-b", "main")
	write(t, dir, "src/app.ts", "one\ntwo\nthree\n")
	write(t, dir, "old.txt", "bye\n")
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "-q", "-m", "base")
	write(t, dir, "src/app.ts", "one\nTWO\nthree\nfour\n")
	write(t, dir, "new.txt", "fresh\n")
	if err := os.Remove(filepath.Join(dir, "old.txt")); err != nil {
		t.Fatal(err)
	}
	return dir
}

// fakes keeps one fake Claude Code for each test office, so every agent added to it is taken by the same one.
var fakes sync.Map

// withRealAgent adds an agent that a Claude Code session reports, working in folder.
func withRealAgent(t *testing.T, office *office, name, folder string, project *string) (*models.LiveAgent, *recordingConnector) {
	t.Helper()
	made, loaded := fakes.LoadOrStore(office, &recordingConnector{office: office})
	fake, _ := made.(*recordingConnector)
	if !loaded {
		// It takes the engine's lock itself, so it isn't called inside Do.
		office.engine.AddConnector("claude", fake)
	}
	var agent *models.LiveAgent
	if err := office.engine.Do(func() {
		agent = &models.LiveAgent{}
		agent.ID, agent.Name, agent.Source, agent.Folder, agent.Project = "cc-"+strings.ToLower(name), name, "claude", folder, project
		agent.Provider, agent.Account, agent.State, agent.Task = models.ProviderClaude, models.AccountClaudeCode, models.StateEditing, "Editing"
		agent.Queued = []models.Instruction{}
		office.engine.AddAgent(agent)
	}); err != nil {
		t.Fatal(err)
	}
	return agent, fake
}

func getChanges(t *testing.T, office *office, path string) (int, models.Changes) {
	t.Helper()
	response := office.do(t, http.MethodGet, path, "")
	var changes models.Changes
	if response.Code == http.StatusOK {
		changes = decode[models.Changes](t, response)
	}
	return response.Code, changes
}

func TestAnAgentsChangesAreReadFromItsFolder(t *testing.T) {
	office := newOffice(t)
	dir := repoWithChanges(t)
	agent, _ := withRealAgent(t, office, "Ledger", dir, nil)
	code, changes := getChanges(t, office, "/api/agents/"+agent.ID+"/changes")
	if code != http.StatusOK || changes.State != models.ChangesRead || changes.Demo || changes.Branch != "main" ||
		changes.Folder != dir || changes.FileCount != 3 || changes.Added != 3 || changes.Removed != 2 {
		t.Fatalf("%d: %+v", code, changes)
	}
	want := map[string]models.ChangeStatus{"src/app.ts": models.ChangeModified, "new.txt": models.ChangeUntracked, "old.txt": models.ChangeDeleted}
	for _, file := range changes.Files {
		if want[file.Path] != file.Status || file.ID == "" {
			t.Errorf("%s = %+v", file.Path, file)
		}
		delete(want, file.Path)
	}
	if len(want) != 0 {
		t.Errorf("missing %v", want)
	}
	// Asking again with the version it holds is told nothing changed.
	_, same := getChanges(t, office, "/api/agents/"+agent.ID+"/changes?version="+changes.Version)
	if same.State != models.ChangesUnchanged || len(same.Files) != 0 || same.Version != changes.Version {
		t.Errorf("same = %+v", same)
	}
	write(t, dir, "new.txt", "fresher\n")
	if _, after := getChanges(t, office, "/api/agents/"+agent.ID+"/changes?version="+changes.Version); after.State != models.ChangesRead {
		t.Errorf("after an edit = %s", after.State)
	}
}

func TestUnknownIdsAreNotFoundAndPathsAreNotIds(t *testing.T) {
	office := newOffice(t)
	for _, path := range []string{
		"/api/agents/nobody/changes", "/api/projects/nothing/changes",
		"/api/agents/..%2F..%2Fetc/changes", "/api/agents/%2Fetc%2Fpasswd/changes", "/api/projects/%2Ftmp/changes",
	} {
		if code, _ := getChanges(t, office, path); code != http.StatusNotFound {
			t.Errorf("%s = %d", path, code)
		}
	}
	for _, path := range []string{"/api/agents/nobody/changes/opinion", "/api/projects/nothing/changes/opinion"} {
		if response := office.do(t, http.MethodPost, path, `{"reviewerId":"x"}`); response.Code != http.StatusNotFound {
			t.Errorf("%s = %d", path, response.Code)
		}
	}
}

// Nothing in a request, a query or a body, can name the folder that is read.
func TestNothingInARequestNamesTheFolder(t *testing.T) {
	office := newOffice(t)
	dir := repoWithChanges(t)
	agent, _ := withRealAgent(t, office, "Ledger", dir, nil)
	other := repoWithChanges(t)
	write(t, other, "OTHER-CANARY.txt", "other\n")
	_, plain := getChanges(t, office, "/api/agents/"+agent.ID+"/changes")
	for _, query := range []string{
		"?folder=" + other, "?path=" + other, "?dir=" + other, "?root=" + other, "?cwd=" + other,
		"?file=/etc/passwd", "?git_dir=" + other + "/.git", "?repo=" + other,
	} {
		_, got := getChanges(t, office, "/api/agents/"+agent.ID+"/changes"+query)
		encoded, _ := json.Marshal(got)
		if got.Folder != dir || got.FileCount != plain.FileCount || strings.Contains(string(encoded), "OTHER-CANARY") ||
			strings.Contains(string(encoded), "root:") {
			t.Errorf("%s changed what was read: %s", query, encoded)
		}
	}
	// A second opinion takes an agent's id and nothing else: a folder in the body is refused.
	reviewer, _ := withRealAgent(t, office, "Quill", t.TempDir(), nil)
	for _, body := range []string{
		`{"reviewerId":"` + reviewer.ID + `","folder":"` + other + `"}`,
		`{"reviewerId":"` + reviewer.ID + `","path":"/etc"}`,
	} {
		if response := office.do(t, http.MethodPost, "/api/agents/"+agent.ID+"/changes/opinion", body); response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d", body, response.Code)
		}
	}
}

func TestFoldersThatCannotBeReadSayWhy(t *testing.T) {
	office := newOffice(t)
	requireGit(t)
	empty, _ := withRealAgent(t, office, "Empty", "", nil)
	plain, _ := withRealAgent(t, office, "Plain", t.TempDir(), nil)
	gone, _ := withRealAgent(t, office, "Gone", filepath.Join(t.TempDir(), "gone"), nil)
	relative, _ := withRealAgent(t, office, "Relative", "src/app", nil)
	for agent, want := range map[*models.LiveAgent]models.ChangesState{
		empty: models.ChangesNoFolder, plain: models.ChangesNotRepo, gone: models.ChangesMissing, relative: models.ChangesNoFolder,
	} {
		code, changes := getChanges(t, office, "/api/agents/"+agent.ID+"/changes")
		if code != http.StatusOK || changes.State != want || changes.Message == "" || len(changes.Files) != 0 {
			t.Errorf("%s: %d %+v, want %s", agent.Name, code, changes, want)
		}
	}
}

// The demo's agents are simulated. Whatever folder they have is never read, since it could be a
// real one: the changes are made up, and say so.
func TestADemoAgentsChangesAreMadeUpAndItsFolderIsNeverRead(t *testing.T) {
	office := newOffice(t)
	dir := repoWithChanges(t)
	write(t, dir, "REAL-CANARY.txt", "REAL-CANARY\n")
	snapshot := office.demo(t)
	var ledger models.LiveAgent
	for _, agent := range snapshot.Agents {
		if agent.Name == "Ledger" {
			ledger = agent
		}
	}
	if err := office.engine.Do(func() { office.engine.Agent(ledger.ID).Folder = dir }); err != nil {
		t.Fatal(err)
	}
	code, changes := getChanges(t, office, "/api/agents/"+ledger.ID+"/changes")
	encoded, _ := json.Marshal(changes)
	if code != http.StatusOK || !changes.Demo || changes.State != models.ChangesRead || changes.FileCount == 0 ||
		strings.Contains(string(encoded), "CANARY") || strings.Contains(string(encoded), "new.txt") {
		t.Fatalf("%d: %s", code, encoded)
	}
	if changes.Files[0].Path != "src/billing/totals.ts" || changes.Files[0].Added == 0 {
		t.Errorf("first file = %+v", changes.Files[0])
	}
	// An agent with nothing to show has an empty list, not an error.
	for _, agent := range snapshot.Agents {
		if agent.Name == "Pixel" {
			if _, none := getChanges(t, office, "/api/agents/"+agent.ID+"/changes"); none.State != models.ChangesRead || none.FileCount != 0 || !none.Demo {
				t.Errorf("Pixel = %+v", none)
			}
		}
	}
	// And a demo project is every one of its agents' files together.
	_, project := getChanges(t, office, "/api/projects/checkout/changes")
	if !project.Demo || project.FileCount < 4 {
		t.Errorf("project = %+v", project)
	}
	if _, same := getChanges(t, office, "/api/projects/checkout/changes?version="+project.Version); same.State != models.ChangesUnchanged {
		t.Errorf("same = %+v", same)
	}
}

func TestAProjectsChangesComeFromItsFolder(t *testing.T) {
	office := newOffice(t)
	dir := repoWithChanges(t)
	attached := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	if response := office.do(t, http.MethodPatch, "/api/projects/"+attached.ID, `{"folder":"`+dir+`"}`); response.Code != http.StatusOK {
		t.Fatalf("attach = %d %s", response.Code, response.Body)
	}
	if code, changes := getChanges(t, office, "/api/projects/"+attached.ID+"/changes"); code != http.StatusOK ||
		changes.State != models.ChangesRead || changes.FileCount != 3 || changes.Folder != dir {
		t.Errorf("attached: %d %+v", code, changes)
	}

	// An agent on the project that works in a folder outside the project's own adds nothing: the
	// project's changes are those of its folder, whatever else its agents have been doing.
	outside := repoWithChanges(t)
	write(t, outside, "OUTSIDE-CANARY.txt", "outside\n")
	withRealAgent(t, office, "Wanderer", outside, &attached.ID)
	code, within := getChanges(t, office, "/api/projects/"+attached.ID+"/changes")
	encoded, _ := json.Marshal(within)
	if code != http.StatusOK || within.Folder != dir || within.FileCount != 3 || strings.Contains(string(encoded), "OUTSIDE-CANARY") {
		t.Errorf("with an agent working outside: %d %s", code, encoded)
	}

	// With no folder attached, the folder its agents share is the project's.
	shared := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Shared","color":"#FF6B9A"}`))
	withRealAgent(t, office, "Ledger", dir, &shared.ID)
	withRealAgent(t, office, "Atlas", dir, &shared.ID)
	if code, changes := getChanges(t, office, "/api/projects/"+shared.ID+"/changes"); code != http.StatusOK ||
		changes.State != models.ChangesRead || changes.FileCount != 3 {
		t.Errorf("shared: %d %+v", code, changes)
	}

	// Agents in different folders don't make a folder, and nor does nobody at all.
	split := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Split","color":"#7BED9F"}`))
	withRealAgent(t, office, "Quill", dir, &split.ID)
	withRealAgent(t, office, "Bolt", t.TempDir(), &split.ID)
	empty := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Empty","color":"#FECA57"}`))
	for _, project := range []models.Project{split, empty} {
		code, changes := getChanges(t, office, "/api/projects/"+project.ID+"/changes")
		if code != http.StatusOK || changes.State != models.ChangesNoFolder || !strings.Contains(changes.Message, "Attach") ||
			len(changes.Files) != 0 {
			t.Errorf("%s: %d %+v", project.Name, code, changes)
		}
	}
}

// Reading changes through the API leaves the repository exactly as it was.
func TestTheAPILeavesTheRepositoryAlone(t *testing.T) {
	office := newOffice(t)
	dir := repoWithChanges(t)
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "src/app.ts"), later, later); err != nil {
		t.Fatal(err)
	}
	agent, _ := withRealAgent(t, office, "Ledger", dir, nil)
	before := gitDirFingerprint(t, dir)
	for range 3 {
		if code, changes := getChanges(t, office, "/api/agents/"+agent.ID+"/changes"); code != http.StatusOK || changes.FileCount != 3 {
			t.Fatalf("%d: %+v", code, changes)
		}
	}
	if after := gitDirFingerprint(t, dir); after != before {
		t.Error("reading changes changed something under .git")
	}
}

func gitDirFingerprint(t *testing.T, dir string) string {
	t.Helper()
	sum := sha256.New()
	err := filepath.Walk(filepath.Join(dir, ".git"), func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(sum, "%s %d %d\n", path, info.Size(), info.ModTime().UnixNano())
		if info.Mode().IsRegular() {
			data, readErr := os.ReadFile(path) // #nosec G304 -- the test's own folder
			if readErr != nil {
				return readErr
			}
			sum.Write(data)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%x", sum.Sum(nil))
}

func TestASecondOpinionSendsTheDiffAsAnInstruction(t *testing.T) {
	office := newOffice(t)
	dir := repoWithChanges(t)
	write(t, dir, "config.env", "API_KEY=sk-ant-api03-abcdefghijklmnop\nPORT=80\n")
	author, _ := withRealAgent(t, office, "Ledger", dir, nil)
	reviewer, quill := withRealAgent(t, office, "Quill", t.TempDir(), nil)

	response := office.do(t, http.MethodPost, "/api/agents/"+author.ID+"/changes/opinion", `{"reviewerId":"`+reviewer.ID+`"}`)
	result := decode[opinionResult](t, response)
	if response.Code != http.StatusOK || result.AgentID != reviewer.ID || result.InstructionID == "" || !result.Queued ||
		!strings.Contains(result.Notice, "Asked Quill for a second opinion on Ledger's changes") {
		t.Fatalf("%d %s", response.Code, response.Body)
	}
	text := quill.last(t)
	for _, want := range []string{
		"Second opinion wanted: review the changes Ledger made in " + dir + " (4 files, +",
		"--- src/app.ts (modified, +2 -1)", "-two", "+TWO", "+four", "--- old.txt (deleted", "--- new.txt (untracked",
		"don't edit any files or run anything",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the instruction lacks %q:\n%s", want, text)
		}
	}
	// What the reviewer is sent has been through the secret filter.
	if strings.Contains(text, "sk-ant-api03-abcdefghijklmnop") || !strings.Contains(text, "PORT=80") {
		t.Errorf("secrets in the instruction:\n%s", text)
	}
	// It is an instruction like any other: it is on the reviewer, waiting for its checkpoint, and in the log.
	var queued, logged bool
	_ = office.engine.Do(func() {
		for _, instruction := range office.engine.Agent(reviewer.ID).Queued {
			queued = queued || (instruction.ID == result.InstructionID && instruction.Text == text)
		}
	})
	// The snapshot takes the engine's lock itself, so it is read outside Do.
	for _, entry := range office.engine.Snapshot().Log {
		logged = logged || (entry.Type == models.LogInstruction && strings.HasPrefix(entry.Message, "Second opinion wanted"))
	}
	if !queued || !logged {
		t.Errorf("queued %v, logged %v", queued, logged)
	}
}

func TestASecondOpinionIsRefusedWhenItCannotBeGiven(t *testing.T) {
	office := newOffice(t)
	dir := repoWithChanges(t)
	author, _ := withRealAgent(t, office, "Ledger", dir, nil)
	reviewer, quill := withRealAgent(t, office, "Quill", t.TempDir(), nil)
	clean, _ := withRealAgent(t, office, "Clean", t.TempDir(), nil)
	gitIn(t, clean.Folder, "init", "-q")
	notRepo, _ := withRealAgent(t, office, "Plain", t.TempDir(), nil)
	for name, tc := range map[string]struct {
		path, body string
		want       int
	}{
		"itself":          {"/api/agents/" + author.ID + "/changes/opinion", `{"reviewerId":"` + author.ID + `"}`, http.StatusBadRequest},
		"nobody":          {"/api/agents/" + author.ID + "/changes/opinion", `{"reviewerId":"cc-nobody"}`, http.StatusNotFound},
		"no one named":    {"/api/agents/" + author.ID + "/changes/opinion", `{}`, http.StatusNotFound},
		"nothing changed": {"/api/agents/" + clean.ID + "/changes/opinion", `{"reviewerId":"` + reviewer.ID + `"}`, http.StatusConflict},
		"not a repo":      {"/api/agents/" + notRepo.ID + "/changes/opinion", `{"reviewerId":"` + reviewer.ID + `"}`, http.StatusConflict},
		"empty body":      {"/api/agents/" + author.ID + "/changes/opinion", ``, http.StatusBadRequest},
	} {
		if response := office.do(t, http.MethodPost, tc.path, tc.body); response.Code != tc.want {
			t.Errorf("%s = %d %s, want %d", name, response.Code, response.Body, tc.want)
		}
	}
	if quill.count() != 0 {
		t.Errorf("something was sent anyway: %q", quill.last(t))
	}
}

// A second opinion is only an instruction. It can't settle an approval: an agent waiting on one
// stays waiting, with the approval still open, and the instruction waits too.
func TestASecondOpinionCannotSettleAnApproval(t *testing.T) {
	office := newOffice(t)
	snapshot := office.demo(t)
	var atlas, ledger models.LiveAgent
	for _, agent := range snapshot.Agents {
		switch agent.Name {
		case "Atlas":
			atlas = agent
		case "Ledger":
			ledger = agent
		}
	}
	if atlas.State != models.StateApproval || atlas.Approval == nil {
		t.Skipf("the demo's Atlas isn't waiting on an approval (%s)", atlas.State)
	}
	response := office.do(t, http.MethodPost, "/api/agents/"+ledger.ID+"/changes/opinion", `{"reviewerId":"`+atlas.ID+`"}`)
	result := decode[opinionResult](t, response)
	if response.Code != http.StatusOK || !result.Queued {
		t.Fatalf("%d %s", response.Code, response.Body)
	}
	_ = office.engine.Do(func() {
		agent := office.engine.Agent(atlas.ID)
		if agent.State != models.StateApproval || agent.Approval == nil || agent.Approval.Decision != nil {
			t.Errorf("Atlas = %s, approval %+v", agent.State, agent.Approval)
		}
	})
	if settings := decode[models.Settings](t, office.do(t, http.MethodGet, "/api/settings", "")); settings.AutoApprove.On {
		t.Error("auto approve is on")
	}
}

// The demo's reviewers are given the summary and the file names, not a diff they can't read.
func TestADemoReviewerGetsTheSummary(t *testing.T) {
	office := newOffice(t)
	snapshot := office.demo(t)
	var ledger, scout models.LiveAgent
	for _, agent := range snapshot.Agents {
		switch agent.Name {
		case "Ledger":
			ledger = agent
		case "Scout":
			scout = agent
		}
	}
	response := office.do(t, http.MethodPost, "/api/agents/"+ledger.ID+"/changes/opinion", `{"reviewerId":"`+scout.ID+`"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("%d %s", response.Code, response.Body)
	}
	var text string
	for _, entry := range office.engine.Snapshot().Log {
		if strings.HasPrefix(entry.Message, "Second opinion wanted") {
			text = entry.Message
		}
	}
	if !strings.HasPrefix(text, "Second opinion wanted: review the changes Ledger made in ~/code/shop (3 files") ||
		!strings.Contains(text, "src/billing/totals.ts (modified)") || strings.Contains(text, "@@") || len(text) > 600 {
		t.Errorf("text = %q", text)
	}
}

func TestAProjectsSecondOpinion(t *testing.T) {
	office := newOffice(t)
	dir := repoWithChanges(t)
	project := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	office.do(t, http.MethodPatch, "/api/projects/"+project.ID, `{"folder":"`+dir+`"}`)
	reviewer, quill := withRealAgent(t, office, "Quill", t.TempDir(), nil)
	response := office.do(t, http.MethodPost, "/api/projects/"+project.ID+"/changes/opinion", `{"reviewerId":"`+reviewer.ID+`"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("%d %s", response.Code, response.Body)
	}
	if text := quill.last(t); !strings.HasPrefix(text, "Second opinion wanted: review the changes the Shop team made in "+dir) ||
		!strings.Contains(text, "+TWO") {
		t.Errorf("text = %q", text)
	}
}
