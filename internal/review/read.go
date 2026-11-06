// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
	"github.com/SamsonIdowu/mabari/internal/workspace"
)

// Reader reads changes with Git.
type Reader struct {
	// git is the program, or "" when this computer has none.
	git  string
	gate chan struct{}
	// wait is how long one call may take, or zero for callWait. patchMax is how much of a patch is
	// kept, or zero for patchLimit. Tests set both small.
	wait     time.Duration
	patchMax int
	// filtered remembers files already through the secret filter. See redacted.
	mu       sync.Mutex
	filtered map[[sha256.Size]byte]models.ChangedFile
}

// New finds Git on the PATH. Without it, every read says Git isn't installed.
func New() *Reader {
	path, err := exec.LookPath("git")
	if err != nil {
		path = ""
	}
	return &Reader{git: path, gate: make(chan struct{}, maxGit)}
}

// How much of each Git answer is kept, and how many untracked files are opened to be shown.
const (
	statusLimit  = 4 << 20
	numstatLimit = 2 << 20
	patchLimit   = 3 << 20
	newFileLimit = 160 << 10
	untrackedMax = 30
)

// cmpPositive is first, or second when first is zero.
func cmpPositive(first, second int) int {
	if first > 0 {
		return first
	}
	return second
}

var objectID = regexp.MustCompile(`^[0-9a-f]{40,64}$`)

// Read reports what changed in a folder since its last commit. The folder must be one Mabari
// already knows, as an agent's or a project's: it is never taken from a request. have is the
// Version a caller already holds, or "". When nothing changed since, the answer is just
// ChangesUnchanged, which spares the caller the files.
//
// Only the files at and below folder are shown, though the repository may reach above it. Nothing
// is changed on disk, not even Git's index: see hardening.
func (r *Reader) Read(ctx context.Context, folder, have string) models.Changes {
	changes := models.Changes{Folder: folder, Files: []models.ChangedFile{}}
	fail := func(state models.ChangesState, message string) models.Changes {
		changes.State, changes.Message = state, message
		return changes
	}
	if r.git == "" {
		return fail(models.ChangesNoGit, "Git isn't installed on this computer, so Mabari can't show changes. Install Git, then restart Mabari.")
	}
	root, state, message := resolve(folder)
	if state != "" {
		return fail(state, message)
	}
	ctx, cancel := context.WithTimeout(ctx, readWait)
	defer cancel()

	g := &repo{reader: r, root: root}
	prefix, state, message := g.locate(ctx)
	if state != "" {
		return fail(state, message)
	}
	settings, err := g.neutralise(ctx)
	if err != nil {
		return fail(models.ChangesFailed, trouble(err))
	}
	g.settings = settings
	status, raw, cut, err := g.status(ctx)
	if err != nil {
		return fail(models.ChangesFailed, trouble(err))
	}
	switch {
	case status.head == "(detached)":
		changes.Branch, changes.Detached = shortID(status.oid), true
	case status.head != "":
		changes.Branch = status.head
	}

	var tracked []statusEntry
	var untracked []statusEntry
	for _, entry := range status.entries {
		entry = inFolder(entry, prefix)
		switch {
		case entry.path == "":
		case entry.kind == "?":
			untracked = append(untracked, entry)
		default:
			tracked = append(tracked, entry)
		}
	}

	hash := sha256.New()
	hash.Write(raw)
	var stats []stat
	var chunks []chunk
	base := ""
	if len(tracked) > 0 {
		if base, err = g.base(ctx, status.oid); err != nil {
			return fail(models.ChangesFailed, trouble(err))
		}
		var numstats, patch []byte
		var numCut, patchCut bool
		if numstats, numCut, err = g.diff(ctx, numstatLimit, base, "--numstat", "-z"); err != nil {
			return fail(models.ChangesFailed, trouble(err))
		}
		if patch, patchCut, err = g.diff(ctx, cmpPositive(r.patchMax, patchLimit), base, "-U3"); err != nil {
			return fail(models.ChangesFailed, trouble(err))
		}
		hash.Write(numstats)
		hash.Write(patch)
		stats, chunks = parseNumstat(numstats, numCut), parsePatch(patch, patchCut)
		cut = cut || numCut || patchCut
	}

	files, untrackedCut := g.assemble(ctx, base, tracked, untracked, stats, chunks, hash)
	cut = cut || untrackedCut
	changes.Version = hex.EncodeToString(hash.Sum(nil))[:16]
	if have != "" && have == changes.Version {
		changes.State = models.ChangesUnchanged
		return changes
	}
	changes.State = models.ChangesRead
	slices.SortFunc(files, func(a, b models.ChangedFile) int { return strings.Compare(a.Path, b.Path) })
	changes.FileCount = len(files)
	for _, file := range files {
		if file.Counted {
			changes.Added += file.Added
			changes.Removed += file.Removed
		}
	}
	trimmed := applyLimits(files)
	changes.Truncated = cut || trimmed
	if len(files) > models.ChangesFilesMax {
		changes.Truncated = true
		files = files[:models.ChangesFilesMax]
	}
	for i := range files {
		// The secret filter is the slow part of a big change, so it stops with the time allowed.
		if ctx.Err() != nil {
			return fail(models.ChangesFailed, trouble(errTooSlow))
		}
		r.redacted(&files[i])
		files[i].ID = fileID(files[i])
		if files[i].Hunks == nil {
			files[i].Hunks = []models.ChangeHunk{}
		}
	}
	changes.Files = files
	return changes
}

