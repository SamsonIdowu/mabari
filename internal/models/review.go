// SPDX-License-Identifier: Apache-2.0

package models

// ChangesState says whether the changes in a folder could be read, and if not, why.
type ChangesState string

// Changes states.
const (
	// ChangesRead means the folder was read. Files may still be empty: nothing has changed.
	ChangesRead ChangesState = "ok"
	// ChangesUnchanged answers a request that already holds this version, and carries no files.
	ChangesUnchanged ChangesState = "unchanged"
	// ChangesNoFolder means Mabari doesn't know a folder for this agent or project.
	ChangesNoFolder ChangesState = "noFolder"
	// ChangesMissing means the folder isn't there any more, or isn't a folder.
	ChangesMissing ChangesState = "missing"
	// ChangesNotRepo means the folder isn't in a Git repository.
	ChangesNotRepo ChangesState = "notRepo"
	// ChangesNoGit means Git isn't installed on this computer.
	ChangesNoGit ChangesState = "noGit"
	// ChangesFailed means Git ran and couldn't read the folder, such as a repository that belongs
	// to another user.
	ChangesFailed ChangesState = "failed"
)

// ChangeStatus is what happened to one file since the last commit.
type ChangeStatus string

// Change statuses.
const (
	ChangeModified  ChangeStatus = "modified"
	ChangeAdded     ChangeStatus = "added"
	ChangeDeleted   ChangeStatus = "deleted"
	ChangeRenamed   ChangeStatus = "renamed"
	ChangeUntracked ChangeStatus = "untracked"
	ChangeConflict  ChangeStatus = "conflict"
)

// Changes is what an agent or a project has changed in its folder since the last commit: the
// files, with how many lines were added and removed in each, and the changes themselves. Mabari
// reads them with Git and never changes anything. Every number is counted in Go; the page only
// formats them. Text has been through the secret filter.
type Changes struct {
	State ChangesState `json:"state"`
	// Message is, for any state but "ok", what happened and what to do, in plain words.
	Message string `json:"message"`
	// Demo is true in the demo office, whose agents have no real folder: the changes are made up.
	Demo bool `json:"demo"`
	// Folder is the folder as Mabari knows it, such as ~/code/shop.
	Folder string `json:"folder"`
	// Branch is the branch the folder is on, or a short commit when Detached, or "" with no commit.
	Branch   string `json:"branch"`
	Detached bool   `json:"detached"`
	// Version changes whenever what is read changes, so a page asking again can be told "no change".
	Version string `json:"version"`
	// Files are the changed files, at most ChangesFilesMax, in path order.
	Files []ChangedFile `json:"files"`
	// FileCount is every changed file, so it can be more than Files.
	FileCount int `json:"fileCount"`
	// Added and Removed are lines, over every file that could be counted.
	Added   int `json:"added"`
	Removed int `json:"removed"`
	// Truncated is true when some of the text is left out for its size.
	Truncated bool `json:"truncated"`
}

// ChangedFile is one file's change. Path is relative to the folder. OldPath is where a renamed
// file was. ID names the file in the list and is not a path.
type ChangedFile struct {
	ID      string       `json:"id"`
	Path    string       `json:"path"`
	OldPath string       `json:"oldPath"`
	Status  ChangeStatus `json:"status"`
	Binary  bool         `json:"binary"`
	// Counted is false when the lines weren't counted, as for a binary file or a new file
	// among too many.
	Counted bool `json:"counted"`
	Added   int  `json:"added"`
	Removed int  `json:"removed"`
	// Note says what isn't shown, such as "Binary file" or "Permissions changed", or "".
	Note  string       `json:"note"`
	Hunks []ChangeHunk `json:"hunks"`
}

// ChangeHunk is a run of changed lines with a little around them. Header is Git's "@@" line.
type ChangeHunk struct {
	Header string       `json:"header"`
	Lines  []ChangeLine `json:"lines"`
}

// ChangeLine is one line of a hunk. Kind is "ctx", "add", "del" or "note", which is Git's own
// remark such as "No newline at end of file". Old and New are line numbers, or 0 when the line
// isn't in that version of the file.
type ChangeLine struct {
	Kind string `json:"kind"`
	Old  int    `json:"old"`
	New  int    `json:"new"`
	Text string `json:"text"`
}

// Limits on what Changes carries, so a huge change can't make a huge page.
const (
	ChangesFilesMax     = 300
	ChangesFileLinesMax = 1500
	ChangesLinesMax     = 6000
	ChangesLineRunesMax = 1000
)
