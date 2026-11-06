// SPDX-License-Identifier: Apache-2.0

package review

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

func TestTheDemoMakesUpChangesInTheRealShape(t *testing.T) {
	files := []string{
		"src/billing/totals.ts", "test/billing.spec.ts", "db/migrations/0042_orders.sql", "db/schema.prisma",
		"README.md", "ci/report.json", "docs/", "src/billing/totals.ts",
	}
	changes := Demo("~/code/shop", files)
	if changes.State != models.ChangesRead || !changes.Demo || changes.Folder != "~/code/shop" ||
		changes.Branch != "main" || changes.Version == "" {
		t.Fatalf("changes = %+v", changes)
	}
	// The same file twice is one file, and a folder stands for a file in it.
	if changes.FileCount != 7 || len(changes.Files) != 7 || changes.Files[6].Path != "docs/notes.md" {
		t.Errorf("files = %d, last %q", changes.FileCount, changes.Files[len(changes.Files)-1].Path)
	}
	added, removed := 0, 0
	ids := map[string]bool{}
	for _, file := range changes.Files {
		count := [2]int{}
		for _, hunk := range file.Hunks {
			for _, line := range hunk.Lines {
				switch line.Kind {
				case "add":
					count[0]++
					if line.New == 0 || line.Old != 0 {
						t.Errorf("%s: added line numbers %+v", file.Path, line)
					}
				case "del":
					count[1]++
					if line.Old == 0 || line.New != 0 {
						t.Errorf("%s: removed line numbers %+v", file.Path, line)
					}
				case "ctx":
					if line.Old == 0 || line.New == 0 {
						t.Errorf("%s: context line numbers %+v", file.Path, line)
					}
				}
			}
		}
		// The counts are counted from the lines, not typed.
		if !file.Counted || file.Added != count[0] || file.Removed != count[1] || ids[file.ID] || file.ID == "" {
			t.Errorf("%s = +%d -%d, lines +%d -%d", file.Path, file.Added, file.Removed, count[0], count[1])
		}
		ids[file.ID] = true
		added += file.Added
		removed += file.Removed
	}
	if changes.Added != added || changes.Removed != removed || added == 0 {
		t.Errorf("totals +%d -%d, files +%d -%d", changes.Added, changes.Removed, added, removed)
	}
	if again := Demo("~/code/shop", files); !reflect.DeepEqual(again, changes) {
		t.Error("the demo's changes differ from one read to the next")
	}
	if none := Demo("~/code/shop", nil); none.FileCount != 0 || none.State != models.ChangesRead || none.Files == nil {
		t.Errorf("none = %+v", none)
	}
}

func TestARequestForASecondOpinionIsShortAndSaysWhatItIs(t *testing.T) {
	changes := Demo("~/code/shop", []string{"src/billing/totals.ts", "db/migrations/0042_orders.sql"})
	text, left := Opinion("Ledger", "~/code/shop", changes)
	first, _, _ := strings.Cut(text, "\n")
	if want := fmt.Sprintf("Second opinion wanted: review the changes Ledger made in ~/code/shop (2 files, +%d -%d).",
		changes.Added, changes.Removed); first != want {
		t.Errorf("first line = %q, want %q", first, want)
	}
	for _, want := range []string{"don't edit any files", "--- src/billing/totals.ts (modified, +", "@@ -14,9 +14,14 @@",
		"+    if (line.quantity <= 0) continue;", "--- db/migrations/0042_orders.sql (added, +8 -0)"} {
		if !strings.Contains(text, want) {
			t.Errorf("the request lacks %q:\n%s", want, text)
		}
	}
	if left != 0 || strings.Contains(text, "not included") {
		t.Errorf("left %d", left)
	}
}

func TestAHugeDiffIsCutToWhatAReviewerCanRead(t *testing.T) {
	var lines []models.ChangeLine
	for i := range 2000 {
		lines = append(lines, models.ChangeLine{Kind: "add", New: i + 1, Text: fmt.Sprintf("line number %d of a very long file", i)})
	}
	big := models.ChangedFile{Path: "big.txt", Status: models.ChangeAdded, Counted: true, Added: 2000,
		Hunks: []models.ChangeHunk{{Header: "@@ -0,0 +1,2000 @@", Lines: lines}}}
	small := models.ChangedFile{Path: "small.txt", Status: models.ChangeModified, Counted: true, Added: 1,
		Hunks: []models.ChangeHunk{{Header: "@@ -1 +1 @@", Lines: []models.ChangeLine{{Kind: "add", New: 1, Text: "x"}}}}}

	// The big file first: it is cut short, and the next file is named as left out.
	text, left := Opinion("Ledger", "~/code/shop", models.Changes{Files: []models.ChangedFile{big, small}, FileCount: 2})
	if len(text) > OpinionMax+200 || !strings.Contains(text, "(This file is cut short.)") || left != 1 ||
		!strings.Contains(text, "1 more file is not included") || !strings.Contains(text, "line number 0 of") {
		t.Errorf("%d bytes, left %d:\n%s", len(text), left, text[len(text)-300:])
	}
	// The small file first: it is whole, and the big one is left out.
	text, left = Opinion("Ledger", "~/code/shop", models.Changes{Files: []models.ChangedFile{small, big}, FileCount: 2})
	if !strings.Contains(text, "--- small.txt") || strings.Contains(text, "line number 1999") || left != 0 && left != 1 {
		t.Errorf("left %d:\n%s", left, text)
	}
	// Files the list itself left out are counted too.
	_, left = Opinion("Ledger", "~/code/shop", models.Changes{Files: []models.ChangedFile{small}, FileCount: 5})
	if left != 4 {
		t.Errorf("left = %d, want 4", left)
	}
}
