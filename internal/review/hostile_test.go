// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// A folder an agent worked in is not a folder to trust. These tests build the ones that go wrong:
// names that look like options or like shell, settings that name programs, links that point
// outside, and changes too big to show.

// hostileNames are file names Git might misread, or a shell might run.
var hostileNames = []string{
	"-rf", "--output=pwned", "--help", "-", "--", "a b.txt", `quote"name.txt`, "quote'name.txt",
	":(top)magic.txt", "*.go", "[abc].txt", "日本語.txt", "émoji-😀.txt", `back\slash.txt`,
	" leading space.txt", "trailing space.txt ", ".hidden", "@{u}.txt", "HEAD", "a..b.txt", "!bang.txt",
	"~tilde.txt", "$(touch pwned).txt", "`touch pwned`.txt", "; touch pwned.txt", "| touch pwned.txt",
	"tab\tname.txt", "new\nline.txt", "-c core.pager=touch pwned",
}

// oneLine keeps a name that holds a newline on one line, so it can be written as a line of a file.
func oneLine(name string) string { return strings.ReplaceAll(name, "\n", "⏎") }

func skipOnWindows(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("these names can't be made on Windows")
	}
}

func TestHostileFileNamesAreShownAsNamesAndNeverRunOrObeyed(t *testing.T) {
	skipOnWindows(t)
	reader := requireGit(t)
	dir := newRepo(t)
	for _, name := range hostileNames {
		put(t, dir, filepath.Join("tracked", name), "before\n")
	}
	commitAll(t, dir)
	for _, name := range hostileNames {
		put(t, dir, filepath.Join("tracked", name), "before\nafter "+oneLine(name)+"\n")
		put(t, dir, name, "new "+oneLine(name)+"\n")
	}
	changes := read(t, reader, dir)
	if changes.State != models.ChangesRead {
		t.Fatalf("state %s: %s", changes.State, changes.Message)
	}
	if changes.FileCount != 2*len(hostileNames) {
		t.Errorf("%d files, want %d", changes.FileCount, 2*len(hostileNames))
	}
	for _, name := range hostileNames {
		// Changed, with the right counts and the right text.
		tracked := fileOf(t, changes, "tracked/"+name)
		if tracked.Status != models.ChangeModified || tracked.Added != 1 || tracked.Removed != 0 ||
			!strings.Contains(strings.Join(linesOf(tracked), "\n"), "+after "+oneLine(name)) {
			t.Errorf("tracked %q = %+v", name, tracked)
		}
		fresh := fileOf(t, changes, name)
		if fresh.Status != models.ChangeUntracked || fresh.Added != 1 ||
			strings.Join(linesOf(fresh), "\n") != "+new "+oneLine(name) {
			t.Errorf("untracked %q = %+v", name, fresh)
		}
	}
	// Nothing ran as a command, and no name was taken for an option: those would leave files.
	for _, leftover := range []string{"pwned", "pwned.txt", "pwned HEAD"} {
		if _, err := os.Stat(filepath.Join(dir, leftover)); err == nil {
			t.Errorf("%s was made", leftover)
		}
	}
}

