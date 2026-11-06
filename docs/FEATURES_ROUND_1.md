# Features round 1 (2026-11-06)

Mabari exists so that you can leave agents working and only look when it matters. The app is good once you are looking at it. These six features cover the time you aren't, and the moments when many agents need one decision.

None of them are in the prototype, so build them in its style: reuse its classes, tokens, cards, chips, dialogs and wording. Nothing here may add a new way to shout.

## Rules for every feature

- `CLAUDE.md` applies in full, including rule 5 (risky actions need a click) and rule 6 (only red and amber ask for attention).
- **Nothing here can approve anything.** No notification, shortcut, recap, switcher entry or Mabari reply may approve, deny, or turn on auto approve.
- Nothing leaves this computer. No outside services, no model calls. All of it works from local state.
- Text that reaches outside the page, such as a desktop notification or an export, carries no secrets. Notifications never contain commands or file contents, and exports go through `internal/redact`.
- Server-owned numbers are computed in Go. The UI only formats them.
- Every feature needs unit, API and Playwright tests, and must work in the demo office so it can be seen and tested.
- Keep what `docs/UX_IMPROVEMENTS.md` lists under "Keep as it is".

## Package 1: Know without looking

### 1. Alerts outside the page

- **Tab title.** When someone needs you, the title leads with the count: `(2) Agents · Mabari`, using the one "need you" definition (`needsYou`, decision 1 of `docs/UX_IMPROVEMENTS.md`).
- **Tab icon.** A small dot on the favicon when an approval or error waits, in the same red. No dot for questions, so rule 6 holds. Add a favicon if there isn't one, built from Vee's head.
- **Desktop notifications**, off by default. A switch in Settings, "Notify me when an approval or error needs me", asks the browser for permission only when turned on. If the browser refuses or can't do it (a LAN address isn't a secure context), the switch says why and stays off.
  - Fires only when the page is hidden, and only for a new approval or error. One per event, and two tabs must not double up (use `tag`).
  - Text: "Atlas needs your approval" or "Mori hit an error". No command, path or task text.
  - Clicking it focuses Mabari and opens that agent (`#office?agent=…`). It offers no action buttons.
- **Done when:** title and dot follow the count on every screen; a Playwright test with a stubbed `Notification` covers hidden and visible pages, denied permission, no repeat for the same approval, and the click.

### 2. Tell me when it's done

- A quiet "Tell me when it's done" toggle in the agent panel and on project cards, and a Mabari phrase: "tell me when Ledger is done", or "let me know when Checkout revamp finishes". The phrase must not be sent to the agent as an instruction, and must not break "tell Ledger to …".
- One-shot: it fires once when the agent reaches Done (or stops with an error, saying so), or when every agent on the project has finished, then clears itself. If the thing is already finished, Mabari says so.
- It tells you with a toast, a line in Home's chat, and a desktop notification when those are on. It should be calm: no red.
- Watches live on the server so they survive a reload, and are cleared when the agent leaves. Project and agent are shown as watched on the panel and card, and can be turned off.
- **Done when:** API and Playwright tests cover setting, firing once, turning off, reload, the error case, and the phrases.

## Package 2: Catch up

### 3. While you were away

- When you come back after at least 15 minutes and something happened, Home shows a calm card: "While you were away · 1 h 20 min". It lists tasks finished, approvals decided by auto approve, errors, and what needs you now, each with a link to the agent.
- Dismissible, and it stays dismissed for that absence. Nothing shows if nothing happened, or on a first visit.
- "What did I miss?" and "catch me up" get the same recap from Mabari, from local data, with no model call. Existing status phrases must keep working.
- Go builds it: `GET /api/recap?since=<ms>`, from the activity log and the office. If a fact isn't logged today, such as a finished task, log it rather than guessing. Include spend only if it can be computed truly for that period; otherwise leave it out.
- **Done when:** a Go test seeds a period and checks every line, Playwright fakes an absence, and the card is dismissible and absent when nothing happened.

### 4. Export the log

- `Export` on Activity offers CSV and JSON of what the current filters show, with a date in the filename.
- `GET /api/activity/export?format=csv|json` takes the same filters as `/api/activity`, has the same access checks, and goes through `internal/redact`.
- CSV cells starting with `=`, `+`, `-`, `@`, tab or carriage return must be neutralised, so a spreadsheet can't run them.
- **Done when:** API tests cover both formats, filters, a planted secret and a formula cell. Playwright downloads a file.

## Package 3: Command many at once

### 5. Quick switcher

- `Ctrl K` or `Cmd K` anywhere opens a search box. Type to jump to an agent, a project or a screen, or run a plain action: New agent, New project, Quiet mode, Switch theme.
- Agents show their name, state and project, with those needing you first. Enter opens it. Arrow keys move, Escape closes, and focus returns (use the shared `Modal`).
- It adds a route to nothing: results use the existing hash links. It must not fire while typing in a box that uses the key, and it must not disturb Space for push to talk.
- No risky actions: not approve, deny, auto approve, wipe, stop or pause.
- **Done when:** Playwright covers keyboard-only jumps to each kind of result, and the accessibility tree announces the result list and count. `a11y.spec.ts` covers the dialog.

### 6. Pause everyone

- `Pause everyone` in the office header pauses every working agent in the current view, using each connector's existing `Interrupt`. A confirmation names how many and which project.
- Afterwards the button is `Continue everyone`, which resumes only the agents this pause stopped, not ones you paused earlier by hand.
- `POST /api/agents/interrupt` and `/continue` take an explicit list of agent ids from the client. The server skips any agent not in a state that can be paused, and returns what it did. One log row for the group. A toast reports what happened, including any it could not pause.
- It must never settle an approval. Agents waiting on approval stay waiting. Check how each connector's `Interrupt` behaves, and say plainly in the confirmation if one can only ask (the hub queues "Please pause.").
- **Done when:** API tests cover the mix of states, skipped agents and resuming only the right ones. Playwright covers pause, a filter in place, and continue.

## Tracker

| # | Feature | Status |
|---|---|---|
| 1 | Alerts outside the page | open |
| 2 | Tell me when it's done | open |
| 3 | While you were away | open |
| 4 | Export the log | open |
| 5 | Quick switcher | open |
| 6 | Pause everyone | open |