// resolve turns the folder Mabari knows into a real, absolute folder that exists, or says why it
// can't.
func resolve(folder string) (string, models.ChangesState, string) {
	if strings.TrimSpace(folder) == "" || strings.ContainsRune(folder, 0) {
		return "", models.ChangesNoFolder, "Mabari doesn't know which folder this works in, so there is nothing to read."
	}
	full, err := workspace.Expand(folder)
	if err != nil {
		return "", models.ChangesNoFolder, "Mabari doesn't have a full path for this folder, so there is nothing to read."
	}
	info, err := os.Stat(full)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "", models.ChangesMissing, "There is no folder at " + folder + " any more."
	case err != nil:
		return "", models.ChangesFailed, "Mabari can't open " + folder + "."
	case !info.IsDir():
		return "", models.ChangesMissing, folder + " is a file, not a folder."
	}
	resolved, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", models.ChangesFailed, "Mabari can't open " + folder + "."
	}
	return resolved, "", ""
}

// repo is the folder being read, and the settings that keep this repository's own from running
// anything.
type repo struct {
	reader *Reader
	root   string
	// settings are -c options that switch off the programs the repository's own settings name.
	settings []string
}

// run runs Git in the folder, after hardening and the repository's neutralised settings.
func (g *repo) run(ctx context.Context, limit int, args ...string) (result, error) {
	return g.reader.run(ctx, g.root, limit, append(slices.Clone(g.settings), args...)...)
}

// locate asks Git whether the folder is in a working tree, and where in it. The prefix is the
// folder's place from the repository's top, such as "web/src/", or "" at the top. A repository
// whose top isn't the folder or a folder above it has been told, by its own settings, to work
// somewhere else, and isn't read.
func (g *repo) locate(ctx context.Context) (string, models.ChangesState, string) {
	res, err := g.run(ctx, 8192, "rev-parse", "--is-inside-work-tree", "--show-toplevel", "--show-prefix")
	if err != nil {
		return "", models.ChangesFailed, trouble(err)
	}
	if res.code != 0 {
		switch {
		case strings.Contains(res.stderr, "not a git repository"):
			return "", models.ChangesNotRepo, "This folder isn't a Git repository, so there is no list of changes to show. Run git init in it to start one."
		case strings.Contains(res.stderr, "dubious ownership"):
			return "", models.ChangesFailed, "Git won't read this folder because it belongs to another user. Mark it as safe in Git's settings (safe.directory) if you trust it."
		}
		return "", models.ChangesFailed, "Git couldn't read this folder: " + firstLine(redact.Text(res.stderr))
	}
	lines := strings.Split(string(res.out), "\n")
	if len(lines) < 3 || lines[0] != "true" {
		return "", models.ChangesNotRepo, "This folder isn't a Git working folder, so there is no list of changes to show."
	}
	top, err := filepath.EvalSymlinks(lines[1])
	if err != nil {
		return "", models.ChangesFailed, "Git couldn't read this folder."
	}
	relative, err := filepath.Rel(top, g.root)
	prefix := ""
	if relative != "." {
		prefix = filepath.ToSlash(relative) + "/"
	}
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || prefix != lines[2] {
		return "", models.ChangesFailed, "This repository's settings point it at another folder, so Mabari didn't read it."
	}
	return prefix, "", ""
}

