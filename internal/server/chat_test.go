// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/connectors/simulator"
	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// chatOffice is a demo office with a data folder, which is where attachments and saved
// instructions go.
type chatOffice struct {
	*office
	data string
}

func newChatOffice(t *testing.T) *chatOffice {
	t.Helper()
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
	sim := simulator.New(engine, simulator.Mulberry32(7), 0)
	data := t.TempDir()
	return &chatOffice{
		office: &office{
			handler: New(Options{Engine: engine, Simulator: sim, DataDir: data}),
			engine:  engine, simulator: sim,
		},
		data: data,
	}
}

func asJSON(value any) string {
	out, _ := json.Marshal(value)
	return string(out)
}

// idle sets an agent to rest, so a message to it is taken at once, and returns it.
func (o *office) idle(name string) models.LiveAgent {
	var copied models.LiveAgent
	_ = o.engine.Do(func() {
		agent := o.engine.AgentByName(name)
		agent.State = models.StateIdle
		copied = *agent
	})
	return copied
}

func (o *office) said(t *testing.T, id string) []models.ConversationItem {
	t.Helper()
	items, _, err := o.engine.Store().Conversation(context.Background(), id, 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	return items
}

func (o *office) lastUserText(t *testing.T, id string) string {
	t.Helper()
	items := o.said(t, id)
	for index := len(items) - 1; index >= 0; index-- {
		if items[index].Kind == models.ConversationUser {
			return items[index].Text
		}
	}
	return ""
}

func (o *chatOffice) upload(t *testing.T, name, body string) Attachment {
	t.Helper()
	response := o.do(t, http.MethodPost, "/api/attachments?name="+url.QueryEscape(name), body)
	if response.Code != http.StatusCreated {
		t.Fatalf("upload %q: %d %s", name, response.Code, response.Body.String())
	}
	return decode[Attachment](t, response)
}

func TestAMessageIsForOneAgentOrOneProject(t *testing.T) {
	o := newChatOffice(t)
	o.demo(t)
	for _, body := range []map[string]any{
		{"text": "hi"},
		{"agentId": "a", "projectId": "p", "text": "hi"},
	} {
		if response := o.do(t, http.MethodPost, "/api/chat/send", asJSON(body)); response.Code != http.StatusBadRequest {
			t.Errorf("%v = %d", body, response.Code)
		}
	}
	missing := o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{"agentId": "nobody", "text": "hi"}))
	if missing.Code != http.StatusNotFound {
		t.Errorf("an unknown agent = %d", missing.Code)
	}
	empty := o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{"agentId": o.idle("Rune").ID, "text": "  "}))
	if empty.Code != http.StatusBadRequest {
		t.Errorf("an empty message = %d", empty.Code)
	}
}

func TestChatSendAddsFilesAndAnotherAgentsLatestReply(t *testing.T) {
	o := newChatOffice(t)
	o.demo(t)
	runeAgent, atlas := o.idle("Rune"), o.idle("Atlas")
	file := o.upload(t, "notes.txt", "remember the milk")
	if !strings.HasPrefix(file.Path, filepath.Join(o.data, "attachments")) || filepath.Base(file.Path) != "notes.txt" {
		t.Fatalf("stored at %q", file.Path)
	}
	reply := ""
	for _, item := range o.said(t, atlas.ID) {
		if item.Kind == models.ConversationAssistant {
			reply = item.Text
		}
	}
	if reply == "" {
		t.Fatal("Atlas has said nothing to quote")
	}
	response := o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{
		"agentId": runeAgent.ID, "text": "use what Atlas found", "mentions": []string{atlas.ID, runeAgent.ID, "nobody"},
		"attachments": []string{file.ID, "../etc", "0000000000000000"},
	}))
	if response.Code != http.StatusOK {
		t.Fatalf("send = %d %s", response.Code, response.Body.String())
	}
	text := o.lastUserText(t, runeAgent.ID)
	for _, want := range []string{"use what Atlas found", "Context, Atlas's latest reply:", "> " + strings.Split(reply, "\n")[0], "- " + file.Path} {
		if !strings.Contains(text, want) {
			t.Errorf("the agent was sent %q, missing %q", text, want)
		}
	}
	// An agent can't be its own context, and only files Mabari stored are named.
	if strings.Contains(text, "Rune's latest reply") || strings.Contains(text, "etc") || strings.Count(text, "- /") != 1 {
		t.Errorf("sent %q", text)
	}
}

