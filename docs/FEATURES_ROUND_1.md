# Features round 1: Mabari is where you talk to your agents (2026-11-06)

**The goal: Mabari is where you talk to your agents.** Someone should prefer it to Claude Code in a terminal, VS Code or Claude Desktop for giving agents instructions, in chat and in project chat, because it does what they can't: many agents at once, in one place, visibly, with the state of the work always in view. It should also be a pleasure to open.

**The blocker today.** A real Claude Code session only hears Mabari at its next hook step, so an idle session can't receive an instruction, and a new one opens in a terminal window. Mabari is a remote control for the terminal rather than a place to work. Package 4 removes that, and everything in packages 5 and 6 builds on it.

None of this is in the prototype, so build it in its style: reuse its classes, tokens, cards, chips, dialogs and wording. Flat colour, no gradients, monochrome UI, provider colours only for providers. Delight comes from motion and character, never from a new way to shout.

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

### 2b. Then tell the next one

Watches can carry an instruction: "when Ledger is done, tell Quill to review it", or a `Then…` field beside the toggle. When it fires, the instruction goes to the named agent through the normal instruction path, so that agent's risky actions still need your click. No terminal can do this across agents.

- It shows as a pending chain on both agents' panels, can be cancelled, and is logged when it fires. If the agent ends in an error, the chain doesn't fire, and you are told. If the target has gone, say so; never send it to someone else.
- **Done when:** tests cover a firing chain, an error, a missing target, cancel and reload.

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

### 4b. Today's timeline

On Activity, a swimlane view of the day: one row per agent, with blocks for working, waiting on you, and error, a marker for each approval and instruction, and a line at now. It shows at a glance who worked when and where work sat waiting for you, which no terminal can show. Clicking a block opens that agent.

- Go computes it from stored events (`GET /api/timeline?day=`). The UI only draws it. Draw it with plain SVG or CSS, no chart library, and give it a text alternative for screen readers.
- **Done when:** an API test seeds transitions and checks the blocks, and Playwright checks it renders in the demo and a click opens the agent.

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

## Package 4: Mabari runs the session

The heart of this round. Today `internal/launch` opens a terminal. Mabari must be able to run a Claude Code session itself, with no terminal, and keep talking to it.

**Read first, and record versions in `docs/INTEGRATIONS.md` (rule 3).** Claude Code here is 2.1.318. Read `claude --help` and the official docs for headless use (`-p`, `--output-format stream-json`, `--input-format stream-json`, `--resume`, `--settings`, `--permission-prompt-tool`, `--model`, `--permission-mode`, `--agent`) and for how permission hooks behave without a terminal. Don't trust this document's list of flags.

- **Start from Mabari.** New agent and New project with Claude Code start a session in the folder as a child process, using the person's existing Claude Code login. `canStart` becomes true for Claude Code, so the "start it in your terminal" notes from SETUP-3 go away, and the terminal stays available as a choice.
- **Instructions always land.** An instruction to an idle Mabari-run session is delivered at once. An idle session started elsewhere, in a terminal or editor, can be continued with `--resume`, but only if it's safe: never drive a session that may still be open in a terminal without saying so. Keep today's behaviour for sessions that are mid-run.
- **Stream.** Assistant text, tool calls and results arrive live, per message, and are kept so a reload shows the whole conversation. For sessions started elsewhere, read the conversation from the `transcript_path` in hook input, read only. Add a stored message model and an API such as `GET /api/agents/{id}/conversation` with WebSocket updates. Package 5 draws it.
- **Approvals still need a click (rule 5).** Every risky action of a Mabari-run session reaches the approval flow, and with no answer, it is denied. Never use `--dangerously-skip-permissions`, never widen tool permissions, and if a route can't be proven to stop and wait, don't ship it. Prove this with a test. Auto approve works as it does for any agent.
- **Don't touch the real settings file.** Prefer passing hooks per process (`--settings`) over changing `~/.claude/settings.json`, so a session can run without attaching. Rule 5 applies if a file must change.
- **Lifecycle.** Stop, Interrupt and Continue work on the child process. On server restart, sessions show as resumable rather than lost. No orphan processes on shutdown. Cap concurrent sessions by a setting, and say so when the cap is reached. Output is size bounded.
- **Continue in terminal.** A button shows the exact `claude --resume <id>` command to copy, so nobody feels locked in.
- **Tests.** Use a fake `claude` script on `PATH` that speaks the same stream, recorded from the documented format. **Never run the real `claude` in tests or by hand**: it spends the user's account and uses their real config.
- **Done when:** with the fake binary, Playwright can start an agent with no terminal, send it instructions while idle, see it stream, approve an action, restart the server and carry on.

## Package 5: The conversation