// neutralise lists the settings the repository itself holds, and switches off every filter program
// they name. A filter runs on each file Git compares with the working folder, so it would run just
// for reading. What the person set in their own Git settings is left alone: they chose it, and
// switching off, say, Git LFS would show every file it manages as changed. Settings on the command
// line win over both, which is how they are switched off.
func (g *repo) neutralise(ctx context.Context) ([]string, error) {
	res, err := g.run(ctx, 1<<20, "config", "--list", "--show-scope", "-z")
	if err != nil {
		return nil, err
	}
	if res.code != 0 || res.cut {
		return nil, errors.New("the repository's settings couldn't be read")
	}
	// With -z each setting is two NUL-ended pieces: its scope, then `name NEWLINE value`.
	var names []string
	pieces := strings.Split(string(res.out), "\x00")
	for i := 0; i+1 < len(pieces); i += 2 {
		scope := pieces[i]
		if scope != "local" && scope != "worktree" {
			continue
		}
		key, _, _ := strings.Cut(pieces[i+1], "\n")
		rest, ok := strings.CutPrefix(key, "filter.")
		if !ok {
			continue
		}
		cut := strings.LastIndex(rest, ".")
		if cut <= 0 {
			continue
		}
		switch rest[cut+1:] {
		case "clean", "smudge", "process", "required":
			if name := rest[:cut]; !slices.Contains(names, name) {
				names = append(names, name)
			}
		}
	}
	var settings []string
	for _, name := range names {
		// A name with "=" can't be put in a -c option, so such a filter can't be switched off.
		if strings.ContainsAny(name, "=\n") {
			return nil, errors.New("a filter in the repository's settings has a name Mabari can't switch off")
		}
		settings = append(settings,
			"-c", "filter."+name+".clean=", "-c", "filter."+name+".smudge=",
			"-c", "filter."+name+".process=", "-c", "filter."+name+".required=false")
	}
	return settings, nil
}

// status reads the branch and every changed or new path at and below the folder.
func (g *repo) status(ctx context.Context) (statusReport, []byte, bool, error) {
	res, err := g.run(ctx, statusLimit, "status", "--porcelain=v2", "--branch", "-z",
		"--untracked-files=all", "--ignore-submodules=dirty", "--", ".")
	if err != nil {
		return statusReport{}, nil, false, err
	}
	if res.code != 0 {
		return statusReport{}, nil, false, errors.New(firstLine(res.stderr))
	}
	return parseStatus(res.out, res.cut), res.out, res.cut, nil
}

// base is what changes are measured from: the last commit, or the empty tree when there is none
// yet, so a new repository's first files show as added.
func (g *repo) base(ctx context.Context, oid string) (string, error) {
	if oid != "(initial)" {
		return "HEAD", nil
	}
	res, err := g.run(ctx, 256, "hash-object", "-t", "tree", "--stdin")
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(res.out))
	if res.code != 0 || !objectID.MatchString(id) {
		return "", errors.New("the empty tree has no name")
	}
	return id, nil
}

// diff runs git diff from base to the working folder, for the files at and below it.
func (g *repo) diff(ctx context.Context, limit int, base string, format ...string) ([]byte, bool, error) {
	args := append([]string{"diff", base}, format...)
	args = append(args, "-M", "--relative", "--no-color", "--no-ext-diff", "--no-textconv",
		"--src-prefix=a/", "--dst-prefix=b/", "--inter-hunk-context=0",
		"--ignore-submodules=dirty", "--submodule=short", "--", ".")
	res, err := g.run(ctx, limit, args...)
	if err != nil {
		return nil, false, err
	}
	if res.code != 0 {
		return nil, false, errors.New(firstLine(res.stderr))
	}
	return res.out, res.cut, nil
}

// untrackedDiff shows a file Git doesn't track as all new lines. --no-index compares two paths
// without the repository, and treats a link as a link, so what a link points at is never read. The
// name goes after "--" and behind "./", since a lone "-" would mean standard input.
func (g *repo) untrackedDiff(ctx context.Context, name string) (chunk, bool, error) {
	res, err := g.run(ctx, newFileLimit, "diff", "--no-index", "--no-color", "--no-ext-diff",
		"--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--", os.DevNull, "./"+name)
	if err != nil {
		return chunk{}, false, err
	}
	// 1 means the two differ, which is the point.
	if res.code > 1 {
		return chunk{}, false, errors.New(firstLine(res.stderr))
	}
	chunks := parsePatch(res.out, res.cut)
	if len(chunks) != 1 {
		return chunk{}, res.cut, nil
	}
	return chunks[0], res.cut, nil
}

