// SPDX-License-Identifier: Apache-2.0

package redact

import (
	"strings"
	"testing"
)

func TestText(t *testing.T) {
	secrets := []string{
		"sk-ant-api03-abcdefghijklmnop", "sk-proj-abcdefghijklmnopqrstuv", "vju_abcdefghijkl",
		"ghp_abcdefghijklmnopqrstuvwx", "github_pat_11ABCDEFG0abcdefghijkl", "AKIAIOSFODNN7EXAMPLE",
		"xoxb-123456789-abcdefghij", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijkl",
	}
	for _, secret := range secrets {
		got := Text("before " + secret + " after")
		if strings.Contains(got, secret) || !strings.Contains(got, "before") || !strings.Contains(got, "after") {
			t.Errorf("%s: got %q", secret, got)
		}
	}
}

func TestAssignmentsKeepTheNameAndHideTheValue(t *testing.T) {
	tests := map[string]string{
		"API_KEY=abcd1234 npm test":                     "API_KEY=[redacted] npm test",
		`{"password": "hunter22"}`:                      `{"password": "[redacted]"}`,
		"export GITHUB_TOKEN=abcd1234":                  "export GITHUB_TOKEN=[redacted]",
		"curl -H 'Authorization: Bearer abcdefgh12345'": "curl -H 'Authorization: Bearer [redacted]'",
		"postgres://me:hunter2@db.local/app":            "postgres://me:[redacted]@db.local/app",
	}
	for text, want := range tests {
		if got := Text(text); got != want {
			t.Errorf("%q: got %q", text, got)
		}
	}
}

func TestPrivateKeys(t *testing.T) {
	got := Text("a\n-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----\nb")
	if strings.Contains(got, "abc") || !strings.HasPrefix(got, "a\n") || !strings.HasSuffix(got, "\nb") {
		t.Errorf("got %q", got)
	}
	if got := Text("-----BEGIN PRIVATE KEY-----\ncut off"); strings.Contains(got, "cut off") {
		t.Errorf("a cut off key must still go: %q", got)
	}
}

func TestOrdinaryTextIsLeftAlone(t *testing.T) {
	for _, text := range []string{
		"npm test", "src/token.ts", "Refactor the password reset page", "tokens in: 1200", "sk-short",
		"git commit -m \"fix token refresh\"",
	} {
		if got := Text(text); got != text {
			t.Errorf("%q changed to %q", text, got)
		}
	}
}

func TestValue(t *testing.T) {
	got, _ := Value(map[string]any{
		"command": "API_KEY=abcd1234 go test",
		"nested":  []any{map[string]any{"authorization": "anything", "count": 3.0}},
		"token":   "x",
	}).(map[string]any)
	if got["command"] != "API_KEY=[redacted] go test" || got["token"] != Mask {
		t.Errorf("got %+v", got)
	}
	nested, _ := got["nested"].([]any)[0].(map[string]any)
	if nested["authorization"] != Mask || nested["count"] != 3.0 {
		t.Errorf("nested = %+v", nested)
	}
}
