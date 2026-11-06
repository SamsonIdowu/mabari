// SPDX-License-Identifier: Apache-2.0

package review

import (
	"fmt"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// OpinionMax is how much of a diff goes into a request for a second opinion, in characters. The
// request becomes an instruction, which Mabari logs and shows in full, so it is kept to what a
// reviewer can read at a glance; the rest is named, not sent.
const OpinionMax = 8000

// Opinion writes a request for a second opinion on changes that already went through the secret
// filter: who made them and where, the files with their counts, and as much of the diff as
// fits. Its first line says all that is needed, so a log row or a panel that only shows the start of
// it still makes sense. It reports how many files it had to leave out.
func Opinion(author, folder string, changes models.Changes) (string, int) {
	var text strings.Builder
	text.WriteString(opinionHeader(author, folder, changes))
	text.WriteString("Read the diff below and reply with what you find: bugs, risks and anything missing. " +
		"This is a review only, so don't edit any files or run anything.\n")
	room := OpinionMax - text.Len()
	left, written := 0, 0
	for index, file := range changes.Files {
		piece := opinionFile(file)
		if len(piece) > room {
			// A file that doesn't fit is left out, unless it is the first: then its start goes in,
			// so a single big change still has something to review.
			if written == 0 && room > 400 {
				cut := strings.LastIndex(piece[:room], "\n")
				text.WriteString(piece[:cut+1] + "(This file is cut short.)\n")
				index++
			}
			left = len(changes.Files) - index
			break
		}
		room -= len(piece)
		written++
		text.WriteString(piece)
	}
	if left == 0 && changes.FileCount > len(changes.Files) {
		left = changes.FileCount - len(changes.Files)
	}
	if left > 0 {
		fmt.Fprintf(&text, "\n(%d more %s not included, to keep this short. Ask for them if you need them.)\n",
			left, map[bool]string{true: "file is", false: "files are"}[left == 1])
	}
	return text.String(), left
}

// opinionHeader is the line that says what the request is, with its newline.
func opinionHeader(author, folder string, changes models.Changes) string {
	files := "files"
	if changes.FileCount == 1 {
		files = "file"
	}
	return models.InertMentions(fmt.Sprintf("Second opinion wanted: review the changes %s made in %s (%d %s, +%d -%d).\n",
		author, folder, changes.FileCount, files, changes.Added, changes.Removed))
}

// OpinionSummary is the same request without the diff: the line that says what it is, and the
// files. The demo's agents are sent this, as they only act out a reply.
func OpinionSummary(author, folder string, changes models.Changes) string {
	var text strings.Builder
	text.WriteString(opinionHeader(author, folder, changes))
	for index, file := range changes.Files {
		if index == 12 {
			fmt.Fprintf(&text, "and %d more\n", changes.FileCount-index)
			break
		}
		fmt.Fprintf(&text, "%s (%s)\n", models.InertMentions(file.Path), file.Status)
	}
	return text.String()
}

// opinionFile is one file as the reviewer reads it: its name, what happened to it, and its hunks
// the way Git prints them. All of it came from files, so an @ in it mentions nothing.
func opinionFile(file models.ChangedFile) string {
	var text strings.Builder
	name := file.Path
	if file.OldPath != "" {
		name = file.OldPath + " -> " + file.Path
	}
	fmt.Fprintf(&text, "\n--- %s (%s", name, file.Status)
	if file.Counted {
		fmt.Fprintf(&text, ", +%d -%d", file.Added, file.Removed)
	}
	text.WriteString(")\n")
	if file.Note != "" {
		text.WriteString(file.Note + "\n")
	}
	for _, hunk := range file.Hunks {
		text.WriteString(hunk.Header + "\n")
		for _, line := range hunk.Lines {
			prefix := map[string]string{"add": "+", "del": "-", "ctx": " ", "note": "\\ "}[line.Kind]
			text.WriteString(prefix + line.Text + "\n")
		}
	}
	return models.InertMentions(text.String())
}