// renamedDiff compares a renamed file with what it was. git diff decides for itself what counts as a
// rename, by how alike the two are, so a small file that was renamed and edited comes back as one
// file deleted and another added. Git knows it was renamed, from status, so the two are compared
// directly. The old file is named as an object, so it is only ever read from the repository, and the
// new one goes after "--", behind "./". It runs with the same switches as every other read.
func (g *repo) renamedDiff(ctx context.Context, base string, entry statusEntry) (chunk, bool, error) {
	res, err := g.run(ctx, newFileLimit, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3",
		"--src-prefix=a/", "--dst-prefix=b/", "--inter-hunk-context=0", base+":./"+entry.orig, "--", "./"+entry.path)
	if err != nil {
		return chunk{}, false, err
	}
	if res.code > 1 {
		return chunk{}, false, errors.New(firstLine(res.stderr))
	}
	chunks := parsePatch(res.out, res.cut)
	if len(chunks) != 1 {
		return chunk{}, res.cut, errors.New("the rename couldn't be compared")
	}
	return chunks[0], res.cut, nil
}

// splitRename reports whether status says a file was renamed and the diff saw it as two files.
func splitRename(entry statusEntry, stats []stat, byPath map[string]int) bool {
	index, ok := byPath[entry.path]
	return ok && entry.kind == "2" && strings.Contains(entry.xy, "R") && entry.orig != "" && !stats[index].hasOrig
}

// assemble makes one entry for each changed file, from status, the counts and the patch. Counts
// and patch come in the same order, so the nth chunk is the nth count; when the two don't agree the
// text is left out rather than put on the wrong file.
func (g *repo) assemble(ctx context.Context, base string, tracked, untracked []statusEntry,
	stats []stat, chunks []chunk, hash io.Writer,
) ([]models.ChangedFile, bool) {
	var files []models.ChangedFile
	cut := false
	byPath := map[string]int{}
	for i, entry := range stats {
		byPath[entry.path] = i
	}
	seen := map[string]bool{}
	for _, entry := range tracked {
		file := models.ChangedFile{Path: entry.path, OldPath: entry.orig, Status: statusOf(entry)}
		if splitRename(entry, stats, byPath) {
			if piece, big, err := g.renamedDiff(ctx, base, entry); err == nil && !big && !piece.binary {
				seen[entry.path], seen[entry.orig] = true, true
				file.Counted, file.Added, file.Removed, file.Hunks = true, piece.added, piece.removed, piece.hunks
				for _, hunk := range piece.hunks {
					for _, line := range hunk.Lines {
						_, _ = hash.Write([]byte(line.Text))
					}
				}
				files = append(files, file)
				continue
			}
		}
		if index, ok := byPath[entry.path]; ok {
			seen[entry.path] = true
			applyStat(&file, stats[index])
			if index < len(chunks) {
				applyChunk(&file, chunks[index], stats[index])
			}
		} else {
			file.Note = "No lines changed."
		}
		files = append(files, file)
	}
	// A change the patch has and status didn't mention, such as one made between the two.
	for i, entry := range stats {
		if seen[entry.path] {
			continue
		}
		file := models.ChangedFile{Path: entry.path, Status: models.ChangeModified}
		if entry.hasOrig {
			file.OldPath, file.Status = entry.orig, models.ChangeRenamed
		}
		applyStat(&file, entry)
		if i < len(chunks) {
			applyChunk(&file, chunks[i], entry)
		}
		files = append(files, file)
	}
	for i, entry := range untracked {
		file := models.ChangedFile{Path: entry.path, Status: models.ChangeUntracked}
		switch {
		case strings.HasSuffix(entry.path, "/"):
			// A folder with a repository of its own, which Git doesn't open.
			file.Note = "A folder with its own Git repository."
		case i >= untrackedMax:
			file.Note = "New file. Not opened here: there are too many new files."
			cut = true
		default:
			piece, big, err := g.untrackedDiff(ctx, entry.path)
			_, _ = hash.Write([]byte(entry.path))
			switch {
			case err != nil:
				file.Note = "New file. It couldn't be read."
			case big:
				file.Note = "New file, too large to show here."
				cut = true
			default:
				file.Counted, file.Added = true, piece.added
				file.Binary = piece.binary
				file.Hunks = piece.hunks
				if piece.binary {
					file.Counted, file.Note = false, "Binary file."
				} else if piece.added == 0 {
					file.Note = "Empty file."
				}
				for _, hunk := range piece.hunks {
					for _, line := range hunk.Lines {
						_, _ = hash.Write([]byte(line.Text))
					}
				}
			}
		}
		files = append(files, file)
	}
	for i := range files {
		file := &files[i]
		// Counted lines with no text and no reason: the output ran out before this file.
		if file.Counted && file.Added+file.Removed > 0 && len(file.Hunks) == 0 && file.Note == "" {
			file.Note = "Not shown here: the changes are too big to show them all."
			cut = true
		}
	}
	return files, cut
}

