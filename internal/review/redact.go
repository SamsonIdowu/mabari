// SPDX-License-Identifier: Apache-2.0

package review

import (
	"crypto/sha256"
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
)

var (
	keyBegin = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY[A-Z ]*-----`)
	keyEnd   = regexp.MustCompile(`-----END [A-Z ]*PRIVATE KEY[A-Z ]*-----`)
)

// keyFile reports whether a path names a file that holds a key, whose contents aren't shown at all:
// the secret filter finds secrets by their look, and a key's own lines look like nothing.
func keyFile(name string) bool {
	base := strings.ToLower(path.Base(name))
	switch base {
	case "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519":
		return true
	}
	switch path.Ext(base) {
	case ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk":
		return true
	}
	return false
}

// redactFile passes everything a file shows through the secret filter. It works a line at a time,
// so a line is never merged with another and the line numbers stay true, and it hides a private
// key's lines whole, from BEGIN to END, which the filter can only do across lines.
func redactFile(file *models.ChangedFile) {
	file.Path, file.OldPath = redact.Text(file.Path), redact.Text(file.OldPath)
	if keyFile(file.Path) || keyFile(file.OldPath) {
		if len(file.Hunks) > 0 {
			file.Hunks, file.Note = nil, "Contents hidden: this looks like a key file."
		}
		return
	}
	inKey := false
	for h := range file.Hunks {
		hunk := &file.Hunks[h]
		hunk.Header = redact.Text(hunk.Header)
		for l := range hunk.Lines {
			text := hunk.Lines[l].Text
			switch {
			case inKey:
				hunk.Lines[l].Text = redact.Mask
				inKey = !keyEnd.MatchString(text)
			case keyBegin.MatchString(text):
				hunk.Lines[l].Text = redact.Mask
				inKey = !keyEnd.MatchString(text)
			default:
				hunk.Lines[l].Text = clipLine(redact.Text(text))
			}
		}
	}
}

// redactedKept is how many filtered files are remembered.
const redactedKept = 256

// redacted is redactFile for a file that may have been filtered before. An agent at work changes
// one file at a time, while a read gives every file again, and the filter costs the most on a big
// change, so a file that is as it was is not filtered twice. The key is a hash of everything the
// filter reads, so a file that differs at all is filtered afresh.
func (r *Reader) redacted(file *models.ChangedFile) {
	hash := sha256.New()
	_, _ = fmt.Fprintf(hash, "%s\x00%s\x00%s\x00%s\x00", file.Path, file.OldPath, file.Status, file.Note)
	for _, hunk := range file.Hunks {
		_, _ = fmt.Fprintf(hash, "%s\x00", hunk.Header)
		for _, line := range hunk.Lines {
			_, _ = fmt.Fprintf(hash, "%s%d %d %s\x00", line.Kind, line.Old, line.New, line.Text)
		}
	}
	var key [sha256.Size]byte
	copy(key[:], hash.Sum(nil))
	r.mu.Lock()
	kept, ok := r.filtered[key]
	r.mu.Unlock()
	if ok {
		file.Path, file.OldPath, file.Note, file.Hunks = kept.Path, kept.OldPath, kept.Note, kept.Hunks
		return
	}
	redactFile(file)
	r.mu.Lock()
	if r.filtered == nil || len(r.filtered) >= redactedKept {
		r.filtered = map[[sha256.Size]byte]models.ChangedFile{}
	}
	r.filtered[key] = *file
	r.mu.Unlock()
}

// clipLine cuts a line longer than the page should be given, and says so. It runs after the secret
// filter, so a secret is never cut in half and left unrecognised.
func clipLine(text string) string {
	if len(text) <= models.ChangesLineRunesMax {
		return text
	}
	count := 0
	for index := range text {
		if count == models.ChangesLineRunesMax {
			return text[:index] + "…"
		}
		count++
	}
	return text
}
