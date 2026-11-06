// SPDX-License-Identifier: Apache-2.0

package store

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestMigratesFromEmpty(t *testing.T) {
	version, err := open(t).SchemaVersion(context.Background())
	must(t, err)
	if version != 4 {
		t.Errorf("version = %d", version)
	}
}

func TestReopenKeepsDataAndDoesNotRerunMigrations(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "nested", "mabari.db")
	first, err := Open(ctx, path)
	must(t, err)
	must(t, first.SaveProject(ctx, models.Project{ID: "p", Name: "Docs", Files: []string{"a"}}))
	must(t, first.Close())

	second, err := Open(ctx, path)
	must(t, err)
	defer func() { _ = second.Close() }()
	projects, err := second.Projects(ctx)
	must(t, err)
	if len(projects) != 1 || projects[0].Name != "Docs" || projects[0].Files[0] != "a" {
		t.Errorf("projects = %+v", projects)
	}
}

func TestDatabaseIsPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no Unix file modes")
	}
	path := filepath.Join(t.TempDir(), "data", "mabari.db")
	s, err := Open(context.Background(), path)
	must(t, err)
	defer func() { _ = s.Close() }()
	file, err := os.Stat(path)
	must(t, err)
	if file.Mode().Perm() != 0o600 {
		t.Errorf("file mode = %o", file.Mode().Perm())
	}
	dir, err := os.Stat(filepath.Dir(path))
	must(t, err)
	if dir.Mode().Perm() != 0o700 {
		t.Errorf("folder mode = %o", dir.Mode().Perm())
	}
}

func TestAgentRoundTrip(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	agent := models.LiveAgent{
		Agent:        models.Agent{ID: "a", Name: "Scout", AllowedTools: []string{"read"}},
		SessionState: models.SessionState{State: models.StateEditing, Progress: 0.4},
	}
	agent.Estimate = &models.Estimate{SecondsLeft: 10}
	must(t, s.SaveAgent(ctx, agent))
	agent.Progress = 0.5
	must(t, s.SaveAgent(ctx, agent))

	agents, err := s.Agents(ctx)
	must(t, err)
	if len(agents) != 1 || agents[0].Name != "Scout" || agents[0].Progress != 0.5 ||
		agents[0].Estimate == nil || agents[0].AllowedTools[0] != "read" {
		t.Errorf("agents = %+v", agents)
	}

	must(t, s.DeleteAgent(ctx, "a"))
	agents, err = s.Agents(ctx)
	must(t, err)
	if len(agents) != 0 {
		t.Errorf("after delete: %+v", agents)
	}
}

func TestEventsNewestFirstWithPaging(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	for i, id := range []string{"x-1", "x-2", "x-3"} {
		must(t, s.AddEvent(ctx, models.Event{ID: id, Agent: "a", Time: int64(i + 1), Tool: "t"}))
	}
	events, err := s.Events(ctx, "a", 2, 0)
	must(t, err)
	if len(events) != 2 || events[0].ID != "x-3" {
		t.Errorf("events = %+v", events)
	}
	events, err = s.Events(ctx, "a", 2, 2)
	must(t, err)
	if len(events) != 1 || events[0].ID != "x-1" {
		t.Errorf("page = %+v", events)
	}
}

func TestLogSearchAndFilter(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	rows := []models.LogEntry{
		{ID: "1", Time: 1, Agent: "Sage", Type: models.LogInstruction, Message: "Add 100% coverage"},
		{ID: "2", Time: 2, Agent: "Scout", Type: models.LogQuery, Message: "What now"},
		{ID: "3", Time: 3, Agent: "Atlas", Type: models.LogApproval, Outcome: "Denied"},
	}
	for _, row := range rows {
		must(t, s.SaveLog(ctx, row))
	}
	cases := []struct {
		query LogQuery
		want  []string
	}{
		{LogQuery{}, []string{"3", "2", "1"}},
		{LogQuery{Type: models.LogQuery}, []string{"2"}},
		{LogQuery{Search: "sage"}, []string{"1"}},
		{LogQuery{Search: "denied"}, []string{"3"}},
		{LogQuery{Search: "%"}, []string{"1"}},
		{LogQuery{Search: "_"}, nil},
		{LogQuery{Limit: 1}, []string{"3"}},
		{LogQuery{Agent: "Scout"}, []string{"2"}},
		// The agent filter is the whole name, not a part of it.
		{LogQuery{Agent: "Sco"}, nil},
		{LogQuery{Outcome: "Denied"}, []string{"3"}},
		{LogQuery{Since: 2}, []string{"3", "2"}},
		{LogQuery{Until: 2}, []string{"2", "1"}},
		{LogQuery{Since: 2, Until: 2}, []string{"2"}},
		// The search box finds a type too, as the page's own filter does.
		{LogQuery{Search: "approval"}, []string{"3"}},
		{LogQuery{Search: "sco", Type: models.LogQuery, Agent: "Scout"}, []string{"2"}},
	}
	for _, tc := range cases {
		entries, err := s.Log(ctx, tc.query)
		must(t, err)
		var got []string
		for _, entry := range entries {
			got = append(got, entry.ID)
		}
		if len(got) != len(tc.want) {
			t.Errorf("%+v: got %v, want %v", tc.query, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("%+v: got %v, want %v", tc.query, got, tc.want)
			}
		}
	}
}