func applyStat(file *models.ChangedFile, entry stat) {
	file.Binary, file.Counted = entry.binary, entry.counted
	file.Added, file.Removed = entry.added, entry.removed
	if entry.binary {
		file.Note = "Binary file."
	}
}

// applyChunk gives a file its text, after checking it is the file's own: a chunk whose counts
// differ from the file's isn't.
func applyChunk(file *models.ChangedFile, piece chunk, entry stat) {
	switch {
	case piece.binary:
		file.Binary = true
		file.Note = "Binary file."
		return
	case entry.counted && !piece.cut && (piece.added != entry.added || piece.removed != entry.removed):
		file.Note = "Not shown: the changes couldn't be matched to this file."
		return
	}
	if piece.newFile && file.Status == models.ChangeModified {
		file.Status = models.ChangeAdded
	}
	if piece.deleted && file.Status == models.ChangeModified {
		file.Status = models.ChangeDeleted
	}
	file.Hunks = piece.hunks
	if len(piece.hunks) == 0 && !entry.binary {
		switch {
		case piece.modeChanged:
			file.Note = "Permissions changed."
		case piece.renamed:
			file.Note = "Renamed, with no other change."
		}
	}
}

// statusOf says what happened to a path from the two letters in status.
func statusOf(entry statusEntry) models.ChangeStatus {
	letters := entry.xy
	switch {
	case entry.kind == "u":
		return models.ChangeConflict
	case entry.kind == "2":
		return models.ChangeRenamed
	case strings.Contains(letters, "D"):
		return models.ChangeDeleted
	case strings.Contains(letters, "A"):
		return models.ChangeAdded
	}
	return models.ChangeModified
}

// inFolder turns a path from the repository's top into one from the folder. An entry outside the
// folder comes back with no path.
func inFolder(entry statusEntry, prefix string) statusEntry {
	path, ok := strings.CutPrefix(entry.path, prefix)
	if !ok {
		entry.path = ""
		return entry
	}
	entry.path = path
	if entry.orig != "" {
		if orig, ok := strings.CutPrefix(entry.orig, prefix); ok {
			entry.orig = orig
		} else {
			// Renamed from outside the folder: here it is a new file.
			entry.orig, entry.kind = "", "1"
			entry.xy = "A."
		}
	}
	return entry
}

// applyLimits applies the size limits to the text, and says whether any file lost some.
func applyLimits(files []models.ChangedFile) bool {
	cut := false
	total := 0
	for i := range files {
		file := &files[i]
		lines := 0
		for _, hunk := range file.Hunks {
			lines += len(hunk.Lines)
		}
		switch {
		case lines == 0:
			continue
		case total+lines > models.ChangesLinesMax:
			file.Hunks = nil
			file.Note = "Not shown here: the changes are too big to show them all."
			cut = true
			continue
		case lines > models.ChangesFileLinesMax:
			file.Hunks = firstLines(file.Hunks, models.ChangesFileLinesMax)
			file.Note = fmt.Sprintf("Showing the first %d of %d lines.", models.ChangesFileLinesMax, lines)
			cut = true
			lines = models.ChangesFileLinesMax
		}
		total += lines
	}
	return cut
}

// firstLines keeps the first n lines of the hunks.
func firstLines(hunks []models.ChangeHunk, n int) []models.ChangeHunk {
	var kept []models.ChangeHunk
	for _, hunk := range hunks {
		if n <= 0 {
			break
		}
		if len(hunk.Lines) > n {
			hunk.Lines = hunk.Lines[:n]
		}
		n -= len(hunk.Lines)
		kept = append(kept, hunk)
	}
	return kept
}

// fileID names a file in the list. It is made from the path, so it is the same each time the
// page asks, and it is never taken back as a path.
func fileID(file models.ChangedFile) string {
	sum := sha256.Sum256([]byte(file.Path + "\x00" + file.OldPath))
	return hex.EncodeToString(sum[:])[:12]
}

func shortID(oid string) string {
	if len(oid) > 7 {
		return oid[:7]
	}
	return oid
}

func firstLine(text string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	return line
}

// trouble says in words that a read didn't finish.
func trouble(err error) string {
	if errors.Is(err, errTooSlow) || errors.Is(err, context.DeadlineExceeded) {
		return "Reading the changes took too long, so Mabari stopped. The folder may be very large."
	}
	if text := firstLine(redact.Text(err.Error())); text != "" {
		return "Git couldn't read the changes: " + text
	}
	return "Git couldn't read the changes."
}