func TestPlanFirstAsksInWordsWhereThereIsNoPlanMode(t *testing.T) {
	o := newChatOffice(t)
	o.demo(t)
	agent := o.idle("Rune")
	response := o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{
		"agentId": agent.ID, "text": "add a login page", "plan": true,
	}))
	if response.Code != http.StatusOK {
		t.Fatalf("send = %d %s", response.Code, response.Body.String())
	}
	text := o.lastUserText(t, agent.ID)
	if !strings.HasPrefix(text, "Plan first.") || !strings.HasSuffix(text, "add a login page") {
		t.Fatalf("sent %q", text)
	}
}

func TestChatSendSwitchesTheModelOnlyWhereItIsTrue(t *testing.T) {
	o := newChatOffice(t)
	o.demo(t)
	agent := o.idle("Rune")
	allowed := models.Models[agent.Account]
	other := allowed[0]
	if other == agent.Model {
		other = allowed[1]
	}
	send := func(model string) *httptest.ResponseRecorder {
		return o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{
			"agentId": agent.ID, "text": "carry on", "model": model,
		}))
	}
	if response := send("not-a-model"); response.Code != http.StatusConflict {
		t.Errorf("a model the account doesn't offer = %d", response.Code)
	}
	if response := send(other); response.Code != http.StatusOK {
		t.Fatalf("switch = %d %s", response.Code, response.Body.String())
	}
	var now string
	_ = o.engine.Do(func() { now = o.engine.Agent(agent.ID).Model })
	if now != other {
		t.Errorf("model = %q, want %q", now, other)
	}
}

func TestAHandedOverReplyReachesTheOtherAgentWithItsContext(t *testing.T) {
	o := newChatOffice(t)
	o.demo(t)
	runeAgent, atlas := o.idle("Rune"), o.idle("Atlas")
	var reply models.ConversationItem
	for _, item := range o.said(t, runeAgent.ID) {
		if item.Kind == models.ConversationAssistant {
			reply = item
		}
	}
	hand := func(id, itemID, to, note string) *httptest.ResponseRecorder {
		return o.do(t, http.MethodPost, "/api/agents/"+id+"/hand", asJSON(map[string]any{"itemId": itemID, "to": to, "note": note}))
	}
	if response := hand(runeAgent.ID, reply.ID, atlas.ID, "please review this"); response.Code != http.StatusOK {
		t.Fatalf("hand = %d %s", response.Code, response.Body.String())
	}
	text := o.lastUserText(t, atlas.ID)
	for _, want := range []string{"Handed over from Rune", "It was answering:", "Its reply:", "> " + strings.Split(reply.Text, "\n")[0], "please review this"} {
		if !strings.Contains(text, want) {
			t.Errorf("Atlas was sent %q, missing %q", text, want)
		}
	}
	items := o.said(t, runeAgent.ID)
	if last := items[len(items)-1]; last.Kind != models.ConversationNotice || !strings.Contains(last.Text, "Handed this reply to Atlas") {
		t.Errorf("Rune's thread ends with %+v", last)
	}
	// Only what the agent really said can be handed over, and only to someone who is here.
	for name, response := range map[string]*httptest.ResponseRecorder{
		"a made up reply": hand(runeAgent.ID, "item-forged", atlas.ID, ""),
		"to itself":       hand(runeAgent.ID, reply.ID, runeAgent.ID, ""),
		"to nobody":       hand(runeAgent.ID, reply.ID, "gone", ""),
		"from nobody":     hand("gone", reply.ID, atlas.ID, ""),
	} {
		if response.Code < 400 {
			t.Errorf("%s = %d", name, response.Code)
		}
	}
	// What a person said is not a reply.
	var said models.ConversationItem
	for _, item := range o.said(t, runeAgent.ID) {
		if item.Kind == models.ConversationUser {
			said = item
		}
	}
	if response := hand(runeAgent.ID, said.ID, atlas.ID, ""); response.Code != http.StatusNotFound {
		t.Errorf("handing over a user message = %d", response.Code)
	}
}

