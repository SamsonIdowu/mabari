// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/launch"
	"github.com/SamsonIdowu/mabari/internal/models"
)

// fakeLauncher records the sessions Mabari asks for, without opening anything.
type fakeLauncher struct {
	mu       sync.Mutex
	requests []launch.Request
	err      error
}

func (f *fakeLauncher) Claude(_ context.Context, request launch.Request) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, request)
	return f.err
}

func (f *fakeLauncher) last(t *testing.T) launch.Request {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		t.Fatal("Claude Code was never opened")
	}
	return f.requests[len(f.requests)-1]
}

func newLaunchOffice(t *testing.T) (*office, *fakeLauncher) {
	t.Helper()
	office := newOffice(t)
	fake := &fakeLauncher{}
	office.handler = New(Options{Engine: office.engine, Simulator: office.simulator, Launcher: fake})
	_ = office.engine.Do(func() {
		for _, account := range office.engine.Accounts() {
			if account.Kind == models.AccountClaudeCode {
				account.Status = models.AccountConnected
				office.engine.SetAccount(account)
			}
		}
	})
	return office, fake
}

func projectNamed(t *testing.T, office *office, name string) models.Project {
	t.Helper()
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	for _, project := range snapshot.Projects {
		if project.Name == name {
			return project
		}
	}
	t.Fatalf("no project %s", name)
	return models.Project{}
}

// A project started from scratch gets its folder made, and Claude Code opens there with the brief.
func TestStartingAProjectOpensClaudeCodeInItsFolder(t *testing.T) {
	office, fake := newLaunchOffice(t)
	folder := filepath.Join(t.TempDir(), "coffee")
	reply := decode[planReply](t, office.do(t, http.MethodPost, "/api/planner", `{"said":["Build a coffee shop site"]}`))
	plan, _ := json.Marshal(reply.Plan)
	response := office.do(t, http.MethodPost, "/api/projects/start",
		`{"plan":`+string(plan)+`,"name":"Coffee shop","mode":"plan","folder":"`+folder+`","brief":"Sell beans","instructions":"Use Go"}`)
	result := decode[map[string]any](t, response)
	if response.Code != http.StatusCreated || !strings.HasPrefix(result["notice"].(string), "Opened Claude Code in "+folder) {
		t.Fatalf("start = %d %v", response.Code, result)
	}
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		t.Fatalf("the folder wasn't made: %v", err)
	}
	request := fake.last(t)
	if request.Folder != folder || request.Name != "Coffee shop" || !request.Plan ||
		!strings.Contains(request.Prompt, "Sell beans") || !strings.Contains(request.Prompt, "Use Go") {
		t.Errorf("request = %+v", request)
	}
}

func TestAttachingAFolderToAProject(t *testing.T) {
	office, fake := newLaunchOffice(t)
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	// Claude Code needs a folder first.
	if response := office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/claude", `{}`); response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "Attach a folder to Shop first") {
		t.Fatalf("open without folder = %d %s", response.Code, response.Body)
	}
	for name, folder := range map[string]string{"relative": "code/shop", "missing": t.TempDir() + "/missing"} {
		if response := office.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+folder+`"}`); response.Code != http.StatusBadRequest {
			t.Errorf("%s = %d %s", name, response.Code, response.Body)
		}
	}
	folder := t.TempDir()
	if response := office.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+folder+`","name":"Shop 2"}`); response.Code != http.StatusOK {
		t.Fatalf("attach = %d %s", response.Code, response.Body)
	}
	project := projectNamed(t, office, "Shop 2")
	if project.Repository == nil || project.Repository.Path != folder {
		t.Fatalf("project = %+v", project)
	}
	response := office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/claude", `{}`)
	if result := decode[map[string]string](t, response); response.Code != http.StatusOK || !strings.HasPrefix(result["notice"], "Opened Claude Code in "+folder) {
		t.Fatalf("open = %d %v", response.Code, result)
	}
	if request := fake.last(t); request.Folder != folder || request.Name != "Shop 2" || request.Plan ||
		!strings.Contains(request.Prompt, "Look around this folder") {
		t.Errorf("request = %+v", request)
	}
}

// With no terminal to open, Mabari says what to run instead.
func TestOpeningClaudeCodeWithoutATerminal(t *testing.T) {
	office, fake := newLaunchOffice(t)
	fake.err = launch.ErrNoTerminal
	folder := t.TempDir()
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Shop","color":"#48DBFB"}`))
	_ = office.do(t, http.MethodPatch, "/api/projects/"+created.ID, `{"folder":"`+folder+`"}`)
	result := decode[map[string]string](t, office.do(t, http.MethodPost, "/api/projects/"+created.ID+"/claude", `{}`))
	if result["notice"] != "Run claude in "+folder+". The session joins Shop when it starts." {
		t.Errorf("notice = %q", result["notice"])
	}
}

func TestDeletingAProject(t *testing.T) {
	office, _ := newLaunchOffice(t)
	created := decode[models.Project](t, office.do(t, http.MethodPost, "/api/projects", `{"name":"Gone","color":"#48DBFB"}`))
	if response := office.do(t, http.MethodDelete, "/api/projects/"+created.ID, ""); response.Code != http.StatusNoContent {
		t.Fatalf("delete = %d %s", response.Code, response.Body)
	}
	snapshot := decode[models.Snapshot](t, office.do(t, http.MethodGet, "/api/snapshot", ""))
	for _, project := range snapshot.Projects {
		if project.ID == created.ID {
			t.Fatal("the project is still there")
		}
	}
}

func TestWithinFolder(t *testing.T) {
	for path, want := range map[string]bool{"/a/b": true, "/a/b/c": true, "/a/bc": false, "/a": false} {
		if got := withinFolder(path, "/a/b"); got != want {
			t.Errorf("%s = %v", path, got)
		}
	}
}
