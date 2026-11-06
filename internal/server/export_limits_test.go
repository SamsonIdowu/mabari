// SPDX-License-Identifier: Apache-2.0

package server

import (
	"bytes"
	"context"
	"errors"
	"math/rand"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// within runs work and fails the test if it takes longer than the limit, which is how a
// quadratic scan shows: the same work on a cell ten times as long takes a hundred times as long.
func within(t *testing.T, limit time.Duration, what string, work func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		work()
	}()
	select {
	case <-done:
	case <-time.After(limit):
		t.Fatalf("%s took more than %s", what, limit)
	}
}

// One long cell can't use up the server's time: neutralising it takes one pass over the text,
// whatever the text is made of. Runs of the characters a scan might re-read from each position:
// separators that are also blanks, blanks, quotes, and separators.
func TestSafeCellTakesOnePass(t *testing.T) {
	const n = 400_000
	cells := map[string]string{
		"tabs then a formula":         strings.Repeat("\t", n) + "=1",
		"line breaks then a formula":  strings.Repeat("\r\n", n/2) + "+1",
		"spaces and tabs":             strings.Repeat(" \t", n/2) + "-1",
		"quotes then a formula":       strings.Repeat(`"`, n) + "@x",
		"quotes and tabs":             strings.Repeat("\"\t", n/2) + "=1",
		"semicolons then a formula":   strings.Repeat(";", n) + "=1",
		"separator after separator":   strings.Repeat(";\t", n/2) + "=1",
		"no formula at the end":       strings.Repeat("\t", n) + "x",
		"full-width blanks and marks": strings.Repeat("　＂", n/2) + "＝1",
		"nothing but a formula start": strings.Repeat("=", n),
	}
	for name, cell := range cells {
		within(t, 5*time.Second, name, func() {
			got := safeCell(cell)
			if got == "" || len(got) < len(cell) {
				t.Errorf("%s: the cell came back shorter than it went in", name)
			}
		})
	}
	// And the work was done right: a cell of tabs then a formula is quoted at its start and at its
	// last cell, and nowhere in between.
	got := safeCell(strings.Repeat("\t", 50_000) + "=1")
	if !strings.HasPrefix(got, "'\t") || !strings.HasSuffix(got, "\t'=1") || strings.Count(got, "'") != 2 {
		t.Errorf("a long run of tabs was quoted %d times", strings.Count(got, "'"))
	}
}

// Whatever a cell is made of, no spreadsheet setting reads a formula out of the result. It runs a
// few thousand cells built from the characters that matter, in random order, and reads each as
// every reader might: split on each combination of separators, taking no notice of quotes, and
// then stripping all leading spaces and quotes, as a reader that does notice them would.
func TestSafeCellLeavesNoFormulaForAnyReader(t *testing.T) {
	alphabet := []string{
		"=", "+", "-", "@", "＝", "＋", "－", "＠", "﹦", "−", ";", ",", "|", "\t", "\r", "\n", " ", "　", " ",
		`"`, "＂", "'", "x", "1", "；",
	}
	separatorSets := []string{";", ",", "|", "\t", "\r", "\n", ";,", ";|", ",\t", ";,|\t\r\n", "|\t\n"}
	random := rand.New(rand.NewSource(11))
	for range 30_000 {
		var builder strings.Builder
		for range 1 + random.Intn(14) {
			builder.WriteString(alphabet[random.Intn(len(alphabet))])
		}
		cell := builder.String()
		safe := safeCell(cell)
		for _, separators := range separatorSets {
			// A reader sees a piece at the start and after each separator, empty pieces too.
			pieces := strings.FieldsFunc(safe, func(r rune) bool { return strings.ContainsRune(separators, r) })
			for _, piece := range pieces {
				if startsLikeAFormula(piece) {
					t.Fatalf("safeCell(%q) = %q: read with %q a piece begins like a formula: %q", cell, safe, separators, piece)
				}
			}
		}
		// Nothing but quotes was added, and nothing was taken away.
		if stripped := strings.ReplaceAll(safe, "'", ""); stripped != strings.ReplaceAll(cell, "'", "") {
			t.Fatalf("safeCell(%q) = %q changed more than quotes", cell, safe)
		}
	}
}

// A cell is held to a length, so the neutralising and the hiding of secrets are of bounded work.
func TestExportCutsAVeryLongCell(t *testing.T) {
	o := newOffice(t)
	long := strings.Repeat("word ", 20_000) // 100,000 characters.
	seedLog(t, o,
		models.LogEntry{Agent: "Atlas", Type: models.LogInstruction, Message: long, Outcome: "Delivered"},
		models.LogEntry{Agent: "Scout", Type: models.LogQuery, Message: "short", Outcome: "ok"},
	)
	for _, format := range []string{"csv", "json"} {
		body := exportOf(t, o, "format="+format).Body.String()
		if len(body) > 2*exportCellLimit {
			t.Errorf("the %s export of a 100,000 character cell is %d bytes", format, len(body))
		}
		if !strings.Contains(body, exportCut) {
			t.Errorf("the %s export cut a cell without saying so", format)
		}
		if !strings.Contains(body, "short") {
			t.Errorf("the %s export lost the other row", format)
		}
	}
	// The cut is a number of characters, never half of one.
	multi := strings.Repeat("é", exportCellLimit+5)
	if got := cutCell(multi); !utf8.ValidString(got) || utf8.RuneCountInString(got) != exportCellLimit+utf8.RuneCountInString(exportCut) {
		t.Errorf("cut a multi-byte cell badly: %d characters", utf8.RuneCountInString(got))
	}
	// A cell at the limit is left alone.
	exact := strings.Repeat("a", exportCellLimit)
	if cutCell(exact) != exact {
		t.Error("a cell at the limit was cut")
	}
	// A secret in a long cell is still hidden when the cut falls part way through it: what is kept of
	// it is long enough to be found, and whole secrets before the cut are found as always.
	for _, kept := range []int{3, 12, 15, 20, 36} {
		message := strings.Repeat("a", exportCellLimit-kept-1) + " sk-ant-api03-PLANTEDSECRETKEY123456 and more"
		rows, err := exportRows(context.Background(), []models.LogEntry{{ID: "x", Message: message}})
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(rows[0].Message, "PLANT") || strings.Contains(rows[0].Message, "sk-ant-api03-PL") {
			t.Errorf("with %d characters of the secret kept, the cell shows it: %q", kept, rows[0].Message[len(rows[0].Message)-40:])
		}
	}
}

// The loop gives up when the person who asked has gone, rather than working through ten thousand
// rows for nobody.
func TestExportStopsWhenTheRequestIsCancelled(t *testing.T) {
	entries := make([]models.LogEntry, 5000)
	for i := range entries {
		entries[i] = models.LogEntry{ID: strconv.Itoa(i), Agent: "Atlas", Message: "row", Outcome: "ok"}
	}
	live, cancel := context.WithCancel(context.Background())
	rows, err := exportRows(live, entries)
	if err != nil || len(rows) != len(entries) {
		t.Fatalf("a live request: %d rows, %v", len(rows), err)
	}
	var body bytes.Buffer
	if err := writeCSV(live, &body, rows); err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, err := exportRows(live, entries); !errors.Is(err, context.Canceled) {
		t.Errorf("rows for a cancelled request: %v", err)
	}
	body.Reset()
	if err := writeCSV(live, &body, rows); !errors.Is(err, context.Canceled) {
		t.Errorf("a CSV for a cancelled request: %v", err)
	}
	// It stopped early, not after all of it.
	if body.Len() > 1000 {
		t.Errorf("wrote %d bytes after being cancelled", body.Len())
	}
}
