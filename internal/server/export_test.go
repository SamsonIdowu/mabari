// SPDX-License-Identifier: Apache-2.0

package server

import (
	"encoding/csv"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// seedLog writes rows into the activity log, newest last.
func seedLog(t *testing.T, o *office, rows ...models.LogEntry) {
	t.Helper()
	if err := o.engine.Do(func() {
		for _, row := range rows {
			o.engine.Log(row.Agent, row.Type, row.Message, row.Outcome, row.Chip)
		}
	}); err != nil {
		t.Fatal(err)
	}
}

func readCSV(t *testing.T, response *httptest.ResponseRecorder) [][]string {
	t.Helper()
	records, err := csv.NewReader(strings.NewReader(response.Body.String())).ReadAll()
	if err != nil {
		t.Fatalf("not CSV: %v\n%s", err, response.Body)
	}
	return records
}

func exportOf(t *testing.T, o *office, query string) *httptest.ResponseRecorder {
	t.Helper()
	response := o.do(t, http.MethodGet, "/api/activity/export?"+query, "")
	if response.Code != http.StatusOK {
		t.Fatalf("export %s = %d %s", query, response.Code, response.Body)
	}
	return response
}

func TestExportCSV(t *testing.T) {
	o := newOffice(t)
	seedLog(t, o,
		models.LogEntry{Agent: "Atlas", Type: models.LogInstruction, Message: "Use the money helper, not toFixed", Outcome: "Delivered", Chip: "ok"},
		models.LogEntry{Agent: "Scout", Type: models.LogQuery, Message: "Which library?\nSecond line with \"quotes\"", Outcome: "Answered from the log"},
		models.LogEntry{Agent: "Atlas", Type: models.LogApproval, Message: "rm -rf ./tmp", Outcome: "Denied", Chip: "red"},
	)
	response := exportOf(t, o, "format=csv")
	if got := response.Header().Get("Content-Type"); got != "text/csv; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}
	disposition := response.Header().Get("Content-Disposition")
	today := o.engine.Now().Format("2006-01-02")
	if want := `attachment; filename="mabari-activity-` + today + `.csv"`; disposition != want {
		t.Errorf("Content-Disposition = %q, want %q", disposition, want)
	}
	if response.Header().Get("X-Content-Type-Options") != "nosniff" || response.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("headers = %v", response.Header())
	}
	records := readCSV(t, response)
	if len(records) != 4 {
		t.Fatalf("%d records: %v", len(records), records)
	}
	if got := strings.Join(records[0], "|"); got != "Time|Agent|Type|Message|Outcome" {
		t.Errorf("header = %s", got)
	}
	// Newest first, as the page shows them, with commas, quotes and line breaks intact.
	if got := strings.Join(records[1][1:], "|"); got != "Atlas|Approval|rm -rf ./tmp|Denied" {
		t.Errorf("first row = %s", got)
	}
	if got := records[2][3]; got != "Which library?\nSecond line with \"quotes\"" {
		t.Errorf("second row's message = %q", got)
	}
	if got := records[3][3]; got != "Use the money helper, not toFixed" {
		t.Errorf("third row's message = %q", got)
	}
	// The time is written out so a person can read it.
	if _, err := time.Parse(time.RFC3339, records[1][0]); err != nil {
		t.Errorf("time %q: %v", records[1][0], err)
	}
}

type exportedRow struct {
	ID      string `json:"id"`
	Time    string `json:"time"`
	Agent   string `json:"agent"`
	Type    string `json:"type"`
	Message string `json:"message"`
	Outcome string `json:"outcome"`
	Chip    string `json:"chip"`
}

