// SPDX-License-Identifier: Apache-2.0

package service

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

type fakeRunner struct {
	calls   []string
	answers map[string]string
	fail    map[string]bool
}

func (f *fakeRunner) run(_ context.Context, name string, args ...string) (string, error) {
	call := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, call)
	for prefix := range f.fail {
		if strings.HasPrefix(call, prefix) {
			return "boom", errors.New("exit status 1")
		}
	}
	for prefix, answer := range f.answers {
		if strings.HasPrefix(call, prefix) {
			return answer, nil
		}
	}
	return "", nil
}

func fake(t *testing.T, goos string) (Service, *fakeRunner) {
	t.Helper()
	home := t.TempDir()
	runner := &fakeRunner{answers: map[string]string{}, fail: map[string]bool{}}
	binary := "/opt/homebrew/bin/mabari"
	if goos == "windows" {
		binary = `C:\Mabari\mabari.exe`
	}
	return Service{
		OS: goos, Home: home, AppData: filepath.Join(home, "AppData"), UID: 501,
		Binary: binary,
		Env:    [][2]string{{"PATH", "/usr/bin:/bin"}, {"MABARI_PORT", "4400"}},
		Run:    runner.run,
	}, runner
}

func TestEnvironmentNeverCopiesTheMasterKey(t *testing.T) {
	env := Environment(func(key string) string {
		return map[string]string{
			"PATH": "/usr/bin", "MABARI_MASTER_KEY": "secret", "MABARI_DATA_DIR": "/d", "HOME": "/h",
		}[key]
	})
	want := [][2]string{{"PATH", "/usr/bin"}, {"MABARI_DATA_DIR", "/d"}}
	if len(env) != len(want) || env[0] != want[0] || env[1] != want[1] {
		t.Fatalf("env = %v", env)
	}
}

func TestLaunchAgent(t *testing.T) {
	s, _ := fake(t, "darwin")
	s.Binary = "/Users/a & b/mabari"
	file, err := s.File()
	if err != nil {
		t.Fatal(err)
	}
	if file.Path != filepath.Join(s.Home, "Library", "LaunchAgents", "dev.mabari.plist") {
		t.Errorf("path = %s", file.Path)
	}
	// It is well formed XML, with the binary escaped and the log in ~/.mabari/logs.
	if err := xml.Unmarshal(file.Content, new(any)); err != nil {
		t.Fatalf("not XML: %v\n%s", err, file.Content)
	}
	for _, want := range []string{
		"<string>/Users/a &amp; b/mabari</string>", "<string>serve</string>",
		filepath.Join(s.Home, ".mabari", "logs", "mabari.log"), "<key>RunAtLoad</key>\n  <true/>",
		"<key>SuccessfulExit</key>\n    <false/>", "<key>MABARI_PORT</key>\n    <string>4400</string>", Marker,
	} {
		if !strings.Contains(file.Show, want) {
			t.Errorf("missing %q in\n%s", want, file.Show)
		}
	}
}

func TestSystemdUnit(t *testing.T) {
	s, _ := fake(t, "linux")
	s.Binary = `/home/a b/mabari`
	s.Env = append(s.Env, [2]string{"MABARI_DATA_DIR", `/data/100%"x"`})
	file, err := s.File()
	if err != nil {
		t.Fatal(err)
	}
	if file.Path != filepath.Join(s.Home, ".config", "systemd", "user", "mabari.service") {
		t.Errorf("path = %s", file.Path)
	}
	for _, want := range []string{
		`ExecStart="/home/a b/mabari" serve --log-file "` + filepath.Join(s.Home, ".mabari", "logs", "mabari.log") + `"`,
		"Restart=on-failure", "WantedBy=default.target",
		`Environment="MABARI_DATA_DIR=/data/100%%\"x\""`, "# " + Marker,
	} {
		if !strings.Contains(file.Show, want) {
			t.Errorf("missing %q in\n%s", want, file.Show)
		}
	}
	s.ConfigHome = "/xdg"
	if file, _ := s.File(); file.Path != "/xdg/systemd/user/mabari.service" {
		t.Errorf("XDG path = %s", file.Path)
	}
}

