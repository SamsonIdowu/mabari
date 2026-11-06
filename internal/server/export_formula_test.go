// SPDX-License-Identifier: Apache-2.0

package server

import (
	"strings"
	"testing"
	"unicode"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// A cell is made harmless wherever a spreadsheet could begin a cell: at its start, and after a
// separator the person's own settings may use, such as ';' in many languages' versions of Excel.
func TestSafeCell(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"empty", "", ""},
		{"plain words", "Use the money helper", "Use the money helper"},
		{"an equals sign inside", "a=b and x = y", "a=b and x = y"},
		{"a command with flags", "git commit -m 'fix: the thing' --no-verify", "git commit -m 'fix: the thing' --no-verify"},
		{"arithmetic in prose", "5 - 3 is 2, and a+b, mail user@example.com", "5 - 3 is 2, and a+b, mail user@example.com"},
		{"a separator that is not followed by a formula", "one; two | three, four\tfive", "one; two | three, four\tfive"},
		{"already quoted", "'=1+1", "'=1+1"},

		{"equals", "=1+1", "'=1+1"},
		{"plus", "+1", "'+1"},
		{"minus", "-1", "'-1"},
		{"a lone minus", "-", "'-"},
		{"at", "@SUM(A1)", "'@SUM(A1)"},
		{"tab", "\t=1+1", "'\t'=1+1"},
		{"carriage return", "\r=1+1", "'\r'=1+1"},
		{"line feed", "\n=1+1", "'\n'=1+1"},
		{"a tab alone", "\tword", "'\tword"},

		{"after a semicolon", "x;=cmd()", "x;'=cmd()"},
		{"after a semicolon and a space", "x; =cmd()", "x;' =cmd()"},
		{"after a pipe", "a|+1", "a|'+1"},
		{"after a comma", "a,-1", "a,'-1"},
		{"after a tab", "a\t@SUM(1)", "a\t'@SUM(1)"},
		{"after a line break", "a\n=1+1", "a\n'=1+1"},
		{"after two separators", "x;;=cmd()", "x;;'=cmd()"},
		{"after every separator", "=a;+b;-c;@d", "'=a;'+b;'-c;'@d"},
		{"after leading spaces", "   =1+1", "'   =1+1"},
		{"after a non-breaking space", " =1+1", "' =1+1"},

		{"full-width equals", "＝1+1", "'＝1+1"},
		{"full-width plus", "＋1", "'＋1"},
		{"full-width minus", "－1", "'－1"},
		{"full-width at", "＠SUM(A1)", "'＠SUM(A1)"},
		{"full-width after a semicolon", "x;＝cmd()", "x;'＝cmd()"},
		{"full-width semicolon", "x；=cmd()", "x；'=cmd()"},
		{"full-width after an ideographic space", "　＝1", "'　＝1"},
		{"small equals sign", "﹦1", "'﹦1"},
		{"mathematical minus", "−1", "'−1"},
		{"full-width letters are only letters", "ＡＢＣ＝", "ＡＢＣ＝"},
	}
	for _, test := range cases {
		if got := safeCell(test.in); got != test.want {
			t.Errorf("%s: safeCell(%q) = %q, want %q", test.name, test.in, got, test.want)
		}
	}
}

// startsLikeAFormula is what a spreadsheet would run: after any leading space, = + - or @, in
// their ordinary or full-width forms.
func startsLikeAFormula(piece string) bool {
	piece = strings.TrimLeftFunc(piece, unicode.IsSpace)
	if piece == "" {
		return false
	}
	return strings.ContainsRune("=+-@＝＋－＠﹦﹢﹣﹫−", []rune(piece)[0])
}

// splitAnywhere cuts text at each of the separators a spreadsheet may be set to read, whatever
// quotes surround them: the worst case, a reader that takes no notice of quoting.
func splitAnywhere(text string) []string {
	return strings.FieldsFunc(text, func(r rune) bool { return strings.ContainsRune(";,|\t\r\n", r) })
}

// rawFields reads the raw text of a CSV file as the strictest reader would, and fails the test
// when a field isn't wrapped in double quotes. It returns each field's text between its quotes.
func rawFields(t *testing.T, body string) []string {
	t.Helper()
	var fields []string
	for i := 0; i < len(body); {
		if body[i] != '"' {
			t.Fatalf("a field at byte %d starts with %q, not a quote:\n%s", i, body[i:min(i+20, len(body))], body)
		}
		var field strings.Builder
		i++
		for ; ; i++ {
			if i >= len(body) {
				t.Fatalf("a field is never closed:\n%s", body)
			}
			if body[i] == '"' {
				if i+1 < len(body) && body[i+1] == '"' {
					field.WriteByte('"')
					i++
					continue
				}
				break
			}
			field.WriteByte(body[i])
		}
		i++ // The closing quote.
		fields = append(fields, field.String())
		if i < len(body) && (body[i] == ',' || body[i] == '\n') {
			i++
		} else if i < len(body) {
			t.Fatalf("a field is followed by %q, not a separator:\n%s", body[i], body)
		}
	}
	return fields
}