func TestExportJSON(t *testing.T) {
	o := newOffice(t)
	seedLog(t, o,
		models.LogEntry{Agent: "Atlas", Type: models.LogInstruction, Message: "Use the money helper", Outcome: "Delivered", Chip: "ok"},
		models.LogEntry{Agent: "Atlas", Type: models.LogApproval, Message: "rm -rf ./tmp", Outcome: "Denied", Chip: "red"},
	)
	response := exportOf(t, o, "format=json")
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if !strings.HasSuffix(response.Header().Get("Content-Disposition"), `.json"`) {
		t.Errorf("Content-Disposition = %q", response.Header().Get("Content-Disposition"))
	}
	rows := decode[[]exportedRow](t, response)
	if len(rows) != 2 || rows[0].Message != "rm -rf ./tmp" || rows[0].Type != "Approval" || rows[0].Chip != "red" ||
		rows[1].Outcome != "Delivered" || rows[0].ID == "" {
		t.Errorf("rows = %+v", rows)
	}
	if _, err := time.Parse(time.RFC3339, rows[0].Time); err != nil {
		t.Errorf("time %q: %v", rows[0].Time, err)
	}
	// Nothing to export is an empty list, not null.
	empty := newOffice(t)
	if got := strings.TrimSpace(exportOf(t, empty, "format=json").Body.String()); got != "[]" {
		t.Errorf("empty export = %q", got)
	}
}

func TestExportNeedsAFormat(t *testing.T) {
	o := newOffice(t)
	for _, query := range []string{"", "format=", "format=xml", "format=CSV", "format=csv%0d"} {
		if response := o.do(t, http.MethodGet, "/api/activity/export?"+query, ""); response.Code != http.StatusBadRequest {
			t.Errorf("%q = %d", query, response.Code)
		}
	}
}

// Export narrows the log with the same filters as the page and GET /api/activity do.
func TestExportTakesTheSameFiltersAsTheActivityRoute(t *testing.T) {
	o := newOffice(t)
	seedLog(t, o,
		models.LogEntry{Agent: "Atlas", Type: models.LogInstruction, Message: "Use the money helper", Outcome: "Delivered"},
		models.LogEntry{Agent: "Scout", Type: models.LogQuery, Message: "Which library?", Outcome: "Answered"},
		models.LogEntry{Agent: "Atlas", Type: models.LogApproval, Message: "rm -rf ./tmp", Outcome: "Denied"},
		models.LogEntry{Agent: "Atlas scribe", Type: models.LogInstruction, Message: "Write the changelog", Outcome: "Delivered"},
		models.LogEntry{Agent: "Mori", Type: models.LogSession, Message: "Stopped", Outcome: "Error"},
	)
	cases := []struct {
		name, query string
		want        int
	}{
		{"everything", "", 5},
		{"a word", "q=changelog", 1},
		{"a word in the outcome", "q=denied", 1},
		{"a word in the type", "q=session", 1},
		{"a type", "type=Instruction", 2},
		{"an agent, by its whole name", "agent=Atlas", 2},
		{"an agent whose name starts the same", "agent=Atlas%20scribe", 1},
		{"a type and an agent", "type=Instruction&agent=Atlas", 1},
		{"all three", "type=Approval&agent=Atlas&q=tmp", 1},
		{"nothing matches", "q=zzz", 0},
		{"a limit", "limit=2", 2},
	}
	for _, test := range cases {
		activity := decode[[]models.LogEntry](t, o.do(t, http.MethodGet, "/api/activity?"+test.query, ""))
		if len(activity) != test.want {
			t.Errorf("%s: /api/activity has %d rows, want %d", test.name, len(activity), test.want)
		}
		csvRows := readCSV(t, exportOf(t, o, "format=csv&"+test.query))
		if len(csvRows)-1 != test.want {
			t.Errorf("%s: the CSV has %d rows, want %d", test.name, len(csvRows)-1, test.want)
		}
		jsonRows := decode[[]exportedRow](t, exportOf(t, o, "format=json&"+test.query))
		if len(jsonRows) != test.want {
			t.Errorf("%s: the JSON has %d rows, want %d", test.name, len(jsonRows), test.want)
		}
		// The same rows, in the same order.
		for index, row := range jsonRows {
			if row.ID != activity[index].ID {
				t.Errorf("%s: row %d is %s in the export and %s in the log", test.name, index, row.ID, activity[index].ID)
			}
		}
	}
}