// fingerprint is every file under dir: its size, time and a hash of what is in it.
func fingerprint(t *testing.T, dir string) map[string]string {
	t.Helper()
	found := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(dir, path)
		sum := ""
		if info.Mode().IsRegular() {
			data, readErr := os.ReadFile(path) // #nosec G304 -- the test's own folder
			if readErr != nil {
				return readErr
			}
			sum = fmt.Sprintf("%x", sha256.Sum256(data))
		}
		found[relative] = fmt.Sprintf("%d %d %s", info.Size(), info.ModTime().UnixNano(), sum)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func differences(before, after map[string]string) []string {
	var changed []string
	for name, value := range after {
		if before[name] != value {
			changed = append(changed, name)
		}
	}
	for name := range before {
		if _, ok := after[name]; !ok {
			changed = append(changed, name)
		}
	}
	return changed
}

// dirtyStat makes a repository whose index has out-of-date file times: the contents are the same,
// so Git would quietly rewrite its index to remember the new times.
func dirtyStat(t *testing.T) string {
	t.Helper()
	dir := newRepo(t)
	put(t, dir, "a.txt", "one\n")
	put(t, dir, "b.txt", "two\n")
	commitAll(t, dir)
	later := time.Now().Add(time.Hour)
	for _, name := range []string{"a.txt", "b.txt"} {
		if err := os.Chtimes(filepath.Join(dir, name), later, later); err != nil {
			t.Fatal(err)
		}
	}
	put(t, dir, "a.txt", "one\nchanged\n")
	put(t, dir, "new.txt", "new\n")
	return dir
}

// Reading changes writes nothing at all: not a file in .git, not the index Git refreshes when it
// finds file times have moved. The control, first, shows that this folder is one Git would write to.
func TestReadingChangesWritesNothing(t *testing.T) {
	reader := requireGit(t)

	control := dirtyStat(t)
	before := fingerprint(t, control)
	gitIn(t, control, "status", "--porcelain")
	gitIn(t, control, "diff", "HEAD")
	if len(differences(before, fingerprint(t, control))) == 0 {
		t.Fatal("plain Git left this folder alone, so the check below can't tell a read-only read from a writing one")
	}

	dir := dirtyStat(t)
	before = fingerprint(t, dir)
	for range 3 {
		if changes := read(t, reader, dir); changes.State != models.ChangesRead || changes.FileCount != 2 {
			t.Fatalf("changes = %+v", changes)
		}
	}
	if changed := differences(before, fingerprint(t, dir)); len(changed) != 0 {
		t.Errorf("reading changed %v", changed)
	}
}

// canarySetup makes a repository with one setting that names a program, and a program that leaves
// a mark when it runs. The files' times are out of date and a file is changed, so Git has reason
// to compare them.
func canarySetup(t *testing.T, key string) (dir, canary string) {
	t.Helper()
	skipOnWindows(t)
	dir = newRepo(t)
	scripts := t.TempDir()
	canary = filepath.Join(scripts, "ran")
	program := filepath.Join(scripts, "evil.sh")
	if err := os.WriteFile(program, []byte("#!/bin/sh\necho ran >> '"+canary+"'\ncat\n"), 0o700); err != nil { // #nosec G306 -- the test's own program
		t.Fatal(err)
	}
	put(t, dir, "a.txt", "one\n")
	put(t, dir, "b.txt", "two\n")
	commitAll(t, dir)
	later := time.Now().Add(time.Hour)
	for _, name := range []string{"a.txt", "b.txt"} {
		if err := os.Chtimes(filepath.Join(dir, name), later, later); err != nil {
			t.Fatal(err)
		}
	}
	put(t, dir, "a.txt", "one\nchanged\n")
	put(t, dir, ".gitattributes", "*.txt diff=evil filter=evil\n")
	put(t, dir, "new.txt", "new\n")
	gitIn(t, dir, "config", key, program)
	return dir, canary
}

// Each way a repository can name a program for Git to run while it reads. The control for each is
// that plain Git does run it, so the setting really is hostile; then the reader is shown not to.
func TestARepositoryCannotMakeReadingRunItsPrograms(t *testing.T) {
	reader := requireGit(t)
	for _, key := range []string{"core.fsmonitor", "diff.external", "diff.evil.textconv", "filter.evil.clean"} {
		t.Run(key, func(t *testing.T) {
			control, controlCanary := canarySetup(t, key)
			gitIn(t, control, "status", "--porcelain")
			gitIn(t, control, "diff", "HEAD")
			if _, err := os.Stat(controlCanary); err != nil {
				t.Fatalf("plain Git didn't run the program %s names, so this proves nothing", key)
			}

			dir, canary := canarySetup(t, key)
			changes := read(t, reader, dir)
			if changes.State != models.ChangesRead || changes.FileCount != 3 {
				t.Fatalf("changes = %+v", changes)
			}
			if _, err := os.Stat(canary); err == nil {
				t.Errorf("reading ran the program %s names", key)
			}
		})
	}
}

// A filter in the person's own Git settings is left alone: they chose it.
func TestAFilterTheUserSetIsNotSwitchedOff(t *testing.T) {
	skipOnWindows(t)
	reader := requireGit(t)
	scripts := t.TempDir()
	canary := filepath.Join(scripts, "ran")
	program := filepath.Join(scripts, "mine.sh")
	if err := os.WriteFile(program, []byte("#!/bin/sh\necho ran >> '"+canary+"'\ncat\n"), 0o700); err != nil { // #nosec G306 -- the test's own program
		t.Fatal(err)
	}
	dir := newRepo(t)
	put(t, dir, "a.txt", "one\n")
	put(t, dir, ".gitattributes", "*.txt filter=mine\n")
	commitAll(t, dir)
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "a.txt"), later, later); err != nil {
		t.Fatal(err)
	}
	put(t, dir, "a.txt", "one\nchanged\n")
	// Home is the test's own, so this is "the user's global settings".
	gitIn(t, dir, "config", "--global", "filter.mine.clean", program)
	if changes := read(t, reader, dir); changes.State != models.ChangesRead || changes.FileCount != 1 {
		t.Fatalf("changes = %+v", changes)
	}
	if _, err := os.Stat(canary); err != nil {
		t.Error("the user's own filter was switched off")
	}
}

