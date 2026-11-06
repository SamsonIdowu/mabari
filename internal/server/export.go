// SPDX-License-Identifier: Apache-2.0

package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// exportLimit is the most rows one export holds, whatever it asks for.
const exportLimit = 10000

// exportRow is a log entry as an export has it: secrets hidden, and the time written out.
type exportRow struct {
	ID      string         `json:"id"`
	Time    string         `json:"time"`
	Agent   string         `json:"agent"`
	Type    models.LogType `json:"type"`
	Message string         `json:"message"`
	Outcome string         `json:"outcome"`
	Chip    string         `json:"chip"`
}

func exportRows(entries []models.LogEntry) []exportRow {
	rows := make([]exportRow, 0, len(entries))
	for _, entry := range entries {
		rows = append(rows, exportRow{
			ID:      entry.ID,
			Time:    time.UnixMilli(entry.Time).UTC().Format(time.RFC3339),
			Agent:   redact.Text(entry.Agent),
			Type:    entry.Type,
			Message: redact.Text(entry.Message),
			Outcome: redact.Text(entry.Outcome),
			Chip:    entry.Chip,
		})
	}
	return rows
}

// A spreadsheet reads a cell as a formula when it begins with = + - or @. A cell begins at the start
// of a field, and also after any separator the person's own settings may split the file on: a
// comma, a semicolon (the list separator of Excel in many languages), a tab or a pipe, or a line
// break. So a field such as x;=cmd() is a formula in a spreadsheet that splits on semicolons.
const (
	formulaStarts = "=+-@"
	// cellSeparators are what a cell can begin after, besides the start of its field.
	cellSeparators = ";,|\t\r\n"
	// leadingBreaks in front of anything count as a trigger too, as spreadsheets advise.
	leadingBreaks = "\t\r\n"
)

// plainForm folds the look-alikes of the characters this cares about to the ordinary ones, one
// character for one character, so positions stay the same. It is what Unicode's compatibility
// normalisation does to the full-width forms, which is all that matters here: ＝ ＋ － ＠ and the
// full-width separators, the small forms ﹦ ﹢ ﹣ ﹫, the mathematical minus, and any kind of space.
// A tab, carriage return and line feed stay as they are, because they separate cells.
func plainForm(r rune) rune {
	switch {
	case r >= 0xFF01 && r <= 0xFF5E: // Full-width ASCII.
		return r - 0xFEE0
	case r == 0xFE66:
		return '='
	case r == 0xFE62:
		return '+'
	case r == 0xFE63, r == 0x2212:
		return '-'
	case r == 0xFE6B:
		return '@'
	case r == '\t', r == '\r', r == '\n':
		return r
	case unicode.IsSpace(r):
		return ' '
	}
	return r
}

// dangerousAt reports whether a cell could begin at runes[at] and run as a formula: after any
// blanks, a character that starts one. At the start of the text, a tab, carriage return or line
// feed is enough on its own.
func dangerousAt(runes []rune, at int, first bool) bool {
	next := at
	for next < len(runes) && unicode.IsSpace(runes[next]) {
		next++
	}
	if next < len(runes) && strings.ContainsRune(formulaStarts, plainForm(runes[next])) {
		return true
	}
	return first && at < len(runes) && strings.ContainsRune(leadingBreaks, runes[at])
}

// safeCell makes a cell harmless in a spreadsheet. Wherever one could begin, at the start of the
// text and after each separator, if a formula could start there, even after spaces or in full-width
// forms, a quote is put in front, which spreadsheets show as plain text. So a row an agent or a
// person wrote can't run anything when the file is opened, however the file is read. Text that
// can't begin a formula is returned as it was.
func safeCell(text string) string {
	runes := []rune(text)
	var safe strings.Builder
	atCell := true
	for index, r := range runes {
		if atCell && dangerousAt(runes, index, index == 0) {
			safe.WriteByte('\'')
		}
		atCell = strings.ContainsRune(cellSeparators, plainForm(r))
		safe.WriteRune(r)
	}
	return safe.String()
}

// exportName is the file's name, with the date it was made.
func exportName(now time.Time, format string) string {
	return "mabari-activity-" + now.Format(time.DateOnly) + "." + format
}

// exportActivity downloads the activity log as CSV or JSON, narrowed by the same filters as the
// Activity page and GET /api/activity: q, type and agent, and limit for how many of the newest rows.
// Nothing leaves in it that the log's own pages wouldn't show, and secrets are hidden.
func (a *api) exportActivity(w http.ResponseWriter, r *http.Request) {
	format := r.URL.Query().Get("format")
	if format != "csv" && format != "json" {
		writeError(w, http.StatusBadRequest, "format must be csv or json")
		return
	}
	query := logQueryOf(r)
	query.Limit = int(min(positiveQuery(r, "limit", 500), exportLimit))
	entries, err := a.engine.Store().Log(r.Context(), query)
	if err != nil {
		internalError(w, err)
		return
	}
	rows := exportRows(entries)
	var body bytes.Buffer
	var contentType string
	switch format {
	case "json":
		contentType = "application/json"
		encoder := json.NewEncoder(&body)
		encoder.SetIndent("", "  ")
		err = encoder.Encode(rows)
	default:
		contentType = "text/csv; charset=utf-8"
		writeCSV(&body, rows)
	}
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", `attachment; filename="`+exportName(a.engine.Now(), format)+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(body.Bytes())
}

// writeCSV writes the rows with every field in double quotes, so a reader that respects quoting
// keeps each cell whole whatever separator it is set to, and the cells made safe never meet one.
func writeCSV(body *bytes.Buffer, rows []exportRow) {
	record := func(fields ...string) {
		for index, field := range fields {
			if index > 0 {
				body.WriteByte(',')
			}
			body.WriteByte('"')
			body.WriteString(strings.ReplaceAll(field, `"`, `""`))
			body.WriteByte('"')
		}
		body.WriteByte('\n')
	}
	record("Time", "Agent", "Type", "Message", "Outcome")
	for _, row := range rows {
		record(row.Time, safeCell(row.Agent), safeCell(string(row.Type)), safeCell(row.Message), safeCell(row.Outcome))
	}
}

// logQueryOf reads the log's filters from a request: q, type and agent.
func logQueryOf(r *http.Request) store.LogQuery {
	return store.LogQuery{
		Search: r.URL.Query().Get("q"),
		Type:   models.LogType(r.URL.Query().Get("type")),
		Agent:  r.URL.Query().Get("agent"),
	}
}