// What an agent said, or what a person typed, can carry a secret. It never leaves in an export.
func TestExportHidesSecrets(t *testing.T) {
	o := newOffice(t)
	const key = "sk-ant-api03-PLANTEDSECRETKEY123456"
	const token = "ghp_PlantedGithubToken0123456789abcdef"
	seedLog(t, o,
		models.LogEntry{Agent: "Atlas", Type: models.LogInstruction, Message: "Deploy with " + key + " today", Outcome: "Delivered"},
		models.LogEntry{Agent: "Atlas", Type: models.LogApproval, Message: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x.test",
			Outcome: "Allowed with " + token},
		models.LogEntry{Agent: "Agent " + key, Type: models.LogSession, Message: "password=hunter2hunter2", Outcome: "ok"},
	)
	for _, format := range []string{"csv", "json"} {
		body := exportOf(t, o, "format="+format).Body.String()
		for _, secret := range []string{key, "PLANTEDSECRETKEY", token, "abcdefghijklmnop", "hunter2hunter2"} {
			if strings.Contains(body, secret) {
				t.Errorf("the %s export has %q in it:\n%s", format, secret, body)
			}
		}
		if !strings.Contains(body, "[redacted]") {
			t.Errorf("the %s export hides nothing:\n%s", format, body)
		}
		if !strings.Contains(body, "Deploy with") {
			t.Errorf("the %s export lost the rest of the row:\n%s", format, body)
		}
	}
}

// A cell a spreadsheet would read as a formula is made plain text with a quote in front.
func TestExportCSVNeutralisesFormulas(t *testing.T) {
	o := newOffice(t)
	cells := []string{
		"=HYPERLINK(\"http://evil.test\",\"click\")", "+SUM(1,1)", "-2+3", "@SUM(A1)",
		"\t=1+1", "\r=1+1", "\n=1+1",
	}
	var rows []models.LogEntry
	for _, cell := range cells {
		rows = append(rows, models.LogEntry{Agent: cell, Type: models.LogInstruction, Message: cell, Outcome: cell})
	}
	rows = append(rows,
		models.LogEntry{Agent: "Plain", Type: models.LogQuery, Message: "no formula = here, 5 - 3, a+b, user@example.com", Outcome: "ok"},
		models.LogEntry{Agent: "Quote", Type: models.LogQuery, Message: "'already quoted", Outcome: "ok"},
	)
	seedLog(t, o, rows...)
	response := exportOf(t, o, "format=csv")
	records := readCSV(t, response)
	if len(records) != len(rows)+1 {
		t.Fatalf("%d records", len(records))
	}
	for _, record := range records[1:] {
		for index, cell := range record {
			if index == 0 || cell == "" {
				continue
			}
			// Nothing a spreadsheet would run starts any cell.
			if strings.ContainsAny(cell[:1], "=+-@\t\r\n") {
				t.Errorf("a cell starts like a formula: %q in %q", cell, record)
			}
		}
	}
	// Each dangerous cell is still there, with only the quote added.
	byAgent := map[string][]string{}
	for _, record := range records[1:] {
		byAgent[record[1]] = record
	}
	for _, cell := range cells {
		want := "'" + cell
		// A tab, carriage return or line feed also separates cells for a spreadsheet set to split
		// on it, so what follows it gets its own quote.
		if strings.ContainsAny(cell[:1], "\t\r\n") {
			want = "'" + cell[:1] + "'" + cell[1:]
		}
		record := byAgent[want]
		if record == nil || record[3] != want || record[4] != want {
			t.Errorf("%q came out as %q, want %q", cell, record, want)
		}
	}
	// What was harmless is left exactly as it was.
	if plain := byAgent["Plain"]; plain[3] != "no formula = here, 5 - 3, a+b, user@example.com" {
		t.Errorf("a plain cell changed: %q", plain[3])
	}
	if quoted := byAgent["Quote"]; quoted[3] != "'already quoted" {
		t.Errorf("a quoted cell changed: %q", quoted[3])
	}
}