func TestWindowsTask(t *testing.T) {
	s, _ := fake(t, "windows")
	s.Binary = `C:\Program Files\Mabari\mabari.exe`
	s.AppData = `C:\Users\a\AppData\Roaming`
	file, err := s.File()
	if err != nil {
		t.Fatal(err)
	}
	if file.Content[0] != 0xFF || file.Content[1] != 0xFE || fromUTF16(file.Content) != file.Show {
		t.Error("not UTF-16 with a byte order mark")
	}
	for _, want := range []string{
		`<Command>C:\Program Files\Mabari\mabari.exe</Command>`, "<LogonTrigger>", "<RestartOnFailure>",
		"<LogonType>InteractiveToken</LogonType>", "<RunLevel>LeastPrivilege</RunLevel>",
		"--port 4400", "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
	} {
		if !strings.Contains(file.Show, want) {
			t.Errorf("missing %q in\n%s", want, file.Show)
		}
	}
}

func TestUnsupportedAndRelativeBinary(t *testing.T) {
	s, _ := fake(t, "plan9")
	if _, err := s.File(); !errors.Is(err, ErrUnsupported) {
		t.Errorf("plan9: %v", err)
	}
	s, _ = fake(t, "darwin")
	s.Binary = "mabari"
	if _, err := s.File(); err == nil {
		t.Error("relative binary accepted")
	}
	if status := s.Status(context.Background()); status.Supported {
		t.Errorf("status = %+v", status)
	}
}

func TestInstallAndUninstallOnEachSystem(t *testing.T) {
	cases := map[string]struct{ install, uninstall []string }{
		"darwin": {
			[]string{"launchctl bootout gui/501/dev.mabari", "launchctl bootstrap gui/501 "},
			[]string{"launchctl bootout gui/501/dev.mabari"},
		},
		"linux": {
			[]string{"systemctl --user daemon-reload", "systemctl --user enable --now mabari.service"},
			[]string{"systemctl --user disable --now mabari.service", "systemctl --user daemon-reload"},
		},
		"windows": {
			[]string{"schtasks /Create /TN Mabari /XML ", "schtasks /Run /TN Mabari"},
			[]string{"schtasks /End /TN Mabari", "schtasks /Delete /TN Mabari /F"},
		},
	}
	for goos, want := range cases {
		t.Run(goos, func(t *testing.T) {
			s, runner := fake(t, goos)
			ctx := context.Background()
			if err := s.Enable(ctx, true); err != nil {
				t.Fatal(err)
			}
			matches(t, runner.calls, want.install)
			file, _ := s.File()
			if info, err := os.Stat(file.Path); err != nil || info.Mode().Perm() != 0o600 {
				t.Fatalf("file: %v %v", info, err)
			}
			if !s.Status(ctx).Installed {
				t.Error("not installed")
			}
			runner.calls = nil
			if err := s.Disable(ctx, true); err != nil {
				t.Fatal(err)
			}
			matches(t, runner.calls, want.uninstall)
			if _, err := os.Stat(file.Path); !os.IsNotExist(err) {
				t.Errorf("file left: %v", err)
			}
		})
	}
}

func matches(t *testing.T, calls, want []string) {
	t.Helper()
	if len(calls) != len(want) {
		t.Fatalf("calls = %q, want %q", calls, want)
	}
	for i := range want {
		if !strings.HasPrefix(calls[i], want[i]) {
			t.Errorf("call %d = %q, want %q", i, calls[i], want[i])
		}
	}
}

// Settings turns it on for the next login without starting a second Mabari, and off without
// stopping the one that is answering.
func TestSettingsSwitchLeavesTheRunningMabariAlone(t *testing.T) {
	for goos, forbidden := range map[string]string{"darwin": "launchctl", "linux": "--now", "windows": "/Run"} {
		s, runner := fake(t, goos)
		if err := s.Enable(context.Background(), false); err != nil {
			t.Fatal(err)
		}
		if err := s.Disable(context.Background(), false); err != nil {
			t.Fatal(err)
		}
		for _, call := range runner.calls {
			if strings.Contains(call, forbidden) || strings.Contains(call, "/End") {
				t.Errorf("%s: %q", goos, call)
			}
		}
	}
}