// A repository whose settings send Git to another working folder isn't read.
func TestARepositoryThatPointsElsewhereIsNotRead(t *testing.T) {
	reader := requireGit(t)
	elsewhere := t.TempDir()
	put(t, elsewhere, "private.txt", "ELSEWHERE-CANARY\n")
	dir := newRepo(t)
	put(t, dir, "a.txt", "one\n")
	commitAll(t, dir)
	gitIn(t, dir, "config", "core.worktree", elsewhere)
	changes := read(t, reader, dir)
	encoded, _ := json.Marshal(changes)
	if changes.State == models.ChangesRead || strings.Contains(string(encoded), "ELSEWHERE-CANARY") {
		t.Errorf("changes = %s", encoded)
	}
}

func TestLinksAreNeverFollowedOutOfTheFolder(t *testing.T) {
	skipOnWindows(t)
	reader := requireGit(t)
	outside := t.TempDir()
	put(t, outside, "secret.txt", "OUTSIDE-CANARY\n")
	put(t, outside, "folder/inner.txt", "OUTSIDE-CANARY-INNER\n")
	dir := newRepo(t)
	put(t, dir, "a.txt", "one\n")
	// One link is tracked, and is then changed to point somewhere else.
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(dir, "tracked-link")); err != nil {
		t.Fatal(err)
	}
	commitAll(t, dir)
	if err := os.Remove(filepath.Join(dir, "tracked-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "folder"), filepath.Join(dir, "tracked-link")); err != nil {
		t.Fatal(err)
	}
	// The others are new, and point at everything a link can.
	for name, target := range map[string]string{
		"to-file":     filepath.Join(outside, "secret.txt"),
		"to-folder":   filepath.Join(outside, "folder"),
		"relative":    "../../../../../../../../" + filepath.Join(outside, "secret.txt"),
		"to-parent":   "..",
		"loop":        "loop",
		"dangling":    "no/such/place",
		"to-home-ish": "/etc/passwd",
	} {
		if err := os.Symlink(target, filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	changes := read(t, reader, dir)
	if changes.State != models.ChangesRead {
		t.Fatalf("state %s: %s", changes.State, changes.Message)
	}
	encoded, _ := json.Marshal(changes)
	for _, leak := range []string{"OUTSIDE-CANARY", "OUTSIDE-CANARY-INNER", "root:"} {
		if strings.Contains(string(encoded), leak) {
			t.Errorf("%q from outside the folder is in the answer", leak)
		}
	}
	// What is shown for a link is where it points, as Git records it, as a line of its own.
	if link := fileOf(t, changes, "to-file"); link.Added != 1 || len(link.Hunks) != 1 {
		t.Errorf("to-file = %+v", link)
	}
}

func TestAFolderOutsideAnyRepositoryIsNotRead(t *testing.T) {
	reader := requireGit(t)
	repo := newRepo(t)
	put(t, repo, "inside.txt", "INSIDE-CANARY\n")
	commitAll(t, repo)
	put(t, repo, "inside.txt", "INSIDE-CANARY\nchanged\n")
	// A folder next to it, and one under it that is ignored by it, are not the repository's.
	elsewhere := t.TempDir()
	if changes := read(t, reader, elsewhere); changes.State != models.ChangesNotRepo || len(changes.Files) != 0 {
		t.Errorf("elsewhere = %+v", changes)
	}
	put(t, repo, ".gitignore", "ignored/\n")
	put(t, repo, "ignored/x.txt", "x\n")
	if changes := read(t, reader, filepath.Join(repo, "ignored")); len(changes.Files) != 0 {
		t.Errorf("ignored = %+v", changes)
	}
}

func TestVariablesSetForMabariDoNotPointGitAtAnotherRepository(t *testing.T) {
	reader := requireGit(t)
	mine := newRepo(t)
	put(t, mine, "mine.txt", "one\n")
	commitAll(t, mine)
	put(t, mine, "mine.txt", "one\ntwo\n")
	other := newRepo(t)
	put(t, other, "other.txt", "OTHER-CANARY\n")
	commitAll(t, other)
	put(t, other, "other.txt", "OTHER-CANARY\nchanged\n")
	t.Setenv("GIT_DIR", filepath.Join(other, ".git"))
	t.Setenv("GIT_WORK_TREE", other)
	t.Setenv("GIT_INDEX_FILE", filepath.Join(other, ".git", "index"))
	t.Setenv("GIT_EXTERNAL_DIFF", "/bin/false")
	changes := read(t, reader, mine)
	if changes.State != models.ChangesRead || changes.FileCount != 1 || changes.Files[0].Path != "mine.txt" {
		t.Errorf("changes = %+v", changes)
	}
}

func TestABareRepositoryInsideTheFolderIsNotTakenAsItsOwn(t *testing.T) {
	reader := requireGit(t)
	dir := t.TempDir()
	gitIn(t, dir, "init", "-q", "--bare")
	put(t, dir, "stray.txt", "x\n")
	changes := read(t, reader, dir)
	if changes.State == models.ChangesRead || len(changes.Files) != 0 {
		t.Errorf("changes = %+v", changes)
	}
}

func TestSecretsNeverReachThePage(t *testing.T) {
	reader := requireGit(t)
	dir := newRepo(t)
	put(t, dir, "config.env", "NAME=shop\nAPI_KEY=old-value-1234\nPORT=80\n")
	commitAll(t, dir)
	pem := "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAPEM-BODY-LINE-ONE\nPEM-BODY-LINE-TWO/abc+def==\n-----END RSA PRIVATE KEY-----\n"
	put(t, dir, "config.env", "NAME=shop\nAPI_KEY=sk-ant-api03-abcdefghijklmnop\nPORT=8080\npassword = \"hunter2hunter2\"\nauthorization: Bearer abcdef1234567890\n")
	put(t, dir, "deploy.txt", "before\n"+pem+"after\n")
	put(t, dir, "id_rsa", "KEY-FILE-CANARY\nmore\n")
	put(t, dir, "tokens/ghp_abcdefghijklmnopqrstuvwxyz0123.txt", "clean\n")
	changes := read(t, reader, dir)
	if changes.State != models.ChangesRead {
		t.Fatalf("state %s: %s", changes.State, changes.Message)
	}
	encoded, _ := json.Marshal(changes)
	for _, secret := range []string{
		"sk-ant-api03-abcdefghijklmnop", "hunter2hunter2", "abcdef1234567890", "PEM-BODY-LINE-ONE",
		"PEM-BODY-LINE-TWO", "MIIEowIBAAKCAQEAPEM", "KEY-FILE-CANARY", "ghp_abcdefghijklmnopqrstuvwxyz0123",
	} {
		if strings.Contains(string(encoded), secret) {
			t.Errorf("the secret %q reached the answer", secret)
		}
	}
	// The key's lines are hidden one by one, so the lines after it keep their numbers.
	deploy := fileOf(t, changes, "deploy.txt")
	var after models.ChangeLine
	for _, hunk := range deploy.Hunks {
		for _, line := range hunk.Lines {
			if line.Text == "after" {
				after = line
			}
		}
	}
	if after.New != 6 || deploy.Added != 6 {
		t.Errorf("after = %+v, deploy = +%d", after, deploy.Added)
	}
	// What isn't secret is still there.
	config := fileOf(t, changes, "config.env")
	joined := strings.Join(linesOf(config), "\n")
	if !strings.Contains(joined, "+PORT=8080") || !strings.Contains(joined, "-PORT=80") {
		t.Errorf("config = %s", joined)
	}
	if key := fileOf(t, changes, "id_rsa"); len(key.Hunks) != 0 || !strings.Contains(key.Note, "hidden") || key.Added != 2 {
		t.Errorf("id_rsa = %+v", key)
	}
}

func TestBigChangesAreCutAndSaySo(t *testing.T) {
	reader := requireGit(t)
	dir := newRepo(t)
	put(t, dir, "base.txt", "base\n")
	commitAll(t, dir)
	var many strings.Builder
	for i := range 5000 {
		fmt.Fprintf(&many, "line %d\n", i)
	}
	put(t, dir, "long.txt", many.String())
	put(t, dir, "wide.txt", strings.Repeat("w", 2<<20)+"\n")
	put(t, dir, "huge.txt", strings.Repeat("0123456789abcdef\n", 20_000)) // Over what is opened for a new file.
	changes := read(t, reader, dir)
	if changes.State != models.ChangesRead || !changes.Truncated {
		t.Fatalf("state %s, truncated %v", changes.State, changes.Truncated)
	}
	long := fileOf(t, changes, "long.txt")
	shown := 0
	for _, hunk := range long.Hunks {
		shown += len(hunk.Lines)
	}
	if long.Note != "New file, too large to show here." || shown != 0 {
		// 5000 short lines are under the size a new file is opened to, so they are cut by lines.
		if shown != models.ChangesFileLinesMax || !strings.Contains(long.Note, "first 1500 of 5000") || long.Added != 5000 {
			t.Errorf("long = note %q, shown %d, +%d", long.Note, shown, long.Added)
		}
	}
	wide := fileOf(t, changes, "wide.txt")
	if len(wide.Hunks) != 0 || wide.Note == "" {
		t.Errorf("wide = note %q, hunks %d", wide.Note, len(wide.Hunks))
	}
	if huge := fileOf(t, changes, "huge.txt"); huge.Note != "New file, too large to show here." || len(huge.Hunks) != 0 {
		t.Errorf("huge = %+v", huge.Note)
	}
	if encoded, _ := json.Marshal(changes); len(encoded) > 1<<20 {
		t.Errorf("the answer is %d bytes", len(encoded))
	}
}

func TestOneVeryLongLineIsClipped(t *testing.T) {
	reader := requireGit(t)
	dir := newRepo(t)
	put(t, dir, "a.txt", "one\n")
	commitAll(t, dir)
	put(t, dir, "a.txt", "one\n"+strings.Repeat("é", 90_000)+"\n")
	changes := read(t, reader, dir)
	a := fileOf(t, changes, "a.txt")
	last := a.Hunks[0].Lines[len(a.Hunks[0].Lines)-1].Text
	if want := strings.Repeat("é", models.ChangesLineRunesMax) + "…"; last != want {
		t.Errorf("clipped line is %d bytes", len(last))
	}
}

func TestTrackedChangesBeyondTheLinesBudgetKeepTheirCounts(t *testing.T) {
	reader := requireGit(t)
	dir := newRepo(t)
	for i := range 10 {
		put(t, dir, fmt.Sprintf("f%02d.txt", i), "x\n")
	}
	commitAll(t, dir)
	for i := range 10 {
		var body strings.Builder
		for line := range 1000 {
			fmt.Fprintf(&body, "file %d line %d\n", i, line)
		}
		put(t, dir, fmt.Sprintf("f%02d.txt", i), body.String())
	}
	changes := read(t, reader, dir)
	if !changes.Truncated || changes.FileCount != 10 {
		t.Fatalf("changes = %+v", changes)
	}
	shown, cutOff := 0, 0
	for _, file := range changes.Files {
		if file.Added != 1000 || file.Removed != 1 {
			t.Errorf("%s = +%d -%d", file.Path, file.Added, file.Removed)
		}
		if len(file.Hunks) > 0 {
			shown++
		} else if file.Note != "" {
			cutOff++
		}
	}
	if shown == 0 || cutOff == 0 || shown+cutOff != 10 {
		t.Errorf("%d shown and %d cut off", shown, cutOff)
	}
	lines := 0
	for _, file := range changes.Files {
		for _, hunk := range file.Hunks {
			lines += len(hunk.Lines)
		}
	}
	if lines > models.ChangesLinesMax {
		t.Errorf("%d lines are shown, more than %d", lines, models.ChangesLinesMax)
	}
}

func TestPatchesBeyondTheByteLimitAreCutWithoutPuttingTextOnTheWrongFile(t *testing.T) {
	reader := requireGit(t)
	// A small limit, so the test needn't write megabytes: 12 files of about 20 KB against 100 KB.
	reader.patchMax = 100 << 10
	dir := newRepo(t)
	line := strings.Repeat("a", 190)
	for i := range 12 {
		put(t, dir, fmt.Sprintf("f%02d.txt", i), "x\n")
	}
	commitAll(t, dir)
	for i := range 12 {
		var body strings.Builder
		for l := range 100 {
			fmt.Fprintf(&body, "%s %d %d\n", line, i, l)
		}
		put(t, dir, fmt.Sprintf("f%02d.txt", i), body.String())
	}
	changes := read(t, reader, dir)
	if !changes.Truncated || changes.FileCount != 12 {
		t.Fatalf("truncated %v, files %d", changes.Truncated, changes.FileCount)
	}
	withText := 0
	for _, file := range changes.Files {
		if len(file.Hunks) > 0 {
			withText++
		}
		if file.Added != 100 || !file.Counted {
			t.Errorf("%s = +%d counted %v", file.Path, file.Added, file.Counted)
		}
		// Each line ends with its own file's number and then its line's: a line that belongs to
		// another file would carry that file's number.
		var number int
		if _, err := fmt.Sscanf(file.Path, "f%d.txt", &number); err != nil {
			t.Fatal(err)
		}
		for _, hunk := range file.Hunks {
			for _, shown := range hunk.Lines {
				if shown.Kind != "add" {
					continue
				}
				fields := strings.Fields(shown.Text)
				if len(fields) != 3 || fields[1] != fmt.Sprint(number) {
					t.Errorf("%s shows a line that isn't its own: %q", file.Path, fields[1:])
				}
			}
		}
	}
	// Some files have their text and the rest, past the limit, only their counts.
	if withText == 0 || withText == 12 {
		t.Errorf("%d of 12 files have their text, want some but not all", withText)
	}
}

func TestManyFilesAreCapped(t *testing.T) {
	reader := requireGit(t)
	dir := newRepo(t)
	for i := range 340 {
		put(t, dir, fmt.Sprintf("d/f%03d.txt", i), "x\n")
	}
	commitAll(t, dir)
	for i := range 340 {
		put(t, dir, fmt.Sprintf("d/f%03d.txt", i), "y\n")
	}
	changes := read(t, reader, dir)
	if changes.FileCount != 340 || len(changes.Files) != models.ChangesFilesMax || !changes.Truncated ||
		changes.Added != 340 || changes.Removed != 340 {
		t.Errorf("count %d, listed %d, truncated %v, +%d -%d", changes.FileCount, len(changes.Files),
			changes.Truncated, changes.Added, changes.Removed)
	}
}

func TestTooManyNewFilesAreListedButNotAllOpened(t *testing.T) {
	reader := requireGit(t)
	dir := newRepo(t)
	put(t, dir, "base.txt", "base\n")
	commitAll(t, dir)
	for i := range 50 {
		put(t, dir, fmt.Sprintf("new/n%02d.txt", i), "n\n")
	}
	changes := read(t, reader, dir)
	if changes.FileCount != 50 || !changes.Truncated {
		t.Fatalf("count %d truncated %v", changes.FileCount, changes.Truncated)
	}
	opened := 0
	for _, file := range changes.Files {
		if file.Counted {
			opened++
		} else if !strings.Contains(file.Note, "too many new files") {
			t.Errorf("%s = %+v", file.Path, file)
		}
	}
	if opened != untrackedMax {
		t.Errorf("%d opened, want %d", opened, untrackedMax)
	}
}

func TestANestedRepositoryIsAFolderNotItsFiles(t *testing.T) {
	reader := requireGit(t)
	dir := newRepo(t)
	put(t, dir, "base.txt", "base\n")
	commitAll(t, dir)
	nested := filepath.Join(dir, "vendor", "lib")
	if err := os.MkdirAll(nested, 0o750); err != nil {
		t.Fatal(err)
	}
	gitIn(t, nested, "init", "-q")
	put(t, nested, "inner.txt", "NESTED-CANARY\n")
	changes := read(t, reader, dir)
	encoded, _ := json.Marshal(changes)
	if strings.Contains(string(encoded), "NESTED-CANARY") {
		t.Error("a nested repository's files were read")
	}
}

func TestAMergeConflictIsShownAsOne(t *testing.T) {
	reader := requireGit(t)
	dir := newRepo(t)
	put(t, dir, "a.txt", "one\n")
	commitAll(t, dir)
	gitIn(t, dir, "checkout", "-q", "-b", "other")
	put(t, dir, "a.txt", "from other\n")
	gitIn(t, dir, "commit", "-q", "-am", "other")
	gitIn(t, dir, "checkout", "-q", "main")
	put(t, dir, "a.txt", "from main\n")
	gitIn(t, dir, "commit", "-q", "-am", "main")
	cmd := gitCommand(dir, "merge", "other")
	_ = cmd.Run() // Fails on purpose: the files conflict.
	changes := read(t, reader, dir)
	if changes.State != models.ChangesRead || changes.FileCount != 1 {
		t.Fatalf("changes = %+v", changes)
	}
	if a := fileOf(t, changes, "a.txt"); a.Status != models.ChangeConflict {
		t.Errorf("a = %+v", a)
	}
}

func TestACallThatNeverEndsIsStopped(t *testing.T) {
	skipOnWindows(t)
	script := filepath.Join(t.TempDir(), "git")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 30\n"), 0o700); err != nil { // #nosec G306 -- the test's own program
		t.Fatal(err)
	}
	reader := &Reader{git: script, gate: make(chan struct{}, 1), wait: 300 * time.Millisecond}
	started := time.Now()
	changes := reader.Read(context.Background(), t.TempDir(), "")
	if changes.State != models.ChangesFailed || !strings.Contains(changes.Message, "took too long") {
		t.Errorf("changes = %+v", changes)
	}
	if time.Since(started) > 10*time.Second {
		t.Errorf("it took %s to give up", time.Since(started))
	}
}

func TestOutputThatNeverEndsIsCutAndTheProgramStopped(t *testing.T) {
	skipOnWindows(t)
	script := filepath.Join(t.TempDir(), "git")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"), 0o700); err != nil { // #nosec G306 -- the test's own program
		t.Fatal(err)
	}
	reader := &Reader{git: script, gate: make(chan struct{}, 1)}
	started := time.Now()
	res, err := reader.run(context.Background(), t.TempDir(), 5000, "anything")
	if err != nil || !res.cut || len(res.out) != 5000 {
		t.Errorf("cut %v, %d bytes, err %v", res.cut, len(res.out), err)
	}
	if time.Since(started) > 5*time.Second {
		t.Errorf("it took %s", time.Since(started))
	}
}

func TestAtMostAFewGitProgramsRunAtOnce(t *testing.T) {
	skipOnWindows(t)
	dir := t.TempDir()
	mark := filepath.Join(dir, "running")
	script := filepath.Join(dir, "git")
	body := "#!/bin/sh\nmkdir '" + mark + ".'$$ 2>/dev/null\nsleep 0.3\nn=$(ls -d '" + mark + ".'* | wc -l)\necho $n\nrmdir '" + mark + ".'$$\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil { // #nosec G306 -- the test's own program
		t.Fatal(err)
	}
	reader := &Reader{git: script, gate: make(chan struct{}, 2)}
	results := make(chan string, 8)
	for range 8 {
		go func() {
			res, _ := reader.run(context.Background(), dir, 100, "x")
			results <- strings.TrimSpace(string(res.out))
		}()
	}
	for range 8 {
		if got := <-results; got != "1" && got != "2" {
			t.Errorf("%s programs ran together, want at most 2", got)
		}
	}
}
