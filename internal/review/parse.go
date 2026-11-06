// SPDX-License-Identifier: Apache-2.0

package review

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// statusEntry is one changed path from `git status --porcelain=v2 -z`.
type statusEntry struct {
	// kind is "1" for an ordinary change, "2" for a rename or copy, "u" for a merge conflict and
	// "?" for a file Git doesn't track.
	kind string
	// xy is Git's two letters: the change in the index, then in the working folder.
	xy string
	// path is from the repository's top, and orig is where a renamed file was.
	path, orig string
}

// statusReport is what status said about the repository and its changed paths.
type statusReport struct {
	// oid is the commit the folder is on, or "(initial)" when there is none yet.
	oid string
	// head is the branch, or "(detached)".
	head    string
	entries []statusEntry
}

// parseStatus reads `git status --porcelain=v2 --branch -z`: NUL-ended records, with a rename's
// old path as the record after it. A record cut off by a size limit is dropped.
func parseStatus(out []byte, cut bool) statusReport {
	report := statusReport{oid: "(initial)", head: ""}
	tokens := strings.Split(string(out), "\x00")
	// What follows the last NUL is the cut-off start of a record, or nothing.
	tokens = tokens[:len(tokens)-1]
	if cut && len(tokens) > 0 {
		tokens = tokens[:len(tokens)-1]
	}
	for i := 0; i < len(tokens); i++ {
		token := tokens[i]
		switch {
		case strings.HasPrefix(token, "# branch.oid "):
			report.oid = strings.TrimPrefix(token, "# branch.oid ")
		case strings.HasPrefix(token, "# branch.head "):
			report.head = strings.TrimPrefix(token, "# branch.head ")
		case strings.HasPrefix(token, "1 "):
			if fields := strings.SplitN(token, " ", 9); len(fields) == 9 {
				report.entries = append(report.entries, statusEntry{kind: "1", xy: fields[1], path: fields[8]})
			}
		case strings.HasPrefix(token, "2 "):
			fields := strings.SplitN(token, " ", 10)
			if len(fields) != 10 || i+1 >= len(tokens) {
				continue
			}
			i++
			report.entries = append(report.entries,
				statusEntry{kind: "2", xy: fields[1], path: fields[9], orig: tokens[i]})
		case strings.HasPrefix(token, "u "):
			if fields := strings.SplitN(token, " ", 11); len(fields) == 11 {
				report.entries = append(report.entries, statusEntry{kind: "u", xy: fields[1], path: fields[10]})
			}
		case strings.HasPrefix(token, "? "):
			report.entries = append(report.entries, statusEntry{kind: "?", xy: "??", path: token[2:]})
		}
	}
	return report
}

// stat is one line of `git diff --numstat -z`.
type stat struct {
	path, orig       string
	added, removed   int
	binary           bool
	hasOrig, counted bool
}

// parseNumstat reads `git diff --numstat -z`. A renamed file is `added TAB removed TAB NUL old NUL
// new NUL`, any other `added TAB removed TAB path NUL`, and a binary file counts as `-` and `-`.
func parseNumstat(out []byte, cut bool) []stat {
	tokens := strings.Split(string(out), "\x00")
	tokens = tokens[:len(tokens)-1]
	if cut && len(tokens) > 0 {
		tokens = tokens[:len(tokens)-1]
	}
	var stats []stat
	for i := 0; i < len(tokens); i++ {
		parts := strings.SplitN(tokens[i], "\t", 3)
		if len(parts) < 3 {
			continue
		}
		entry := stat{path: parts[2]}
		if parts[2] == "" {
			if i+2 >= len(tokens) {
				break
			}
			entry.orig, entry.path, entry.hasOrig = tokens[i+1], tokens[i+2], true
			i += 2
		}
		if parts[0] == "-" || parts[1] == "-" {
			entry.binary = true
		} else {
			added, errA := strconv.Atoi(parts[0])
			removed, errR := strconv.Atoi(parts[1])
			if errA != nil || errR != nil {
				continue
			}
			entry.added, entry.removed, entry.counted = added, removed, true
		}
		stats = append(stats, entry)
	}
	return stats
}

// chunk is one file's part of a patch.
type chunk struct {
	binary, newFile, deleted, renamed, modeChanged bool
	hunks                                          []models.ChangeHunk
	// lines is every line in the hunks, and added and removed are those that changed.
	lines, added, removed int
	// cut is true when the patch ended inside this file's changes.
	cut bool
}

var hunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@`)

// parsePatch splits the output of `git diff` into its files and their hunks, numbering the lines.
// It doesn't read file names: Git may quote them, so the caller pairs files with the chunks by
// their order, which is the order of `--numstat`. A file's changes start at a line that begins
// "diff --git ", which no line inside a hunk can: those begin with a space, + or -.
func parsePatch(text []byte, cut bool) []chunk {
	var chunks []chunk
	var current *chunk
	var hunk *models.ChangeHunk
	var oldNo, newNo int
	flush := func() {
		if current != nil && hunk != nil {
			current.hunks = append(current.hunks, *hunk)
		}
		hunk = nil
	}
	lines := strings.Split(string(text), "\n")
	// A trailing newline leaves an empty last piece. When the output was cut, the last piece is
	// the start of a line, which is dropped.
	lines = lines[:len(lines)-1]
	for _, line := range lines {
		if strings.HasPrefix(line, "diff --git ") || strings.HasPrefix(line, "diff --cc ") {
			flush()
			chunks = append(chunks, chunk{})
			current = &chunks[len(chunks)-1]
			continue
		}
		if current == nil {
			continue
		}
		if matches := hunkHeader.FindStringSubmatch(line); matches != nil {
			flush()
			oldNo, _ = strconv.Atoi(matches[1])
			newNo, _ = strconv.Atoi(matches[2])
			hunk = &models.ChangeHunk{Header: line}
			continue
		}
		if hunk == nil {
			switch {
			case strings.HasPrefix(line, "Binary files "), strings.HasPrefix(line, "GIT binary patch"):
				current.binary = true
			case strings.HasPrefix(line, "new file mode "):
				current.newFile = true
			case strings.HasPrefix(line, "deleted file mode "):
				current.deleted = true
			case strings.HasPrefix(line, "old mode "), strings.HasPrefix(line, "new mode "):
				current.modeChanged = true
			case strings.HasPrefix(line, "rename from "):
				current.renamed = true
			}
			continue
		}
		entry := models.ChangeLine{Kind: "ctx"}
		body := line
		if line != "" {
			body = line[1:]
		}
		switch {
		case line == "":
			entry.Old, entry.New = oldNo, newNo
			oldNo++
			newNo++
		case line[0] == '+':
			entry.Kind, entry.New = "add", newNo
			newNo++
			current.added++
		case line[0] == '-':
			entry.Kind, entry.Old = "del", oldNo
			oldNo++
			current.removed++
		case line[0] == '\\':
			entry.Kind, body = "note", strings.TrimPrefix(line, "\\ ")
		default:
			entry.Old, entry.New = oldNo, newNo
			oldNo++
			newNo++
		}
		entry.Text = strings.TrimSuffix(body, "\r")
		hunk.Lines = append(hunk.Lines, entry)
		current.lines++
	}
	flush()
	if cut && current != nil {
		current.cut = true
	}
	return chunks
}