func TestAskEveryoneSendsToEachAgentOnTheProjectAndKeepsTheRound(t *testing.T) {
	o := newChatOffice(t)
	snapshot := o.demo(t)
	byProject := map[string][]string{}
	for _, agent := range snapshot.Agents {
		if agent.Project != nil && agent.Lead == nil {
			byProject[*agent.Project] = append(byProject[*agent.Project], agent.Name)
		}
	}
	var project string
	for id, names := range byProject {
		if len(names) >= 2 {
			project = id
		}
	}
	if project == "" {
		t.Fatal("no demo project has two agents")
	}
	for _, name := range byProject[project] {
		o.idle(name)
	}
	response := o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{
		"projectId": project, "everyone": true, "text": "status in one line?",
	}))
	if response.Code != http.StatusOK {
		t.Fatalf("ask = %d %s", response.Code, response.Body.String())
	}
	result := decode[chatResult](t, response)
	if result.Ask == nil || len(result.Ask.Agents) != len(byProject[project]) {
		t.Fatalf("ask = %+v, want %d agents", result.Ask, len(byProject[project]))
	}
	for _, asked := range result.Ask.Agents {
		if !strings.Contains(o.lastUserText(t, asked.ID), "status in one line?") {
			t.Errorf("%s was not asked", asked.Name)
		}
	}
	// The round is still there after a reload, and only for its project.
	asks := decode[[]Ask](t, o.do(t, http.MethodGet, "/api/projects/"+project+"/asks", ""))
	if len(asks) != 1 || asks[0].ID != result.Ask.ID || asks[0].Text != "status in one line?" {
		t.Errorf("asks = %+v", asks)
	}
	others := decode[[]Ask](t, o.do(t, http.MethodGet, "/api/projects/nothing/asks", ""))
	if len(others) != 0 {
		t.Errorf("another project's asks = %+v", others)
	}
	// A project with nobody on it has nobody to ask.
	created := decode[models.Project](t, o.do(t, http.MethodPost, "/api/projects", `{"name":"Empty","color":"#48DBFB"}`))
	empty := o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{"projectId": created.ID, "everyone": true, "text": "anyone?"}))
	if empty.Code != http.StatusConflict {
		t.Errorf("asking nobody = %d", empty.Code)
	}
}

func TestAskEveryoneLeavesOutAgentsInError(t *testing.T) {
	o := newChatOffice(t)
	snapshot := o.demo(t)
	var project string
	var names []string
	for _, agent := range snapshot.Agents {
		if agent.Project != nil && agent.Lead == nil {
			if project == "" || *agent.Project == project {
				project = *agent.Project
				names = append(names, agent.Name)
			}
		}
	}
	if len(names) < 2 {
		t.Skip("the first demo project has fewer than two agents")
	}
	for _, name := range names {
		o.idle(name)
	}
	var broken string
	_ = o.engine.Do(func() {
		agent := o.engine.AgentByName(names[0])
		agent.State, broken = models.StateError, agent.ID
	})
	result := decode[chatResult](t, o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{
		"projectId": project, "everyone": true, "text": "status?",
	})))
	for _, asked := range result.Ask.Agents {
		if asked.ID == broken {
			t.Errorf("asked the agent in error")
		}
	}
}