// JSON isn't opened in a spreadsheet, so it keeps what was written.
func TestExportJSONKeepsFormulasAsWritten(t *testing.T) {
	o := newOffice(t)
	seedLog(t, o, models.LogEntry{Agent: "Atlas", Type: models.LogInstruction, Message: "=1+1", Outcome: "Delivered"})
	if rows := decode[[]exportedRow](t, exportOf(t, o, "format=json")); rows[0].Message != "=1+1" {
		t.Errorf("message = %q", rows[0].Message)
	}
}

func TestExportStopsAtItsLimit(t *testing.T) {
	o := newOffice(t)
	var rows []models.LogEntry
	for i := range 12 {
		rows = append(rows, models.LogEntry{Agent: "Atlas", Type: models.LogSession, Message: "row " + strconv.Itoa(i), Outcome: "ok"})
	}
	seedLog(t, o, rows...)
	if got := len(readCSV(t, exportOf(t, o, "format=csv&limit=4"))) - 1; got != 4 {
		t.Errorf("limit=4 gave %d rows", got)
	}
	// With no limit it holds what the page holds, and a huge one is held to the cap.
	if got := len(readCSV(t, exportOf(t, o, "format=csv"))) - 1; got != 12 {
		t.Errorf("no limit gave %d rows", got)
	}
	if got := len(readCSV(t, exportOf(t, o, "format=csv&limit=99999999"))) - 1; got != 12 {
		t.Errorf("a huge limit gave %d rows", got)
	}
}

func TestExportRefusesAnotherWebsite(t *testing.T) {
	o := newOffice(t)
	request := httptest.NewRequest(http.MethodGet, "http://localhost:4317/api/activity/export?format=csv", nil)
	request.Header.Set("Origin", "https://evil.example")
	recorder := httptest.NewRecorder()
	o.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Errorf("another website = %d", recorder.Code)
	}
	request = httptest.NewRequest(http.MethodGet, "http://evil.example/api/activity/export?format=csv", nil)
	request.Host = "evil.example"
	recorder = httptest.NewRecorder()
	o.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Errorf("another name = %d", recorder.Code)
	}
}

// Export has the checks every route has: a name other than this computer's is refused, another
// website's page is refused, and where a sign in is needed, so is it here.
func TestExportHasTheSameAccessChecks(t *testing.T) {
	o := newAccessOffice(t, true)
	seedLog(t, o.office, models.LogEntry{Agent: "Atlas", Type: models.LogApproval, Message: "rm -rf ./tmp", Outcome: "Denied"})
	for _, path := range []string{"/api/activity/export?format=csv", "/api/activity/export?format=json"} {
		if response := o.call(t, http.MethodGet, path, "", docker, local, ""); !needsSignIn(response) {
			t.Errorf("%s from Docker without a sign in = %d %s", path, response.Code, response.Body)
		}
		if response := o.call(t, http.MethodGet, path, "", phone, "192.168.1.5:4317", ""); !needsSignIn(response) {
			t.Errorf("%s from a phone without a sign in = %d", path, response.Code)
		}
		// DNS rebinding: a website's own name pointed at this computer still has to sign in.
		if response := o.call(t, http.MethodGet, path, "", here, "evil.example", ""); !needsSignIn(response) {
			t.Errorf("%s under another name = %d", path, response.Code)
		}
	}
	token := o.signIn(t, docker, local)
	response := o.call(t, http.MethodGet, "/api/activity/export?format=csv", "", docker, local, token)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "rm -rf ./tmp") {
		t.Errorf("signed in = %d %s", response.Code, response.Body)
	}
	if response := o.call(t, http.MethodGet, "/api/activity/export?format=csv", "", docker, local, "not.asession"); !needsSignIn(response) {
		t.Errorf("a forged session = %d", response.Code)
	}
}
