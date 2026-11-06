// SPDX-License-Identifier: Apache-2.0

package server

import (
	"net/http"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/timeline"
)

// timelineRoute is one day of the office, for the Activity page. day is a date such as 2026-11-06
// in this computer's own time zone, and today when it is left out.
func (a *api) timelineRoute(w http.ResponseWriter, r *http.Request) {
	var result models.Timeline
	var problem string
	var failure error
	err := a.engine.Do(func() {
		now := a.engine.Now()
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		if day := r.URL.Query().Get("day"); day != "" {
			parsed, err := time.ParseInLocation(timeline.DayFormat, day, now.Location())
			if err != nil {
				problem = "day is a date such as " + now.Format(timeline.DayFormat)
				return
			}
			start = parsed
		}
		result, failure = timeline.Of(r.Context(), a.engine.Store(), a.engine.Agents(), start, now)
	})
	switch {
	case err != nil:
		internalError(w, err)
	case problem != "":
		writeError(w, http.StatusBadRequest, problem)
	case failure != nil:
		internalError(w, failure)
	default:
		writeJSON(w, http.StatusOK, result)
	}
}