func TestAttachmentsAreKeptUnderTheDataFolderWhateverTheyAreCalled(t *testing.T) {
	o := newChatOffice(t)
	for _, name := range []string{"../../escape.sh", `..\..\escape.sh`, "/etc/passwd", ".hidden", "bad\nname\x00.txt", ""} {
		file := o.upload(t, name, "x")
		inside, err := filepath.Rel(filepath.Join(o.data, "attachments"), file.Path)
		if err != nil || strings.HasPrefix(inside, "..") || strings.Count(filepath.ToSlash(inside), "/") != 1 {
			t.Errorf("%q was stored at %q", name, file.Path)
		}
		if strings.ContainsAny(file.Name, "\n\x00/\\") || strings.HasPrefix(file.Name, ".") || file.Name == "" {
			t.Errorf("%q became %q", name, file.Name)
		}
		if body, _ := os.ReadFile(file.Path); string(body) != "x" {
			t.Errorf("%q kept %q", name, body)
		}
	}
	if _, err := os.Stat(filepath.Join(o.data, "escape.sh")); err == nil {
		t.Error("a file escaped the attachments folder")
	}
}

func TestAnAttachmentOver25MegabytesIsRefusedAndLeavesNothing(t *testing.T) {
	o := newChatOffice(t)
	response := o.do(t, http.MethodPost, "/api/attachments?name=big.bin", strings.Repeat("x", maxAttachment+1))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d", response.Code)
	}
	entries, _ := os.ReadDir(filepath.Join(o.data, "attachments"))
	if len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
}

