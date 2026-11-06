// SPDX-License-Identifier: Apache-2.0

package server

import (
	"context"
	"net/http"
	"strconv"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/recap"
)

// recapOf works out the recap for a period, with the office as it is. Call inside Do.
func (a *api) recapOf(ctx context.Context, since, until int64) (models.Recap, error) {
	return recap.Of(ctx, a.engine.Store(), a.engine.Agents(), since, until)
}

// recapRoute is what happened from `since` (Unix milliseconds, when the person left) to `until`,
// which is now unless it is given.
func (a *api) recapRoute(w http.ResponseWriter, r *http.Request) {
	since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if err != nil || since <= 0 {
		writeError(w, http.StatusBadRequest, "since is when you left, in milliseconds since 1970")
		return
	}
	var result models.Recap
	var problem string
	var failure error
	err = a.engine.Do(func() {
		now := a.engine.Now().UnixMilli()
		until := positiveQuery(r, "until", now)
		// A period never reaches into the future, or back before it began.
		until = min(until, now)
		if since > until {
			problem = "since is after the end of the period"
			return
		}
		result, failure = a.recapOf(r.Context(), since, until)
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
