// SPDX-License-Identifier: Apache-2.0

package server

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"strings"
	"time"

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

// spreadsheetTriggers start a cell a spreadsheet would read as a formula: = + - and @, and a tab,
// carriage return or line feed in front of one.
const spreadsheetTriggers = "=+-@\t\r\n"

// safeCell makes a cell harmless in a spreadsheet. One that starts the way a formula does gets a
// quote in front, which spreadsheets show as plain text, so a row an agent or a person wrote can't
// run anything when the file is opened.
func safeCell(text string) string {
	if text != "" && strings.ContainsRune(spreadsheetTriggers, rune(text[0])) {
		return "'" + text
	}
	return text
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
		err = writeCSV(&body, rows)
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

func writeCSV(body *bytes.Buffer, rows []exportRow) error {
	writer := csv.NewWriter(body)
	if err := writer.Write([]string{"Time", "Agent", "Type", "Message", "Outcome"}); err != nil {
		return err
	}
	for _, row := range rows {
		if err := writer.Write([]string{
			row.Time, safeCell(row.Agent), safeCell(string(row.Type)), safeCell(row.Message), safeCell(row.Outcome),
		}); err != nil {
			return err
		}
	}
	writer.Flush()
	return writer.Error()
}

// logQueryOf reads the log's filters from a request: q, type and agent.
func logQueryOf(r *http.Request) store.LogQuery {
	return store.LogQuery{
		Search: r.URL.Query().Get("q"),
		Type:   models.LogType(r.URL.Query().Get("type")),
		Agent:  r.URL.Query().Get("agent"),
	}
}