func TestAWipeRemovesAttachments(t *testing.T) {
	o := newChatOffice(t)
	file := o.upload(t, "gone.txt", "x")
	if response := o.do(t, http.MethodPost, "/api/wipe", `{"confirm":true}`); response.Code != http.StatusOK {
		t.Fatalf("wipe = %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(file.Path); err == nil {
		t.Error("the attachment survived a wipe")
	}
}

func TestSavedInstructions(t *testing.T) {
	o := newChatOffice(t)
	create := func(name, text string) *httptest.ResponseRecorder {
		return o.do(t, http.MethodPost, "/api/saved-instructions", asJSON(map[string]string{"name": name, "text": text}))
	}
	made := decode[Saved](t, create("  Review   the diff ", "Review the diff and list risks."))
	if made.Name != "Review the diff" || made.ID == "" {
		t.Fatalf("saved = %+v", made)
	}
	for name, response := range map[string]*httptest.ResponseRecorder{
		"a repeat name":   create("review THE diff", "other"),
		"no name":         create("  ", "text"),
		"a long name":     create(strings.Repeat("n", savedNameMax+1), "text"),
		"a control name":  create("bad\x07", "text"),
		"no text":         create("Empty", ""),
		"an endless text": create("Long", strings.Repeat("t", maxPrompt+1)),
	} {
		if response.Code < 400 {
			t.Errorf("%s = %d", name, response.Code)
		}
	}
	listed := decode[[]Saved](t, o.do(t, http.MethodGet, "/api/saved-instructions", ""))
	if len(listed) != 1 || listed[0].Text != "Review the diff and list risks." {
		t.Fatalf("listed = %+v", listed)
	}
	if response := o.do(t, http.MethodDelete, "/api/saved-instructions/nope", ""); response.Code != http.StatusNotFound {
		t.Errorf("deleting what isn't there = %d", response.Code)
	}
	if response := o.do(t, http.MethodDelete, "/api/saved-instructions/"+made.ID, ""); response.Code != http.StatusNoContent {
		t.Errorf("delete = %d", response.Code)
	}
	if listed := decode[[]Saved](t, o.do(t, http.MethodGet, "/api/saved-instructions", "")); len(listed) != 0 {
		t.Errorf("after delete = %+v", listed)
	}
}

func TestSavedInstructionsStopAtTheLimit(t *testing.T) {
	o := newChatOffice(t)
	for index := range savedMax {
		response := o.do(t, http.MethodPost, "/api/saved-instructions", asJSON(map[string]string{"name": "n" + string(rune('a'+index%26)) + string(rune('a'+index/26)), "text": "x"}))
		if response.Code != http.StatusCreated {
			t.Fatalf("%d = %d", index, response.Code)
		}
	}
	if response := o.do(t, http.MethodPost, "/api/saved-instructions", `{"name":"one more","text":"x"}`); response.Code != http.StatusConflict {
		t.Errorf("past the limit = %d", response.Code)
	}
}

// folderOffice is a demo office whose agent Rune works in a real folder with files in it.
func folderOffice(t *testing.T, files map[string]string) (*chatOffice, models.LiveAgent, string) {
	t.Helper()
	o := newChatOffice(t)
	o.demo(t)
	folder := t.TempDir()
	for name, body := range files {
		path := filepath.Join(folder, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var agent models.LiveAgent
	_ = o.engine.Do(func() {
		live := o.engine.AgentByName("Rune")
		live.Folder = folder
		agent = *live
	})
	return o, agent, folder
}

func TestFilesCompleteInsideTheAgentsFolderOnly(t *testing.T) {
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("no"), 0o600); err != nil {
		t.Fatal(err)
	}
	o, agent, folder := folderOffice(t, map[string]string{
		"README.md":                 "x",
		"src/app.ts":                "x",
		"src/components/Button.tsx": "x",
		"docs/guide.md":             "x",
		".env":                      "SECRET=1",
		"node_modules/lib/index.js": "x",
		".git/config":               "x",
		"build/out.js":              "x",
		"bad\nname.txt":             "x",
	})
	if err := os.Symlink(outside, filepath.Join(folder, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(folder, "secret-link.txt")); err != nil {
		t.Fatal(err)
	}
	list := func(query string) []ChatFile {
		response := o.do(t, http.MethodGet, "/api/chat/files?agent="+agent.ID+"&q="+url.QueryEscape(query), "")
		if response.Code != http.StatusOK {
			t.Fatalf("files %q = %d %s", query, response.Code, response.Body.String())
		}
		return decode[chatFilesResult](t, response).Files
	}
	paths := func(files []ChatFile) []string {
		var out []string
		for _, file := range files {
			out = append(out, file.Path)
		}
		return out
	}
	all := paths(list(""))
	for _, want := range []string{"README.md", "src/", "src/app.ts", "docs/guide.md"} {
		if !slices.Contains(all, want) {
			t.Errorf("%q missing from %v", want, all)
		}
	}
	for _, hidden := range []string{".env", ".git/config", "node_modules/lib/index.js", "build/out.js", "link/", "link/secret.txt", "secret-link.txt"} {
		if slices.Contains(all, hidden) {
			t.Errorf("%q was offered: %v", hidden, all)
		}
	}
	for _, path := range all {
		if strings.ContainsAny(path, "\n\x00") {
			t.Errorf("%q has a control character", path)
		}
	}
	// A name that starts with what was typed comes first, and a folder shows with a slash.
	if got := paths(list("app")); len(got) == 0 || got[0] != "src/app.ts" {
		t.Errorf("app = %v", got)
	}
	if got := paths(list("src")); len(got) == 0 || got[0] != "src/" {
		t.Errorf("src = %v", got)
	}
	// Letters in order find a file by its initials.
	if got := paths(list("scb")); !slices.Contains(got, "src/components/Button.tsx") {
		t.Errorf("scb = %v", got)
	}
	// Dot files are offered when they are asked for.
	if got := paths(list(".en")); !slices.Contains(got, ".env") {
		t.Errorf(".en = %v", got)
	}
	// Never from a path the page names.
	if response := o.do(t, http.MethodGet, "/api/chat/files?path=/etc", ""); response.Code != http.StatusBadRequest {
		t.Errorf("a path = %d", response.Code)
	}
	if response := o.do(t, http.MethodGet, "/api/chat/files?agent=gone", ""); decode[chatFilesResult](t, response).Files == nil {
		t.Error("an agent that has gone should give an empty list, not null")
	}
}

func TestAProjectsFilesComeFromItsFolder(t *testing.T) {
	o := newChatOffice(t)
	snapshot := o.demo(t)
	folder := t.TempDir()
	if err := os.WriteFile(filepath.Join(folder, "plan.md"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	id := snapshot.Projects[0].ID
	if response := o.do(t, http.MethodPatch, "/api/projects/"+id, asJSON(map[string]string{"folder": folder})); response.Code != http.StatusOK {
		t.Fatalf("folder = %d %s", response.Code, response.Body.String())
	}
	files := decode[chatFilesResult](t, o.do(t, http.MethodGet, "/api/chat/files?project="+id+"&q=plan", "")).Files
	if len(files) != 1 || files[0].Path != "plan.md" {
		t.Errorf("files = %+v", files)
	}
}

func TestCommandsAndSkillsFromTheFolderAndTheAccount(t *testing.T) {
	o := newRunOffice(t)
	// The agent starts first: a folder with commands of its own needs a click before a session runs
	// there, and what this looks at is listing them.
	agent := o.start(t)
	write := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(o.folder, ".claude", "commands", "ux-audit.md"), "---\ndescription: Audit the UX\n---\nLook at $ARGUMENTS")
	write(filepath.Join(o.folder, ".claude", "commands", "review.md"), "Review the folder's way")
	write(filepath.Join(o.folder, ".claude", "skills", "ship", "SKILL.md"), "---\nname: ship-it\ndescription: Ship a release\n---\nSteps")
	write(filepath.Join(o.config, "commands", "review.md"), "---\ndescription: Review, account wide\n---\n")
	write(filepath.Join(o.config, "commands", "standup.md"), "# Write the standup\nBody")
	write(filepath.Join(o.config, "skills", "tidy", "SKILL.md"), "---\ndescription: Tidy up\n---\n")
	write(filepath.Join(o.config, "commands", "not a command.md"), "x")
	write(filepath.Join(o.config, "commands", "notes.txt"), "x")
	if response := o.do(t, http.MethodPost, "/api/saved-instructions", `{"name":"Review","text":"Review the diff"}`); response.Code != http.StatusCreated {
		t.Fatalf("save = %d %s", response.Code, response.Body.String())
	}
	result := decode[chatCommandsResult](t, o.do(t, http.MethodGet, "/api/chat/commands?agent="+agent.ID, ""))
	got := map[string]ChatCommand{}
	for _, command := range result.Commands {
		got[command.Kind+":"+command.Name] = command
	}
	want := map[string][2]string{
		"command:ux-audit": {"folder", "Audit the UX"},
		"command:review":   {"folder", "Review the folder's way"},
		"skill:ship-it":    {"folder", "Ship a release"},
		"command:standup":  {"account", "Write the standup"},
		"skill:tidy":       {"account", "Tidy up"},
	}
	for key, expected := range want {
		if found, ok := got[key]; !ok || found.Scope != expected[0] || found.Description != expected[1] {
			t.Errorf("%s = %+v, want %v", key, found, expected)
		}
	}
	if len(got) != len(want) {
		t.Errorf("commands = %+v", result.Commands)
	}
	if len(result.Saved) != 1 || result.Saved[0].Name != "Review" {
		t.Errorf("saved = %+v", result.Saved)
	}
}

func TestChatSendToASessionMabariRunsAsksForAPlanAndSwitchesModel(t *testing.T) {
	o := newRunOffice(t)
	agent := o.start(t)
	o.until(t, "the turn to end", func() bool { return o.state(agent.ID).State == models.StateDone })
	response := o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{
		"agentId": agent.ID, "text": "add a login page", "plan": true,
	}))
	if response.Code != http.StatusOK {
		t.Fatalf("plan = %d %s", response.Code, response.Body.String())
	}
	o.until(t, "a plan to ask about", func() bool {
		saved := o.state(agent.ID)
		return saved.Approval != nil && saved.Approval.Type == models.ApprovalPlan
	})
	// In plan mode Claude Code holds the session to it, so the words aren't added as well.
	for _, item := range o.conversation(t, agent.ID).Items {
		if item.Kind == models.ConversationUser && strings.Contains(item.Text, "add a login page") && strings.Contains(item.Text, "Plan first") {
			t.Errorf("asked in words as well: %q", item.Text)
		}
	}
	// A working session can't switch model, and nothing is sent when it can't.
	busy := o.state(agent.ID)
	if busy.Approval == nil {
		t.Fatal("expected an approval to still be waiting")
	}
	refused := o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{
		"agentId": agent.ID, "text": "faster please", "model": "claude-haiku-4-5",
	}))
	if refused.Code != http.StatusConflict {
		t.Errorf("switching model while waiting on an approval = %d %s", refused.Code, refused.Body.String())
	}
}

