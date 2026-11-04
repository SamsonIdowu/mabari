// SPDX-License-Identifier: Apache-2.0

package service

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"strings"
)

func escapeXML(value string) string {
	var out bytes.Buffer
	_ = xml.EscapeText(&out, []byte(value))
	return out.String()
}

// launchAgent is the macOS LaunchAgent. RunAtLoad starts it at login, and KeepAlive restarts it
// after a crash but not after a clean stop.
func launchAgent(label, binary, logPath string, env [][2]string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ` + Marker + `. Remove it with: mabari service uninstall -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + escapeXML(label) + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + escapeXML(binary) + `</string>
    <string>serve</string>
    <string>--log-file</string>
    <string>` + escapeXML(logPath) + `</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
`)
	for _, pair := range env {
		fmt.Fprintf(&b, "    <key>%s</key>\n    <string>%s</string>\n", escapeXML(pair[0]), escapeXML(pair[1]))
	}
	b.WriteString(`  </dict>
</dict>
</plist>
`)
	return b.String()
}

// quoteSystemd quotes one word for a systemd unit file: in double quotes, with \ and " escaped,
// and % doubled, because systemd expands % specifiers even inside quotes.
func quoteSystemd(value string) string {
	value = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%", "\n", " ").Replace(value)
	return `"` + value + `"`
}

// systemdUnit is the Linux systemd user unit. It restarts after a crash.
func systemdUnit(binary, logPath string, env [][2]string) string {
	var b strings.Builder
	b.WriteString("# " + Marker + ". Remove it with: mabari service uninstall\n")
	b.WriteString("[Unit]\nDescription=Mabari, your AI agents at work\n\n[Service]\n")
	b.WriteString("ExecStart=" + quoteSystemd(binary) + " serve --log-file " + quoteSystemd(logPath) + "\n")
	b.WriteString("Restart=on-failure\nRestartSec=5\n")
	for _, pair := range env {
		b.WriteString("Environment=" + quoteSystemd(pair[0]+"="+pair[1]) + "\n")
	}
	b.WriteString("\n[Install]\nWantedBy=default.target\n")
	return b.String()
}

// quoteWindows quotes one argument for a Windows command line.
func quoteWindows(value string) string {
	if value != "" && !strings.ContainsAny(value, " \t\"") {
		return value
	}
	return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
}

// windowsTask is a Task Scheduler task for this user only, so Mabari keeps the user's own
// Credential Manager and folders. It starts at logon and restarts after a failure.
func windowsTask(binary, logPath string, env [][2]string) string {
	// A task can't set environment variables, so the settings go on the command line as flags
	// where serve has one. PATH is inherited from the user's logon.
	args := []string{"serve", "--log-file", quoteWindows(logPath)}
	for _, pair := range env {
		switch pair[0] {
		case "MABARI_PORT":
			args = append(args, "--port", quoteWindows(pair[1]))
		case "MABARI_DATA_DIR":
			args = append(args, "--data-dir", quoteWindows(pair[1]))
		case "MABARI_LOG_LEVEL":
			args = append(args, "--log-level", quoteWindows(pair[1]))
		}
	}
	return `<?xml version="1.0" encoding="UTF-16"?>
<!-- ` + Marker + `. Remove it with: mabari service uninstall -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Mabari, your AI agents at work</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + escapeXML(binary) + `</Command>
      <Arguments>` + escapeXML(strings.Join(args, " ")) + `</Arguments>
    </Exec>
  </Actions>
</Task>
`
}
