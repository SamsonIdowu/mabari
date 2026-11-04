// SPDX-License-Identifier: Apache-2.0

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func get(t *testing.T, handler http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder
}

func TestHealth(t *testing.T) {
	response := get(t, New("1.2.3", nil), "/api/health")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var body struct {
		OK      bool   `json:"ok"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Version != "1.2.3" {
		t.Errorf("body = %+v", body)
	}
}

func TestUnknownAPIRouteIsJSON404(t *testing.T) {
	response := get(t, New("x", nil), "/api/nope")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
}

func TestHealthRejectsOtherMethods(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/health", nil)
	New("x", nil).ServeHTTP(recorder, request)
	if recorder.Code == http.StatusOK {
		t.Errorf("POST /api/health = %d", recorder.Code)
	}
}

func TestServesTheWebAppWhenEmbedded(t *testing.T) {
	files := fstest.MapFS{"index.html": {Data: []byte("<title>Mabari</title>")}}
	response := get(t, New("x", files), "/")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Mabari") {
		t.Errorf("status = %d, body = %q", response.Code, response.Body.String())
	}
}

func TestNoWebAppInDevelopment(t *testing.T) {
	if response := get(t, New("x", nil), "/"); response.Code != http.StatusNotFound {
		t.Errorf("status = %d", response.Code)
	}
}