func TestChatSendQueuesForAWorkingSessionAndNowInterruptsIt(t *testing.T) {
	o := newRunOffice(t)
	response := o.do(t, http.MethodPost, "/api/agents", strings.Replace(o.agentBody(""), `"task":"say hello"`, `"task":"fake:hang"`, 1))
	if response.Code != http.StatusCreated {
		t.Fatalf("start = %d %s", response.Code, response.Body.String())
	}
	agent := decode[models.LiveAgent](t, response)
	o.until(t, "work to start", func() bool { return o.said(t, agent.ID, "Working on it.") })
	queued := decode[chatResult](t, o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{
		"agentId": agent.ID, "text": "when you can, also do this",
	})))
	if !queued.Queued || queued.InstructionID == "" {
		t.Fatalf("a working session should queue: %+v", queued)
	}
	now := decode[chatResult](t, o.do(t, http.MethodPost, "/api/chat/send", asJSON(map[string]any{
		"agentId": agent.ID, "text": "stop, do this instead", "now": true,
	})))
	if now.Queued {
		t.Fatalf("send now queued: %+v", now)
	}
	o.until(t, "the new message to be answered", func() bool { return o.said(t, agent.ID, "Done: stop, do this instead") })
}

// A full wipe removes what the person wrote, including what isn't in the database, and asks with it.
func TestAWipeRemovesSavedInstructionsAndAsks(t *testing.T) {
	o := newChatOffice(t)
	if response := o.do(t, http.MethodPost, "/api/saved-instructions", `{"name":"review","text":"review the diff"}`); response.Code != http.StatusCreated {
		t.Fatalf("save = %d %s", response.Code, response.Body.String())
	}
	saved := filepath.Join(o.data, "saved-instructions.json")
	if _, err := os.Stat(saved); err != nil {
		t.Fatal(err)
	}
	_ = o.engine.Do(func() { o.engine.SetMeta(store.MetaAsks, `[{"id":"a","projectId":"p","text":"secret plans"}]`) })
	if response := o.do(t, http.MethodPost, "/api/wipe", `{"confirm":true}`); response.Code != http.StatusOK {
		t.Fatalf("wipe = %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(saved); !os.IsNotExist(err) {
		t.Fatalf("the saved instructions are still there: %v", err)
	}
	if list := decode[[]Saved](t, o.do(t, http.MethodGet, "/api/saved-instructions", "")); len(list) != 0 {
		t.Fatalf("list = %+v", list)
	}
	if asks := decode[[]Ask](t, o.do(t, http.MethodGet, "/api/projects/p/asks", "")); len(asks) != 0 {
		t.Fatalf("asks = %+v", asks)
	}
	// With nothing to remove, a wipe is still fine.
	if response := o.do(t, http.MethodPost, "/api/wipe", `{"confirm":true}`); response.Code != http.StatusOK {
		t.Fatalf("second wipe = %d %s", response.Code, response.Body.String())
	}
}

// The demo clears the office, so a project's asks go with the project.
func TestLoadingTheDemoForgetsAsks(t *testing.T) {
	o := newChatOffice(t)
	_ = o.engine.Do(func() { o.engine.SetMeta(store.MetaAsks, `[{"id":"a","projectId":"p","text":"secret plans"}]`) })
	if response := o.do(t, http.MethodPost, "/api/demo/load", ""); response.Code != http.StatusOK {
		t.Fatalf("demo = %d", response.Code)
	}
	if asks := decode[[]Ask](t, o.do(t, http.MethodGet, "/api/projects/p/asks", "")); len(asks) != 0 {
		t.Fatalf("asks = %+v", asks)
	}
}