// Every field is quoted, so a reader that takes quoting into account keeps a cell whole, and one that
// doesn't still finds no cell that begins like a formula, whichever separator it splits on.
func TestExportCSVIsSafeWhicheverSeparatorTheSpreadsheetUses(t *testing.T) {
	o := newOffice(t)
	hostile := []string{
		"x;=cmd()", "x; =cmd()", "a|+1", "a,-1", "a\t@SUM(1)", "a\n=1+1", "a\r\n=1+1", "=1+1;=2+2",
		"＝1+1", "x;＝cmd()", "x；＝cmd()", "   =1+1", "　＋1", "x;\t-5", "ok;ok;=HYPERLINK(\"http://evil.test\")",
	}
	var rows []models.LogEntry
	for _, cell := range hostile {
		rows = append(rows, models.LogEntry{Agent: cell, Type: models.LogInstruction, Message: cell, Outcome: cell})
	}
	rows = append(rows, models.LogEntry{Agent: "Plain", Type: models.LogQuery, Message: "5 - 3, a+b; user@example.com", Outcome: "ok"})
	seedLog(t, o, rows...)
	body := exportOf(t, o, "format=csv").Body.String()

	// Quoted: the strict reading finds the header and every cell wrapped in quotes.
	fields := rawFields(t, body)
	if want := 5 * (len(rows) + 1); len(fields) != want {
		t.Fatalf("%d fields, want %d", len(fields), want)
	}
	if got := strings.Join(fields[:5], ","); got != "Time,Agent,Type,Message,Outcome" {
		t.Errorf("header = %s", got)
	}

	// Split on a ';' alone, as Excel set to many languages does, quotes or no quotes: no piece begins
	// like a formula. Likewise for the other separators, and for each cell by itself.
	for _, separators := range []string{";", ",", "|", "\t", ";,|\t\r\n"} {
		pieces := strings.FieldsFunc(body, func(r rune) bool { return strings.ContainsRune(separators, r) })
		for _, piece := range pieces {
			// A piece may open with the quote that wraps its field.
			if startsLikeAFormula(strings.TrimPrefix(piece, `"`)) {
				t.Errorf("read with %q, a piece begins like a formula: %q", separators, piece)
			}
		}
	}
	for index, field := range fields {
		if index < 5 {
			continue
		}
		for _, piece := range splitAnywhere(field) {
			if startsLikeAFormula(piece) {
				t.Errorf("a piece of %q begins like a formula: %q", field, piece)
			}
		}
	}

	// Read with a proper CSV reader, each hostile cell is still there, only with a quote added where a
	// formula could begin, and the plain row is as it was.
	parsed := readCSV(t, exportOf(t, o, "format=csv"))
	if len(parsed) != len(rows)+1 {
		t.Fatalf("%d records", len(parsed))
	}
	byAgent := map[string][]string{}
	for _, record := range parsed[1:] {
		byAgent[record[1]] = record
	}
	if plain := byAgent["Plain"]; plain[3] != "5 - 3, a+b; user@example.com" {
		t.Errorf("a plain cell changed: %q", plain[3])
	}
	for _, cell := range hostile {
		made := safeCell(cell)
		record := byAgent[made]
		if made == cell || record == nil || record[3] != made || record[4] != made {
			t.Errorf("%q came out as %q", cell, record)
		}
	}
}

// The same rows read with ';' as the delimiter, by a CSV reader that takes no notice of quotes:
// the case a German or French Excel opens. No cell starts like a formula.
func TestExportCSVReadWithASemicolonDelimiter(t *testing.T) {
	o := newOffice(t)
	seedLog(t, o,
		models.LogEntry{Agent: "Atlas", Type: models.LogInstruction, Message: "x;=cmd()|calc", Outcome: "Delivered"},
		models.LogEntry{Agent: "Scout", Type: models.LogQuery, Message: "report;@SUM(A1:A9);-2+3;+1", Outcome: "ok"},
	)
	body := exportOf(t, o, "format=csv").Body.String()
	cells := 0
	for _, line := range strings.Split(body, "\n") {
		for _, cell := range strings.Split(line, ";") {
			cells++
			if startsLikeAFormula(strings.TrimPrefix(cell, `"`)) {
				t.Errorf("read with ';', a cell begins like a formula: %q in %q", cell, line)
			}
		}
	}
	// The hostile cells were split, so there is something to have checked.
	if cells < 8 {
		t.Errorf("only %d cells were read", cells)
	}
	// The ';' that was in the text is still there, with the quote after it.
	if !strings.Contains(body, `x;'=cmd()|calc`) || !strings.Contains(body, `report;'@SUM(A1:A9);'-2+3;'+1`) {
		t.Errorf("the cells were not kept whole:\n%s", body)
	}
}

// JSON is not opened in a spreadsheet, so it keeps the text as it was written, whatever it holds.
func TestExportJSONKeepsFormulasAndFullWidthFormsAsWritten(t *testing.T) {
	o := newOffice(t)
	cells := []string{"x;=cmd()", " =1+1", "＝1+1", "a|+1"}
	var rows []models.LogEntry
	for _, cell := range cells {
		rows = append(rows, models.LogEntry{Agent: "Atlas", Type: models.LogInstruction, Message: cell, Outcome: "Delivered"})
	}
	seedLog(t, o, rows...)
	got := decode[[]exportedRow](t, exportOf(t, o, "format=json"))
	if len(got) != len(cells) {
		t.Fatalf("%d rows", len(got))
	}
	for index, cell := range cells {
		// Newest first.
		if message := got[len(got)-1-index].Message; message != cell {
			t.Errorf("the JSON has %q, want %q", message, cell)
		}
	}
}
