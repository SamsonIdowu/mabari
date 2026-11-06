// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/risk"
	"github.com/SamsonIdowu/mabari/internal/store"
)

// In a terminal, Claude Code asks whether to trust a folder before it runs what the folder brings.
// `claude -p` never shows that dialog: its docs say a repository's hooks, its env block and helper
// commands, a project skill's hooks and allowed-tools, and its .mcp.json servers all run as if the
// folder were trusted. A repository's PermissionRequest hook could therefore answer allow by itself,
// and nothing here could stop that. So before Mabari runs a session in a folder that brings any of
// these, the person has to say they trust it, which is the click the terminal would have asked for.
//
// That click covers what the folder brought at that moment. A folder can gain more afterwards, from
// a pull or a branch, so every start checks again, and a session started in a folder that brought
// nothing is held to the same check. Only what is listed is compared: a file already agreed to that
// later changes isn't noticed here, though an agent changing one needs a click (see risk.sensitive).

// FolderConfig lists what a folder brings that would run in a session started there, or nothing
// when it brings nothing of the kind. Claude Code reads a repository's settings from any folder
// inside it, so this looks upwards as far as the repository's root.
func FolderConfig(folder string) []string {
	var found []string
	for current := filepath.Clean(folder); ; current = filepath.Dir(current) {
		for _, name := range risk.FolderConfigFiles {
			path := filepath.Join(current, filepath.FromSlash(name))
			if info, err := os.Stat(path); err == nil && !info.IsDir() {
				found = append(found, path)
			}
		}
		for _, name := range risk.FolderConfigDirs {
			path := filepath.Join(current, filepath.FromSlash(name))
			if entries, err := os.ReadDir(path); err == nil && len(entries) > 0 {
				found = append(found, path+string(filepath.Separator))
			}
		}
		_, err := os.Stat(filepath.Join(current, ".git"))
		if parent := filepath.Dir(current); err == nil || parent == current {
			return found
		}
		// A folder outside any repository stands alone: its parents aren't its project.
		if !insideRepository(current) {
			return found
		}
	}
}

// insideRepository reports whether a folder has a repository at or above it.
func insideRepository(folder string) bool {
	for current := folder; ; current = filepath.Dir(current) {
		if _, err := os.Stat(filepath.Join(current, ".git")); err == nil {
			return true
		}
		if parent := filepath.Dir(current); parent == current {
			return false
		}
	}
}

// errTrustUnread stops a start when the record of what was agreed to can't be read.
const errTrustUnread = sessionProblem("Couldn't read which folders you trust, so nothing was started.")

// Trusted is what the person agreed to: for each folder, by full path, what it brought when they
// trusted it.
type Trusted map[string][]string

// ReadTrusted reads the stored list. Earlier versions kept only the folders, so what those brought
// isn't known. They read as having brought nothing, and the person is asked once more.
func ReadTrusted(raw string) Trusted {
	trusted := Trusted{}
	if raw == "" || json.Unmarshal([]byte(raw), &trusted) == nil {
		return trusted
	}
	trusted = Trusted{}
	var folders []string
	if json.Unmarshal([]byte(raw), &folders) == nil {
		for _, folder := range folders {
			trusted[folder] = nil
		}
	}
	return trusted
}

// Unseen lists what a folder brings now that the person hasn't agreed to.
func (t Trusted) Unseen(folder string, found []string) []string {
	agreed := t[filepath.Clean(folder)]
	var unseen []string
	for _, path := range found {
		if !slices.Contains(agreed, path) {
			unseen = append(unseen, path)
		}
	}
	return unseen
}

// FolderChanged says a session can't start because its folder brings what the person hasn't agreed
// to. It is worded for the person.
type FolderChanged struct {
	Folder string
	// Found is everything the folder brings, and Unseen the part nobody agreed to.
	Found, Unseen []string
}

func (e FolderChanged) Error() string {
	return e.Folder + " brings Claude Code settings you haven't agreed to, and they can run code: " +
		strings.Join(e.Unseen, ", ") + ". Nothing was started. Say you trust the folder to carry on."
}

// folderProblem says why a session can't start in the agent's folder now, or nil. Anything that
// can't be checked counts as a problem, so a failed read never starts a session. Call inside Do.
func (c *Connector) folderProblem(agent *models.LiveAgent) error {
	folder := filepath.Clean(workFolder(agent))
	raw, err := c.engine.Store().Meta(context.Background(), store.MetaTrusted)
	if err != nil {
		return errTrustUnread
	}
	found := FolderConfig(folder)
	if unseen := ReadTrusted(raw).Unseen(folder, found); len(unseen) > 0 {
		return FolderChanged{Folder: folder, Found: found, Unseen: unseen}
	}
	return nil
}

// CanCarryOn says why the agent's session can't take a message now, or nil. One with a process
// running has already started, so only a session that would need a new process is checked. Call
// inside Do.
func (c *Connector) CanCarryOn(agent *models.LiveAgent) error {
	c.mu.Lock()
	_, live := c.runs[agent.ID]
	c.mu.Unlock()
	if live || !agent.RunsHere() {
		return nil
	}
	return c.folderProblem(agent)
}
