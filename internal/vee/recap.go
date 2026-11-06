// SPDX-License-Identifier: Apache-2.0

package vee

import (
	"strconv"
	"strings"
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// RecapWindow is how far back "what did I miss?" looks when the page doesn't say when the person
// last looked.
const RecapWindow = time.Hour

// recap answers "what did I miss?" and "catch me up" from the log and the office, with no model.
func (o view) recap(in Office, now time.Time) Reply {
	if in.Recap == nil {
		return o.reply("I can't look back over the log from here.", "shrug", KindPlain)
	}
	until := now.UnixMilli()
	since := in.Since
	if since <= 0 || since > until {
		since = until - RecapWindow.Milliseconds()
	}
	found, err := in.Recap(since, until)
	if err != nil {
		return o.reply("I couldn't read the log just now. Try again in a moment.", "shrug", KindPlain)
	}
	gesture := "nod"
	if found.Needs.Count > 0 {
		gesture = "point"
	}
	reply := o.reply(RecapText(found), gesture, KindRecap)
	reply.Recap = &found
	return reply
}

func plural(count int, one, many string) string {
	if count == 1 {
		return "1 " + one
	}
	return strconv.Itoa(count) + " " + many
}

// RecapText says in a sentence or two what a recap holds, as Mabari tells it: the period, then
// what finished, what auto approve settled, the errors, and what needs the person now. It names
// no agent and no command, so it is safe to read aloud.
func RecapText(r models.Recap) string {
	seconds := (r.Until - r.Since) / 1000
	since := time.UnixMilli(r.Since).Format("15:04")
	period := since + " (" + models.MinsText(seconds) + " ago)"
	var parts []string
	if n := r.Finished.Count; n > 0 {
		parts = append(parts, plural(n, "task finished", "tasks finished"))
	}
	if n := r.AutoApproved.Count; n > 0 {
		parts = append(parts, plural(n, "approval was auto-approved", "approvals were auto-approved"))
	}
	if n := r.Errors.Count; n > 0 {
		parts = append(parts, plural(n, "error", "errors"))
	}
	needs := ""
	if n := r.Needs.Count; n == 1 {
		needs = "1 thing needs you now"
	} else if n > 1 {
		needs = strconv.Itoa(n) + " things need you now"
	}
	switch {
	case len(parts) > 0 && needs != "":
		return "Since " + period + ": " + joined(parts) + ". " + capital(needs) + "."
	case len(parts) > 0:
		return "Since " + period + ": " + joined(parts) + ". Nothing needs you now."
	case needs != "" && r.Happened:
		return "Since " + period + ": " + needs + "."
	case needs != "":
		return "Nothing new since " + period + ", but " + needs + "."
	default:
		return "Nothing has happened since " + period + ", and nothing needs you."
	}
}

func joined(parts []string) string {
	if len(parts) < 2 {
		return strings.Join(parts, "")
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
}

func capital(text string) string {
	if text == "" {
		return text
	}
	return strings.ToUpper(text[:1]) + text[1:]
}
