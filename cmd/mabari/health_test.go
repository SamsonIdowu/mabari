// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckHealth(t *testing.T) {
	well := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true,"version":"1.2.3"}`))
	}))
	defer well.Close()
	if version, err := checkHealth(context.Background(), well.URL); err != nil || version != "1.2.3" {
		t.Errorf("well = %q %v", version, err)
	}
	ill := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer ill.Close()
	if _, err := checkHealth(context.Background(), ill.URL); err == nil {
		t.Error("an ill server passed")
	}
	if _, err := checkHealth(context.Background(), "http://127.0.0.1:1/api/health"); err == nil ||
		!strings.Contains(err.Error(), "nothing is answering") {
		t.Errorf("nothing listening: %v", err)
	}
}

func TestTailKeepsTheLastLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mabari.log")
	if err := os.WriteFile(path, []byte("one\ntwo\nthree\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	if err := tail(path, 2, &out); err != nil || out.String() != "two\nthree\n" {
		t.Errorf("tail = %q %v", out.String(), err)
	}
	out.Reset()
	if err := tail(path+".missing", 2, &out); err != nil || !strings.Contains(out.String(), "No log yet") {
		t.Errorf("missing = %q %v", out.String(), err)
	}
}

func TestServiceRefusesInsideDocker(t *testing.T) {
	t.Setenv("MABARI_IN_CONTAINER", "1")
	if err := runService([]string{"status"}, strings.NewReader(""), new(strings.Builder)); err == nil ||
		!strings.Contains(err.Error(), "Docker") {
		t.Errorf("err = %v", err)
	}
}