Runs after package 4 is merged. The Chats screen becomes the place to work. It gets two tabs: **With you** (default) and **Between agents** (today's screen, unchanged). With you has a list of agents and projects on the left, ordered by who needs you, and the thread beside it. Links: `#conversations?agent=<id>` and `#conversations?project=<id>`. The panel gets an "Open chat" link.

- **Thread.** Streaming text, safe markdown (no raw HTML, links can't run script), code blocks with Copy, tool calls collapsed to one calm line with their state, expandable. Approvals and questions appear in the thread as you would answer them, using the existing components. A live "what it's doing now" line. Scrolls well with thousands of messages.
- **Project chat is the same thread**, addressed to the project: Mabari routes it, and each reply shows who answered. The current drawer opens this view or shares its code; don't keep two.
- **Composer**, one component shared by the thread and project chat:
  - Attach files by drop, paste or picker. Files are stored under Mabari's data folder and passed by path.
  - `@` completes files in the agent's folder, and `@agent` pulls in another agent's latest reply as context.
  - `/` lists the folder's and account's commands and skills, plus saved instructions, which you can create from any message you've sent. Unknown names go through unchanged.
  - Send now or queue for the next checkpoint, shown plainly.
  - A "Plan first" toggle, and a model picker where the session allows it.
  - Up arrow recalls earlier messages. Drafts survive switching threads and reload. Voice uses the existing mic.
- **Things only Mabari can do.** On any reply: **Hand to…** sends it to another agent with context. **Ask everyone** sends one message to all agents on a project and shows replies side by side.
- **Done when:** Playwright covers streaming, markdown safety with a hostile message, each composer feature, project chat, Hand to…, Ask everyone, reload, and an accessibility pass in both themes at 1440, 1024 and 390 px.

## Package 6: Review the work

The thing a terminal does worst: seeing what an agent changed. **Changes** in the agent panel and on project cards opens a review view.

- Go runs read-only `git` (`status`, `diff`) with argument lists, never a shell, only in a folder Mabari already knows for that agent or project. The API takes an agent or project id, never a path. It caps output, handles binary files, renamed files and folders that aren't repositories, and goes through `internal/redact`. It offers no commit, push, checkout or discard.
- A file list with added and removed counts, and diffs in the prototype's diff style. Live while the agent works.
- **Comment on a line**: the comment becomes an instruction to that agent, with file and line. Several comments can go as one review.
- **Second opinion**: one button sends the diff to a chosen agent to review, and shows its reply in the thread.
- **Done when:** Go tests use a real temp repository, including hostile file names and a folder outside the project, and Playwright covers viewing, commenting and second opinion.

## Package 7: A place worth opening

Make it exciting, and keep it working. All of it respects reduced motion, none of it blocks a control, and none of it plays over an approval.

- **Ship it.** When a project completes, its agents walk to the meeting room, a short pixel confetti burst and "Shipped" show once, and a chime plays if sounds are on. It never replays on reload.
- **Trophy shelf.** Each completed project adds a small item to a shelf in the office, in its colour. Click it for the project's summary. The office visibly fills up with what you've finished.
- **Small moments.** An agent finishing a task gets a tick and a little hop. New agents wave as they walk in. Agents waiting on you glance at the camera. Agents in the lounge do different idle things. Keep them cheap: the floor must stay at 60 fps with 16 busy agents.
- **Agent cards.** Hovering an agent's name shows a small trading card: portrait, role, tasks finished today, time worked, estimated cost. Numbers come from Go.
- **Office sound.** Optional and off by default: a soft room tone with key taps, made with Web Audio and no files, that rises with how many agents are working. Silence means nothing is running, so you can hear the state of the office. Its volume is in Settings.
- **Polish pass over every screen.** Cast the pixel characters in empty states. A consistent motion language for panels, dialogs, toasts and screen changes (short, eased, no layout jumps). Better hover and pressed states. Loading skeletons instead of blank pages. Tighten type and spacing where it's uneven.
- **Done when:** a test covers once-only celebration, reduced motion and the card numbers; `perf.spec.ts` stays at 60 fps; screenshots are read for every screen in both themes.

## Tracker

Status on 2026-11-06. Checked by independent testers in a browser, a code review and the full test suites, against the fake `claude`. The real `claude` has not been run. See `docs/INTEGRATIONS.md`.

| # | Feature | Status |
|---|---|---|
| 1 | Alerts outside the page | done |
| 2 | Tell me when it's done | done |
| 3 | While you were away | done |
| 4 | Export the log | done |
| 5 | Quick switcher | done |
| 6 | Pause everyone | done |
| 2b | Then tell the next one | done |
| 4b | Today's timeline | done |
| P4 | Mabari runs the session | done |
| P5 | The conversation | done |
| P6 | Review the work | done |
| P7 | A place worth opening | done |

Open: threads doubled before the fix stay doubled, and empty bubbles already stored stay, because nothing rewrites old threads. Activity rows written under Mabari, You or Everyone during a demo stay after it ends. Real desktop notifications, voice and the "No answer denies" path have not been tried against a real browser prompt, microphone or `claude`.
