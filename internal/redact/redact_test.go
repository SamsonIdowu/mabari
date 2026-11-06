// SPDX-License-Identifier: Apache-2.0

package redact

import (
	"strings"
	"testing"
)

func TestText(t *testing.T) {
	secrets := []string{
		"sk-ant-api03-abcdefghijklmnop", "sk-proj-abcdefghijklmnopqrstuv", "mab_abcdefghijkl",
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

func TestHarderShapes(t *testing.T) {
	tests := map[string]string{
		`password="two words here"`:             `password="[redacted]"`,
		`{"token": "a\"b c d"}`:                 `{"token": "[redacted]"}`,
		"mysql --password hunter22 -h db":       "mysql --password [redacted] -h db",
		"tool --api-key 'abc def'":              "tool --api-key '[redacted]'",
		"PASSPHRASE=hunter22":                   "PASSPHRASE=[redacted]",
		"PWD=hunter22":                          "PWD=[redacted]",
		"private_key: abcd1234":                 "private_key: [redacted]",
		"Cookie: session=abc; other=def":        "Cookie: [redacted]",
		"set-cookie: session=abc; Path=/":       "set-cookie: [redacted]",
		"Authorization: abcdefgh":               "Authorization: [redacted]",
		"https://me:p@ss/word@db.local/app":     "https://me:[redacted]@db.local/app",
		"https://:hunter2@db.local/app":         "https://:[redacted]@db.local/app",
		"https://abcdefghijklmnop@github.com/x": "https://[redacted]@github.com/x",
	}
	for text, want := range tests {
		if got := Text(text); got != want {
			t.Errorf("%q: got %q", text, got)
		}
	}
}

func TestUnterminatedQuotes(t *testing.T) {
	for _, text := range []string{`password="hunter22 is cut off`, `--token "abcd efgh`, `secret='abcd efgh`} {
		got := Text(text + "\nnext line")
		if strings.Contains(got, "hunter22") || strings.Contains(got, "abcd") || !strings.Contains(got, "next line") {
			t.Errorf("%q: got %q", text, got)
		}
	}
}

func TestPGPPrivateKeys(t *testing.T) {
	got := Text("-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----")
	if strings.Contains(got, "abc") {
		t.Errorf("got %q", got)
	}
}

func TestSecretKeysInJSON(t *testing.T) {
	got, _ := Value(map[string]any{
		"pwd": "x", "passphrase": "x", "cookie": "x", "tokens_in": 1200.0, "credentials": map[string]any{"a": "b"},
	}).(map[string]any)
	for _, key := range []string{"pwd", "passphrase", "cookie", "credentials"} {
		if got[key] != Mask {
			t.Errorf("%s = %v", key, got[key])
		}
	}
	if got["tokens_in"] != 1200.0 {
		t.Errorf("a count is not a secret: %v", got["tokens_in"])
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

// A card shows what is being approved, so masking must not take an argument with it.
func TestShapeKeepsWhatItMasks(t *testing.T) {
	got, _ := Shape(map[string]any{
		"token_options":                 map[string]any{"sql": "DROP TABLE users", "limit": 5.0, "nested": []any{"a"}, "on": true},
		"password":                      1234.0,
		"tokens_in":                     "API_KEY=abcd1234 go test",
		"note":                          "plain",
		"sk-ant-api03-aaaaaaaaaaaaaaaa": "first",
		"sk-ant-api03-bbbbbbbbbbbbbbbb": "second",
	}).(map[string]any)
	options, _ := got["token_options"].(map[string]any)
	nested, _ := options["nested"].([]any)
	if options["sql"] != Mask || options["limit"] != Mask || options["on"] != true || len(nested) != 1 || nested[0] != Mask {
		t.Errorf("options = %+v", options)
	}
	if got["password"] != Mask || got["note"] != "plain" {
		t.Errorf("got = %+v", got)
	}
	if got[Mask] != "first" || got[Mask+" (2)"] != "second" || len(got) != 6 {
		t.Errorf("keys = %+v", got)
	}
}

// In prose or a log line a cookie or an authorization is often written as JSON, with a quote
// between the name and its value.
func TestCookiesAndAuthorizationWrittenAsJSON(t *testing.T) {
	for _, text := range []string{
		`the request had {"cookie":"sessionvalue"} in it`,
		`"Cookie": "sessionvalue"`,
		`'set-cookie': 'sessionvalue'`,
		`cookie=sessionvalue`,
		`--cookie sessionvalue`,
		`{"authorization":"sessionvalue"}`,
		`"Authorization": "Bearer sessionvalue"`,
	} {
		if got := Text(text); strings.Contains(got, "sessionvalue") {
			t.Errorf("%q = %q", text, got)
		}
	}
	if got := Text(`{"cookie":"x"}`); got != `{"cookie":"`+Mask+`"}` {
		t.Errorf("a short value = %q", got)
	}
	for _, text := range []string{"we use cookies", "the cookie banner is broken"} {
		if got := Text(text); got != text {
			t.Errorf("%q = %q", text, got)
		}
	}
}
