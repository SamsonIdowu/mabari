// SPDX-License-Identifier: Apache-2.0

package review

import (
	"crypto/sha256"
	"encoding/hex"
	"path"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// Demo makes up the changes an agent in the demo office might have made, for the files it is
// working on. The demo's agents have no real folder, and Mabari never looks in the one they are
// given, so nothing here is read from disk: it is the same answer, in the same shape, so the
// review view can be seen and tried. The text is the same each time, so it doesn't flicker.
func Demo(folder string, files []string) models.Changes {
	changes := models.Changes{
		State: models.ChangesRead, Demo: true, Folder: folder, Branch: "main", Files: []models.ChangedFile{},
	}
	seen := map[string]bool{}
	hash := sha256.New()
	for _, name := range files {
		// A folder in the list, such as "docs/", stands for a file Mabari makes up inside it.
		if strings.HasSuffix(name, "/") {
			name += "notes.md"
		}
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		file := demoFile(name)
		changes.Files = append(changes.Files, file)
		changes.Added += file.Added
		changes.Removed += file.Removed
		hash.Write([]byte(name))
	}
	changes.FileCount = len(changes.Files)
	changes.Version = hex.EncodeToString(hash.Sum(nil))[:16]
	return changes
}

// demoFile makes up one file's change: a new file for tests, migrations and reports, and an edit
// for anything else.
func demoFile(name string) models.ChangedFile {
	base := path.Base(name)
	file := models.ChangedFile{Path: name, Status: models.ChangeModified, Counted: true}
	var spec []string
	switch ext := path.Ext(base); {
	case strings.Contains(base, ".spec.") || strings.Contains(base, ".test.") || strings.HasPrefix(name, "test/"):
		file.Status = models.ChangeAdded
		spec = []string{
			"@@ -0,0 +1,9 @@",
			"+import { describe, expect, it } from 'vitest';",
			"+",
			"+describe('" + strings.TrimSuffix(strings.TrimSuffix(base, path.Ext(base)), ".spec") + "', () => {",
			"+  it('handles an empty order', () => {",
			"+    expect(total([])).toBe(0);",
			"+  });",
			"+",
			"+  it('adds up the lines', () => {",
			"+    expect(total([{ price: 5, quantity: 2 }])).toBe(10);",
			"+  });",
			"+});",
		}
	case ext == ".sql":
		file.Status = models.ChangeAdded
		spec = []string{
			"@@ -0,0 +1,8 @@",
			"+CREATE TABLE orders (",
			"+  id BIGSERIAL PRIMARY KEY,",
			"+  customer_id BIGINT NOT NULL REFERENCES customers (id),",
			"+  total_cents INTEGER NOT NULL,",
			"+  created_at TIMESTAMPTZ NOT NULL DEFAULT now()",
			"+);",
			"+",
			"+CREATE INDEX orders_customer_idx ON orders (customer_id);",
		}
	case ext == ".prisma":
		spec = []string{
			"@@ -12,6 +12,12 @@ model Customer {",
			"   id    Int    @id @default(autoincrement())",
			"   email String @unique",
			"   name  String",
			"+  orders Order[]",
			" }",
			" ",
			"+model Order {",
			"+  id         Int      @id @default(autoincrement())",
			"+  customer   Customer @relation(fields: [customerId], references: [id])",
			"+  customerId Int",
			"+  totalCents Int",
			"+}",
		}
	case ext == ".md":
		spec = []string{
			"@@ -3,7 +3,11 @@",
			" ",
			" ## Getting started",
			" ",
			"-Run the script to build the charts.",
			"+Run the script to build the charts. It writes one file for each report",
			"+and prints where it put them.",
			"+",
			"+## Options",
			"+",
			" Pass --watch to rebuild when a file changes.",
		}
	case ext == ".json":
		file.Status = models.ChangeAdded
		spec = []string{
			"@@ -0,0 +1,7 @@",
			"+{",
			"+  \"suite\": \"checkout\",",
			"+  \"passed\": 41,",
			"+  \"failed\": 1,",
			"+  \"flaky\": [\"date picker keeps the old month\"],",
			"+  \"duration\": 18.2",
			"+}",
		}
	default:
		spec = []string{
			"@@ -14,9 +14,14 @@ export function total(lines: Line[]): number {",
			"   let sum = 0;",
			"   for (const line of lines) {",
			"-    sum += line.price * line.quantity;",
			"+    if (line.quantity <= 0) continue;",
			"+    sum += Math.round(line.price * line.quantity * 100) / 100;",
			"   }",
			"-  return sum;",
			"+  return applyDiscount(sum);",
			" }",
			" ",
			"+function applyDiscount(sum: number): number {",
			"+  return sum > 100 ? sum * 0.95 : sum;",
			"+}",
		}
	}
	hunk, added, removed := demoHunk(spec)
	file.Hunks = []models.ChangeHunk{hunk}
	file.Added, file.Removed = added, removed
	return file
}

// demoHunk numbers the lines of a hunk written as Git prints it, so the line numbers are what the
// header says and the counts are counted, not typed.
func demoHunk(spec []string) (models.ChangeHunk, int, int) {
	header := spec[0]
	hunk := models.ChangeHunk{Header: header}
	oldNo, newNo := 1, 1
	if matches := hunkHeader.FindStringSubmatch(header); matches != nil {
		oldNo, newNo = atoi(matches[1]), atoi(matches[2])
	}
	added, removed := 0, 0
	for _, line := range spec[1:] {
		entry := models.ChangeLine{Text: line[1:]}
		switch line[0] {
		case '+':
			entry.Kind, entry.New = "add", newNo
			newNo++
			added++
		case '-':
			entry.Kind, entry.Old = "del", oldNo
			oldNo++
			removed++
		default:
			entry.Kind, entry.Old, entry.New = "ctx", oldNo, newNo
			oldNo++
			newNo++
		}
		hunk.Lines = append(hunk.Lines, entry)
	}
	return hunk, added, removed
}

func atoi(text string) int {
	n := 0
	for _, digit := range text {
		n = n*10 + int(digit-'0')
	}
	return n
}
