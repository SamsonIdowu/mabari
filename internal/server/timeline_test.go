// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

func TestTimelineHasTheSameAccessChecks(t *testing.T) {
	guarded(t, "/api/timeline")
}

func TestTimelineRoute(t *testing.T) {
	o := newOffice(t)
	o.demo(t)
	today := o.engine.Now().Format("2006-01-02")
	got := decode[models.Timeline](t, o.do(t, http.MethodGet, "/api/timeline", ""))
	if got.Day != today || got.Start >= got.Now || got.Now >= got.End || got.End-got.Start < 23*3600*1000 {
		t.Errorf("day = %q, %d to %d, now %d", got.Day, got.Start, got.End, got.Now)
	}
	if len(got.Lanes) == 0 {
		t.Fatal("the demo has no lanes")
	}
	for _, lane := range got.Lanes {
		if lane.AgentID == "" || lane.Agent == "" || !lane.Present || lane.Blocks == nil || lane.Markers == nil {
			t.Errorf("lane = %+v", lane)
		}
	}
	// The same day asked for by its date is the same day.
	if named := decode[models.Timeline](t, o.do(t, http.MethodGet, "/api/timeline?day="+today, "")); named.Start != got.Start || named.End != got.End {
		t.Errorf("by date: %d to %d", named.Start, named.End)
	}
	// Yesterday is a day with nothing in it yet.
	yesterday := o.engine.Now().AddDate(0, 0, -1).Format("2006-01-02")
	if got := decode[models.Timeline](t, o.do(t, http.MethodGet, "/api/timeline?day="+yesterday, "")); got.Day != yesterday || len(got.Lanes) != 0 {
		t.Errorf("yesterday = %+v", got)
	}
	for _, day := range []string{"today", "2026-13-01", "06-11-2026", "2026-11-06T00:00", "x"} {
		if response := o.do(t, http.MethodGet, "/api/timeline?day="+url.QueryEscape(day), ""); response.Code != http.StatusBadRequest {
			t.Errorf("day=%s = %d", day, response.Code)
		}
	}
}
