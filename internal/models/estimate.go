// SPDX-License-Identifier: Apache-2.0

package models

import (
	"math"
	"time"
)

// The likely range around the best guess, from the prototype's etaRange.
const (
	likelyLow  = 0.8
	likelyHigh = 1.3
)

// Estimate is the server's forecast of when work finishes. The browser only formats it.
type Estimate struct {
	SecondsLeft int64 `json:"secondsLeft"`
	LowSeconds  int64 `json:"lowSeconds"`
	HighSeconds int64 `json:"highSeconds"`
	// FinishAt is a Unix time in milliseconds.
	FinishAt int64 `json:"finishAt"`
}

// EstimateFor forecasts an agent's finish from its progress and rate (progress per second). It
// returns nil unless the agent is actively working, so an agent waiting on the user, stopped or
// done never counts towards when the work should finish.
func EstimateFor(state AgentState, progress, rate float64, now time.Time) *Estimate {
	if !state.Active() || rate <= 0 {
		return nil
	}
	seconds := (1 - min(progress, 1)) / rate
	return &Estimate{
		SecondsLeft: int64(math.Round(seconds)),
		LowSeconds:  int64(math.Round(seconds * likelyLow)),
		HighSeconds: int64(math.Round(seconds * likelyHigh)),
		FinishAt:    now.Add(time.Duration(seconds * float64(time.Second))).UnixMilli(),
	}
}

// RatePerSecond is the agent's progress per real second: Rate, in office seconds, scaled to the
// clock. For every real agent it is Rate itself.
func (a *LiveAgent) RatePerSecond() float64 {
	if a.RateScale > 0 {
		return a.Rate * a.RateScale
	}
	return a.Rate
}

// EstimateAt forecasts when the agent finishes, from now, in real seconds. See EstimateFor.
func (a *LiveAgent) EstimateAt(now time.Time) *Estimate {
	// An agent waiting on your answer isn't getting closer to done.
	if a.Asking() {
		return nil
	}
	return EstimateFor(a.State, a.Progress, a.RatePerSecond(), now)
}

// LatestFinish combines estimates for a team, a project or the whole office: the work is finished
// when the last agent is. Agents with no estimate are skipped, and it returns nil if none have one.
func LatestFinish(estimates ...*Estimate) *Estimate {
	var latest *Estimate
	for _, estimate := range estimates {
		if estimate == nil {
			continue
		}
		if latest == nil {
			copied := *estimate
			latest = &copied
			continue
		}
		latest.SecondsLeft = max(latest.SecondsLeft, estimate.SecondsLeft)
		latest.LowSeconds = max(latest.LowSeconds, estimate.LowSeconds)
		latest.HighSeconds = max(latest.HighSeconds, estimate.HighSeconds)
		latest.FinishAt = max(latest.FinishAt, estimate.FinishAt)
	}
	return latest
}