func TestRetentionBoundary(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	must(t, s.AddEvent(ctx, models.Event{ID: "old", Agent: "a", Time: 99}))
	must(t, s.AddEvent(ctx, models.Event{ID: "keep", Agent: "a", Time: 100}))
	must(t, s.SaveLog(ctx, models.LogEntry{ID: "old", Time: 99}))
	must(t, s.SaveLog(ctx, models.LogEntry{ID: "keep", Time: 100}))

	events, log, err := s.DeleteOlderThan(ctx, 100)
	must(t, err)
	if events != 1 || log != 1 {
		t.Errorf("deleted %d events and %d log rows", events, log)
	}
	left, err := s.Events(ctx, "a", 10, 0)
	must(t, err)
	if len(left) != 1 || left[0].ID != "keep" {
		t.Errorf("left = %+v", left)
	}
}

func TestSettingsFillInDefaults(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	settings, err := s.Settings(ctx)
	must(t, err)
	if settings.RetentionDays != 30 {
		t.Errorf("default retention = %d", settings.RetentionDays)
	}
	settings.RetentionDays = 7
	must(t, s.SaveSettings(ctx, settings))
	settings, err = s.Settings(ctx)
	must(t, err)
	if settings.RetentionDays != 7 || settings.QueryModel == "" {
		t.Errorf("settings = %+v", settings)
	}
}

// Every table holds a row before the wipe and none after it, so a table added later without
// joining Wipe fails this test.
func TestWipeEmptiesEverything(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	must(t, s.SaveProject(ctx, models.Project{ID: "p"}))
	must(t, s.SaveAccount(ctx, models.Account{ID: "a", Kind: models.AccountHub}))
	agent := models.LiveAgent{}
	agent.ID, agent.Name = "agent", "Mori"
	must(t, s.SaveAgent(ctx, agent))
	must(t, s.AddEvent(ctx, models.Event{ID: "mori-1", Agent: "agent", Tool: "read"}))
	must(t, s.AddMessage(ctx, models.Message{ID: "m", From: "agent", To: []string{"agent"}}))
	must(t, s.SaveInstruction(ctx, models.Instruction{ID: "i", Agent: &agent.ID, Text: "hi"}))
	must(t, s.SaveApproval(ctx, models.Approval{ID: "ap", Agent: "agent"}))
	must(t, s.SaveLog(ctx, models.LogEntry{ID: "l", Agent: "Mori"}))
	must(t, s.SaveConversationItem(ctx, models.ConversationItem{ID: "c", Agent: "agent", Seq: 1}))
	must(t, s.AddStateChange(ctx, models.StateChange{AgentID: "agent", Agent: "Mori", Phase: models.PhaseWorking}))
	must(t, s.SaveSettings(ctx, models.DefaultSettings()))
	must(t, s.SetMeta(ctx, "k", "v"))

	counts := func() map[string]int {
		rows, err := s.db.QueryContext(ctx,
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		must(t, err)
		var tables []string
		for rows.Next() {
			var name string
			must(t, rows.Scan(&name))
			tables = append(tables, name)
		}
		must(t, rows.Close())
		found := map[string]int{}
		for _, table := range tables {
			var count int
			// Table names come from sqlite_master, not from input.
			must(t, s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count)) // #nosec G202
			found[table] = count
		}
		return found
	}
	for table, count := range counts() {
		if count == 0 {
			t.Errorf("the test seeds nothing in %s", table)
		}
	}
	must(t, s.Wipe(ctx))
	for table, count := range counts() {
		if count != 0 {
			t.Errorf("%s keeps %d rows after the wipe", table, count)
		}
	}
	if value, err := s.Meta(ctx, "k"); err != nil || value != "" {
		t.Errorf("meta = %q, %v", value, err)
	}
}

// Rows written before the log was masked have their secrets masked in place, and the rest of the
// row stays as it was.
func TestRedactLogMasksOldRowsOnce(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	const secret = "ghp_abcdefghijklmnopqrstuvwxyz"
	must(t, s.SaveLog(ctx, models.LogEntry{
		ID: "old", Time: 5, Agent: "Atlas", Type: models.LogInstruction, Message: "push with " + secret,
		Outcome: "Failed: " + secret, Chip: "red",
	}))
	must(t, s.SaveLog(ctx, models.LogEntry{ID: "plain", Time: 6, Agent: "Atlas", Type: models.LogQuery, Message: "Nothing here", Outcome: "Fine"}))
	must(t, s.RedactLog(ctx))
	rows, err := s.Log(ctx, LogQuery{})
	must(t, err)
	if len(rows) != 2 {
		t.Fatalf("rows = %+v", rows)
	}
	plain, old := rows[0], rows[1]
	if old.Message != "push with "+redact.Mask || old.Outcome != "Failed: "+redact.Mask || old.Chip != "red" || old.Time != 5 {
		t.Errorf("old row = %+v", old)
	}
	if plain.Message != "Nothing here" || plain.Outcome != "Fine" {
		t.Errorf("plain row = %+v", plain)
	}
	if found, err := s.Log(ctx, LogQuery{Search: secret}); err != nil || len(found) != 0 {
		t.Errorf("searching for the secret found %+v, %v", found, err)
	}
	// It is a one time pass over what was already there, not a cost on every start.
	must(t, s.SaveLog(ctx, models.LogEntry{ID: "later", Time: 7, Agent: "Atlas", Type: models.LogQuery, Message: secret}))
	must(t, s.RedactLog(ctx))
	if rows, err := s.Log(ctx, LogQuery{Search: secret}); err != nil || len(rows) != 1 {
		t.Errorf("the pass ran twice: %+v, %v", rows, err)
	}
}