func TestSomeoneElsesFileIsBackedUpAndPutBack(t *testing.T) {
	s, _ := fake(t, "darwin")
	file, _ := s.File()
	if err := os.MkdirAll(filepath.Dir(file.Path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file.Path, []byte("theirs"), 0o600); err != nil {
		t.Fatal(err)
	}
	if s.Status(context.Background()).Installed {
		t.Error("their file counted as installed")
	}
	if err := s.Enable(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if backup, _ := os.ReadFile(file.Path + ".backup"); string(backup) != "theirs" {
		t.Errorf("backup = %q", backup)
	}
	if err := s.Disable(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if restored, _ := os.ReadFile(file.Path); string(restored) != "theirs" {
		t.Errorf("restored = %q", restored)
	}
}

func TestUninstallNeverRemovesAFileItDidNotWrite(t *testing.T) {
	s, _ := fake(t, "linux")
	file, _ := s.File()
	_ = os.MkdirAll(filepath.Dir(file.Path), 0o700)
	_ = os.WriteFile(file.Path, []byte("[Unit]\n"), 0o600)
	if err := s.Disable(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if content, _ := os.ReadFile(file.Path); string(content) != "[Unit]\n" {
		t.Errorf("their file changed: %q", content)
	}
}

func TestStatusAndControls(t *testing.T) {
	s, runner := fake(t, "darwin")
	ctx := context.Background()
	if err := s.Start(ctx); err == nil || !strings.Contains(err.Error(), "service install") {
		t.Errorf("start before install: %v", err)
	}
	_ = s.Enable(ctx, false)
	runner.answers["launchctl print"] = "gui/501/dev.mabari = {\n\tstate = running\n}"
	if status := s.Status(ctx); !status.Running || status.Detail != "Installed and running" {
		t.Errorf("status = %+v", status)
	}
	runner.calls = nil
	_ = s.Stop(ctx)
	_ = s.Restart(ctx)
	_ = s.Start(ctx)
	matches(t, runner.calls, []string{
		"launchctl kill SIGTERM gui/501/dev.mabari", "launchctl kickstart -k gui/501/dev.mabari",
		"launchctl kickstart gui/501/dev.mabari",
	})
	runner.fail["launchctl kickstart"] = true
	if err := s.Start(ctx); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Errorf("failure hidden: %v", err)
	}
}

// TestRealService installs a real service under a test name, checks Mabari answers, crashes it
// to see it restarted, then uninstalls it. It needs MABARI_SERVICE_E2E=1 and a built mabari in
// MABARI_BINARY, because it runs real launchd, systemd or Task Scheduler jobs. CI runs it on
// all three systems; on Linux it writes to the real ~/.config/systemd/user, so run it on a
// throwaway machine there.
func TestRealService(t *testing.T) {
	binary := os.Getenv("MABARI_BINARY")
	if os.Getenv("MABARI_SERVICE_E2E") != "1" || binary == "" {
		t.Skip("set MABARI_SERVICE_E2E=1 and MABARI_BINARY to install a real service")
	}
	home := t.TempDir()
	port := "4391"
	realHome, _ := os.UserHomeDir()
	// The service runs a copy, so the upgrade below can replace it as a package manager would.
	installed := filepath.Join(home, "bin", filepath.Base(binary))
	copyFile(t, binary, installed)
	s := Service{
		OS: runtime.GOOS, Home: home, AppData: filepath.Join(home, "AppData"), UID: os.Getuid(),
		Binary: installed, Label: "dev.mabari.test",
		Env: [][2]string{
			{"PATH", os.Getenv("PATH")}, {"MABARI_PORT", port}, {"MABARI_DATA_DIR", filepath.Join(home, "data")},
			{"MABARI_SECRETS", "encrypted-file"}, {"MABARI_MASTER_KEY_FILE", writeKey(t, home)},
		},
		Run: Exec,
	}
	switch runtime.GOOS {
	case "linux":
		// systemd only reads units from the real config folder.
		s.Home, s.Label = realHome, "mabari-test"
	case "windows":
		s.Label = "MabariTest"
	}
	ctx := context.Background()
	if err := s.Enable(ctx, true); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Disable(ctx, true) })
	waitHealthy(t, binary, port)
	if !s.Status(ctx).Running {
		t.Fatal("not running")
	}
	// A crash is restarted. Task Scheduler waits at least a minute before a restart, so Windows
	// checks only install, run and uninstall.
	switch runtime.GOOS {
	case "darwin":
		_, _ = Exec(ctx, "launchctl", "kill", "SIGKILL", "gui/"+strconv.Itoa(os.Getuid())+"/"+s.Label)
	case "linux":
		_, _ = Exec(ctx, "systemctl", "--user", "kill", "-s", "SIGKILL", s.Label+".service")
	}
	if runtime.GOOS != "windows" {
		time.Sleep(time.Second)
		waitHealthy(t, binary, port)
	}
	// An upgrade keeps data and settings: change a setting, put the next build in place,
	// restart as the packages do, and check the new version still has it.
	if next := os.Getenv("MABARI_BINARY_NEXT"); next != "" {
		base := "http://127.0.0.1:" + port
		request, _ := http.NewRequest(http.MethodPatch, base+"/api/settings", strings.NewReader(`{"retentionDays":90}`))
		request.Header.Set("Content-Type", "application/json")
		if response, err := http.DefaultClient.Do(request); err != nil || response.StatusCode != http.StatusOK {
			t.Fatalf("settings: %v %v", response, err)
		}
		before := version(t, base)
		copyFile(t, next, installed)
		if err := s.Restart(ctx); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(20 * time.Second)
		for now := version(t, base); (now == "" || now == before) && time.Now().Before(deadline); now = version(t, base) {
			time.Sleep(300 * time.Millisecond)
		}
		if after := version(t, base); after == before {
			t.Fatalf("still on %s after the upgrade", before)
		}
		response, err := http.Get(base + "/api/settings")
		if err != nil {
			t.Fatal(err)
		}
		var settings struct {
			RetentionDays int `json:"retentionDays"`
		}
		_ = json.NewDecoder(response.Body).Decode(&settings)
		_ = response.Body.Close()
		if settings.RetentionDays != 90 {
			t.Errorf("the setting was lost: %d", settings.RetentionDays)
		}
	}
	if err := s.Disable(ctx, true); err != nil {
		t.Fatal(err)
	}
	if s.Status(ctx).Installed {
		t.Error("still installed")
	}
	if runtime.GOOS != "linux" {
		if _, err := os.Stat(s.LogPath()); err != nil {
			t.Errorf("no log file: %v", err)
		}
	}
}

func writeKey(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "key")
	if err := os.WriteFile(path, []byte("service-test-only-master-key-0123456789abcdef"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func waitHealthy(t *testing.T, binary, port string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		cmd := exec.Command(binary, "healthcheck", "--port", port) // #nosec G204 -- test binary
		if cmd.Run() == nil {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatal("Mabari never answered")
}

// copyFile writes src to dst through a rename, so a running binary is replaced, not changed.
func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	content, err := os.ReadFile(src) // #nosec G304 -- test input
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst+".new", content, 0o700); err != nil { // #nosec G306 -- an executable
		t.Fatal(err)
	}
	if err := os.Rename(dst+".new", dst); err != nil {
		t.Fatal(err)
	}
}

// version asks Mabari which version is answering, or "" if none is.
func version(t *testing.T, base string) string {
	t.Helper()
	response, err := http.Get(base + "/api/health")
	if err != nil {
		return ""
	}
	defer func() { _ = response.Body.Close() }()
	var health struct {
		Version string `json:"version"`
	}
	_ = json.NewDecoder(response.Body).Decode(&health)
	return health.Version
}
