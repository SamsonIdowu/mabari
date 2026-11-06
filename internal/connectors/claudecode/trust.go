// SPDX-License-Identifier: Apache-2.0

package claudecode

import (
	"os"
	"path/filepath"
)

// In a terminal, Claude Code asks whether to trust a folder before it runs what the folder brings.
// `claude -p` never shows that dialog: its docs say a repository's hooks, its env block and helper
// commands, a project skill's hooks and allowed-tools, and its .mcp.json servers all run as if the
// folder were trusted. A repository's PermissionRequest hook could therefore answer allow by itself,
// and nothing here could stop that. So before Mabari runs a session in a folder that brings any of
// these, the person has to say they trust it, which is the click the terminal would have asked for.

// folderConfigFiles and folderConfigDirs are what a folder can bring, relative to it.
var (
	folderConfigFiles = []string{".claude/settings.json", ".claude/settings.local.json", ".mcp.json"}
	folderConfigDirs  = []string{".claude/skills", ".claude/commands", ".claude/hooks"}
)

// FolderConfig lists what a folder brings that would run in a session started there, or nothing
// when it brings nothing of the kind. Claude Code reads a repository's settings from any folder
// inside it, so this looks upwards as far as the repository's root.
func FolderConfig(folder string) []string {
	var found []string
	for current := filepath.Clean(folder); ; current = filepath.Dir(current) {
		for _, name := range folderConfigFiles {
			path := filepath.Join(current, filepath.FromSlash(name))
			if info, err := os.Stat(path); err == nil && !info.IsDir() {
				found = append(found, path)
			}
		}
		for _, name := range folderConfigDirs {
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
