// SPDX-License-Identifier: Apache-2.0

package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Files attached to a message are kept in Mabari's data folder, in a folder of their own for each,
// and the agent is given the path. They are never served back, so a page can only add to them.

const (
	maxAttachment   = 25 << 20
	maxAttachedEach = 8
	attachName      = 100
	savedMax        = 100
	savedNameMax    = 40
)

var attachID = regexp.MustCompile(`^[0-9a-f]{16}$`)

// cleanFileName makes a name safe to be a file's name and to put in a message: the last part of
// what was sent, with no control characters, no leading dot, and a sensible length.
func cleanFileName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if cut := strings.LastIndex(name, "/"); cut >= 0 {
		name = name[cut+1:]
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == utf8.RuneError || strings.ContainsRune(`<>:"|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimLeft(strings.TrimSpace(name), ".")
	if runes := []rune(name); len(runes) > attachName {
		// Keep the end, where the extension is.
		name = string(runes[len(runes)-attachName:])
	}
	if name == "" {
		return "file"
	}
	return name
}

// Attachment is a stored file.
type Attachment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// saveAttachment is POST /api/attachments?name=…, with the file as the body.
func (a *api) saveAttachment(w http.ResponseWriter, r *http.Request) {
	if a.dataDir == "" {
		writeError(w, http.StatusServiceUnavailable, "Mabari has no data folder to keep files in here.")
		return
	}
	name := cleanFileName(r.URL.Query().Get("name"))
	if r.ContentLength > maxAttachment {
		writeError(w, http.StatusRequestEntityTooLarge, name+" is over 25 MB, which is the most Mabari keeps.")
		return
	}
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		internalError(w, err)
		return
	}
	id := hex.EncodeToString(raw)
	folder := a.dataPath("attachments", id)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		internalError(w, err)
		return
	}
	path := filepath.Join(folder, name)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) // #nosec G304 G703 -- a fresh folder of ours and a name cleaned to one part
	if err != nil {
		_ = os.RemoveAll(folder)
		internalError(w, err)
		return
	}
	size, copyErr := io.Copy(file, http.MaxBytesReader(w, r.Body, maxAttachment))
	closeErr := file.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		_ = os.RemoveAll(folder)
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, name+" is over 25 MB, which is the most Mabari keeps.")
			return
		}
		internalError(w, err)
		return
	}
	a.pruneAttachments()
	writeJSON(w, http.StatusCreated, Attachment{ID: id, Name: name, Path: path, Size: size})
}

// attachmentPaths are the stored files for some ids, in order. An id that isn't one, or has no file,
// is left out, so a message can only ever name what Mabari stored.
func (a *api) attachmentPaths(ids []string) []string {
	var paths []string
	for _, id := range ids {
		if !attachID.MatchString(id) || len(paths) >= maxAttachedEach || a.dataDir == "" {
			continue
		}
		entries, err := os.ReadDir(a.dataPath("attachments", id))
		if err != nil || len(entries) != 1 || !entries[0].Type().IsRegular() {
			continue
		}
		paths = append(paths, a.dataPath("attachments", id, entries[0].Name()))
	}
	return paths
}

// pruneAttachments removes what is older than the retention setting, so the folder doesn't grow for
// ever.
func (a *api) pruneAttachments() {
	days := 30
	_ = a.engine.Do(func() {
		if kept := a.engine.Settings().RetentionDays; kept > 0 {
			days = kept
		}
	})
	entries, err := os.ReadDir(a.dataPath("attachments"))
	if err != nil {
		return
	}
	cutoff := time.Now().AddDate(0, 0, -days)
	for _, entry := range entries {
		if info, err := entry.Info(); err == nil && attachID.MatchString(entry.Name()) && info.ModTime().Before(cutoff) {
			_ = os.RemoveAll(a.dataPath("attachments", entry.Name()))
		}
	}
}

// wipeAttachments removes every stored attachment, for a wipe.
func (a *api) wipeAttachments() error {
	if a.dataDir == "" {
		return nil
	}
	return os.RemoveAll(a.dataPath("attachments"))
}

// Saved is an instruction the person keeps to send again.
type Saved struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Text    string `json:"text"`
	Created int64  `json:"created"`
}

var savedMu sync.Mutex

func (a *api) savedFile() string { return a.dataPath("saved-instructions.json") }

// savedInstructions reads the list, or nothing when there is none or it can't be read.
func (a *api) savedInstructions() []Saved {
	saved := []Saved{}
	path := a.savedFile()
	if path == "" {
		return saved
	}
	savedMu.Lock()
	defer savedMu.Unlock()
	return readSaved(path)
}

func readSaved(path string) []Saved {
	saved := []Saved{}
	raw, err := os.ReadFile(path) // #nosec G304 -- Mabari's own file in its data folder
	if err != nil || json.Unmarshal(raw, &saved) != nil {
		return []Saved{}
	}
	return saved
}

func writeSaved(path string, saved []Saved) error {
	raw, err := json.MarshalIndent(saved, "", "  ")
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func (a *api) listSaved(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.savedInstructions())
}

// createSaved is POST /api/saved-instructions, from any message the person sent.
func (a *api) createSaved(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		Text string `json:"text"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	name, text := strings.Join(strings.Fields(body.Name), " "), strings.TrimSpace(body.Text)
	switch {
	case a.savedFile() == "":
		writeError(w, http.StatusServiceUnavailable, "Mabari has no data folder to keep instructions in here.")
		return
	case name == "" || utf8.RuneCountInString(name) > savedNameMax || strings.ContainsFunc(name, unicode.IsControl):
		writeError(w, http.StatusBadRequest, "Give it a name of up to 40 characters.")
		return
	}
	if problem := messageProblem(text); problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	raw := make([]byte, 6)
	if _, err := rand.Read(raw); err != nil {
		internalError(w, err)
		return
	}
	savedMu.Lock()
	defer savedMu.Unlock()
	list := readSaved(a.savedFile())
	for _, existing := range list {
		if strings.EqualFold(existing.Name, name) {
			writeError(w, http.StatusConflict, "You already have an instruction called "+existing.Name+".")
			return
		}
	}
	if len(list) >= savedMax {
		writeError(w, http.StatusConflict, "That's the most instructions to keep. Delete one first.")
		return
	}
	item := Saved{ID: hex.EncodeToString(raw), Name: name, Text: text, Created: time.Now().UnixMilli()}
	if err := writeSaved(a.savedFile(), append(list, item)); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *api) deleteSaved(w http.ResponseWriter, r *http.Request) {
	if a.savedFile() == "" {
		writeError(w, http.StatusNotFound, "no such instruction")
		return
	}
	savedMu.Lock()
	defer savedMu.Unlock()
	list := readSaved(a.savedFile())
	kept := make([]Saved, 0, len(list))
	for _, item := range list {
		if item.ID != r.PathValue("id") {
			kept = append(kept, item)
		}
	}
	if len(kept) == len(list) {
		writeError(w, http.StatusNotFound, "no such instruction")
		return
	}
	if err := writeSaved(a.savedFile(), kept); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
