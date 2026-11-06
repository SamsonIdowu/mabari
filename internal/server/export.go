// SPDX-License-Identifier: Apache-2.0

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

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

// An export holds a cell to this many characters, and says so where it cut one. Log text is short
// in practice; the limit keeps the work of hiding secrets and making cells safe bounded, whatever a
// row holds.
const (
	exportCellLimit = 10_000
	exportCut       = "… (cut)"
	// exportCheckEvery is how many rows are done between looks at whether the person has gone.
	exportCheckEvery = 256
)

func cutCell(text string) string {
	if utf8.RuneCountInString(text) <= exportCellLimit {
		return text
	}
	return models.Clip(text, exportCellLimit) + exportCut
}

// exportRows hides secrets and cuts long cells. Cutting comes first, so no more is searched for
// secrets than is kept, and a secret at the cut is still found, as what is kept of it is long enough
// to match. It stops with the context's error if the person who asked has gone.
func exportRows(ctx context.Context, entries []models.LogEntry) ([]exportRow, error) {
	rows := make([]exportRow, 0, len(entries))
	for index, entry := range entries {
		if index%exportCheckEvery == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		rows = append(rows, exportRow{
			ID:      entry.ID,
			Time:    time.UnixMilli(entry.Time).UTC().Format(time.RFC3339),
			Agent:   redact.Text(cutCell(entry.Agent)),
			Type:    entry.Type,
			Message: redact.Text(cutCell(entry.Message)),
			Outcome: redact.Text(cutCell(entry.Outcome)),
			Chip:    entry.Chip,
		})
	}
	return rows, nil
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

// isBlank is what a spreadsheet may skip over on its way to a formula: a space of any kind, or a
// double quote, which a reader that takes it for the start of a field drops. The tab, carriage
// return and line feed are blanks too, but they also separate cells, so they are handled apart.
func isBlank(f rune) bool { return f == ' ' || f == '"' }

// lineBreakIndex says which of the three separators that are also blanks f is, or -1.
func lineBreakIndex(f rune) int {
	switch f {
	case '\t':
		return 0
	case '\r':
		return 1
	case '\n':
		return 2
	}
	return -1
}

// safeCell makes a cell harmless in a spreadsheet. A cell could begin at the start of the text and
// after any separator, and if what follows is only blanks and quotes and then = + - or @, a formula
// could start there, so a quote goes in front of the cell, which spreadsheets show as plain text.
// Spaces, quotes and the full-width forms don't hide a formula from it. The tab, carriage return and
// line feed are blanks to a reader that doesn't split on them and separators to one that does, so
// the cell they begin gets its own quote, and so does the whole run of blanks they sit in. Text that
// can't begin a formula is returned as it was.
//
// It makes one pass, remembering where the current run of blanks began and where a cell would begin
// after the latest of each line break in it, so a cell of a million tabs costs a million steps. At
// most four quotes are added to a run, however long it is.
func safeCell(text string) string {
	runes := []rune(text)
	quote := make([]bool, len(runes)+1)
	// open is true while everything since the run began has been a blank: a formula character now
	// would start a cell. runStart is where the run began, and after[k] where a cell begins after
	// the latest tab, carriage return or line feed in it, or -1.
	open, runStart := true, 0
	after := [3]int{-1, -1, -1}
	begin := func(at int) {
		open, runStart, after = true, at, [3]int{-1, -1, -1}
	}
	for index, r := range runes {
		f := plainForm(r)
		switch k := lineBreakIndex(f); {
		case k >= 0:
			// A line break in front of anything is enough on its own, as spreadsheets advise.
			if index == 0 {
				quote[0] = true
			}
			if open {
				after[k] = index + 1
			} else {
				begin(index + 1)
			}
		case f == ';' || f == ',' || f == '|':
			begin(index + 1)
		case isBlank(f):
		case strings.ContainsRune(formulaStarts, f):
			if open {
				quote[runStart] = true
				for _, at := range after {
					if at >= 0 {
						quote[at] = true
					}
				}
			}
			open = false
		default:
			open = false
		}
	}
	var safe strings.Builder
	safe.Grow(len(text) + 4)
	for index, r := range runes {
		if quote[index] {
			safe.WriteByte('\'')
		}
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
	rows, err := exportRows(r.Context(), entries)
	var body bytes.Buffer
	var contentType string
	if err == nil {
		switch format {
		case "json":
			contentType = "application/json"
			encoder := json.NewEncoder(&body)
			encoder.SetIndent("", "  ")
			err = encoder.Encode(rows)
		default:
			contentType = "text/csv; charset=utf-8"
			err = writeCSV(r.Context(), &body, rows)
		}
	}
	if err != nil {
		// Nobody is there to answer when the person asked for it and left.
		if r.Context().Err() == nil {
			internalError(w, err)
		}
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", `attachment; filename="`+exportName(a.engine.Now(), format)+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(body.Bytes())
}

// writeCSV writes the rows with every field in double quotes, so a reader that respects quoting
// keeps each cell whole whatever separator it is set to, and the cells made safe never meet one. It
// stops with the context's error if the person who asked has gone.
func writeCSV(ctx context.Context, body *bytes.Buffer, rows []exportRow) error {
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
	for index, row := range rows {
		if index%exportCheckEvery == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		record(row.Time, safeCell(row.Agent), safeCell(string(row.Type)), safeCell(row.Message), safeCell(row.Outcome))
	}
	return nil
}

// logQueryOf reads the log's filters from a request: q, type and agent.
func logQueryOf(r *http.Request) store.LogQuery {
	return store.LogQuery{
		Search: r.URL.Query().Get("q"),
		Type:   models.LogType(r.URL.Query().Get("type")),
		Agent:  r.URL.Query().Get("agent"),
	}
}
