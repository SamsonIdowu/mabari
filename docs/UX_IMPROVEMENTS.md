# UX improvements, round 1 (2026-11-05)

Four testers drove a real browser through Mabari at commit `f5b28a2`, each on its own throwaway server: a newcomer (`FIRST`), a daily user (`DAILY`), someone connecting real tools and hitting failures (`SETUP`), and an accessibility and fidelity pass (`A11Y`). They reported 52 findings. This document is the checked, de-duplicated result and the spec for fixing them.

Finding ids are kept from the testers' reports so each fix traces back. Every item below was read against the code and the prototype. Where that changed a finding, the item says so.

**Status key:** `open`, `done`, or `no change` with a reason. The tracker at the end is the record.

## Decisions made in this round

Where the testers' expected result conflicted with the prototype, or the prototype conflicted with itself, this is the ruling. Build to these.

1. **One meaning of "need you".** An agent needs you when it is waiting for something only you can give: `approval`, `error`, or an open question. A queued instruction is a wait, not a request, so it does not count. The prototype counts it on the floor (lines 1225, 2188, 2711) but not on Home (line 1893), so copying it can't give one number.
   - Badge, Home, Mabari's answers, floor header, `Needs me` tab and the `NEEDS YOU` group all use this one definition and always agree.
   - Queued agents keep their amber treatment, get their own amber `Queued` group in the floor list, and add ` · 1 queued` to the floor header.
   - The rail badge counts everything that needs you, and uses `needsTone`: red when any approval or error is waiting, calm when only questions are. This keeps "only approvals and errors are red" (commit `43d4104`).
2. **`live` badge and question chips (A11Y-12).** Both match the prototype and break rule 6. Rule 6 wins, following the direction of the last three commits: the `live` badge becomes neutral, and question chips become outlined rather than solid. Say so in the commit message so it is easy to reverse.
3. **Clicking an agent waiting on approval still opens the approval dialog.** That is the prototype (line 3278). Only the second half of FIRST-14 stands.
4. **Instructions to a working agent still land within about two seconds.** That is decision 39. Only agents that can't act, because they wait on you, queue. See FIRST-2.
5. **The status answer keeps its limit of six agents** (prototype line 1963) and gains "and N more". See FIRST-9.
6. **API keys don't run agents yet** (decision 30). This round makes the app say so; it doesn't add the feature.

## Rules for every fix

- `CLAUDE.md` applies in full: match the prototype unless a decision here says otherwise, keep prototype class names, keep the UI calm, compute server-owned numbers in Go, start new source files with the SPDX line, and run `make gen` rather than editing generated files.
- Each item needs a test: a unit test for logic, an API test for server behaviour, a Playwright test for a user flow. The test must fail without the fix.
- Commits are small, with clear messages and no co-author or generated-by lines. Do not push.
- Never touch port 4317 or 4327, `~/.claude`, `~/.codex` or the keychain. Those are the user's real office.
- Do not break anything in [Keep as it is](#keep-as-it-is).

## Work package A: Mabari tells the truth

Owner: backend. Files: `internal/vee`, `internal/models`, `internal/connectors/simulator`, `internal/planner`.

| ID | Sev | Problem | Required change | Done when |
|---|---|---|---|---|
| FIRST-1 | high | "how is everything going?", "how are things going?" and "how's it going" get "I'm not sure what to do with that… ask me how things are going". | Add those to the overall status topic at `vee.go:303`. Reword the fallback so it can never suggest a phrase that fails. | All three answer with the status. A test sends every phrase the fallback suggests and each is understood. |
| FIRST-2 | high | An instruction to an agent paused on an approval is answered "Got it" within 0.4 s (`simulator.go:803`), while the agent is "Paused until you decide". | An agent waiting on approval or a question can't read instructions, so it queues them: amber card, "Waiting for its next checkpoint", delivered once unblocked. The Done case in the report is not a defect, because `Instruct` starts a new task. Confirm in a test that the agent really leaves Done. Check real connectors don't report delivery early either. | The instruction shows queued while Atlas waits, and is delivered after Allow. |
| FIRST-3 | medium | `Ack()` at `logic.go:231` makes "I'll please check…", "I'll after this step…", "I'll we need tests…". | Use the "I'll …" form only when the text starts with a plain verb. Otherwise use a form that can't garble, such as `Got it: <text>`. Keep the 60 character rule and rune counting. Do not make a model call. | A table test covers those three inputs plus a non-English one. |
| FIRST-7 | medium | Blank filenames: "touches . Over to you", "change to ?". `baseName("test/")` returns "" and `demo.go:46` lists a folder. | Handle the trailing slash, and never build a sentence around an empty name. | No demo message has an empty file slot, checked by a test over all demo files and message templates. |
| FIRST-8 | medium | Demo estimates fall about 5 times faster than the clock (`~17m` to `~8m` in 90 s) and "done around" jumps by 20 minutes in a minute. | Find why progress and `Rate` disagree in the demo, and make a demo minute a real minute. `done around` must not move by more than a small amount between ticks without a state change. Never change estimates for real agents. | A test advances a simulated clock and shows the ETA falls at about 1 s per second. |
| FIRST-9 | medium | "Atlas (Claude) is needs approval", "Mori (Custom AI) is error"; "7 of 10 working" with 6 listed. | Map states to phrases: "is waiting for your approval", "hit an error". Add "and N more" when the list is cut (decision 5 above). | Every state has a phrase, enforced by a test. Count and list reconcile. |
| FIRST-11 | medium | The demo never produces a question, so the question journey can't be seen or learned. | Have a demo agent ask a question with options, following the real question shape, and carry on once answered. | A Playwright test answers a demo question in the panel. |
| SETUP-9 (reply) | low | "There's no agent free to take that yet. Start one first." doesn't say how. | The reply names Accounts and how to start. The UI half is in package B. | A test covers the reply. |
| SETUP-11 | low | The planner drops accents and non-Latin letters: "Café ordering für Zürich app" becomes "Caf Ordering F". | Use `unicode.IsLetter`. Fall back to a clean default only when no letters remain. | A test covers accented and CJK input. |
| DAILY-8 | low | Auto project names read as clipped phrases: "Internal Dashboard Shows", "Competitors Report Their". | Drop leading verbs and don't end on a stop word or verb. Same for the "Plan …" lead task. | A table test covers the two examples. |
| NEW-1 | low | One tester saw the demo end after 10 minutes and another after about 20. | Confirm the real length and that the banner states it truthfully. | Banner and timer agree, by test. |

## Work package B: Connecting and settings

Owner: web and server. Files: `Accounts.tsx`, `Settings.tsx`, `NewAgentDialog.tsx`, `Welcome.tsx`, `Home.tsx` empty state, `internal/connectors/claudecode`, `internal/server`.

| ID | Sev | Problem | Required change | Done when |
|---|---|---|---|---|
| SETUP-6 | **high** (raised from medium) | `isOurs` (`claudecode/settings.go:283`) only accepts a binary named exactly `mabari`, and **the user's login service runs `bin/mabari-run`**. After attaching, `attached` is false, the card says Connected yet shows a 245 line "will be added" diff, a Wipe leaves all 11 hooks in `settings.json`, and later attaches may stack up. | Recognise a handler by `args[0] == "hook"` plus either the configured binary path or a base name starting with `mabari`. Stale hooks written by an older path must be replaced, not duplicated. Show the run command above the diff, and hide the diff once attached. | Attach, reattach and wipe tests pass with a binary named `mabari-run`. A wipe removes every hook and restores the backup. Test against a scratch `CLAUDE_CONFIG_DIR` only. |
| SETUP-1 | high | New agent ignores Settings: it looks up `defaults['claude_code']`, but keys are `claude`, `codex`, `anthropic`, `openai` (`NewAgentDialog.tsx:146`). It then sends the first and priciest model. | Map account kind to settings key in one place. | Set Haiku in Settings, and the dialog shows and sends Haiku. |
| SETUP-2 | high | Following Welcome's "or add an API key" ends at "Connect ChatGPT or add an API key first", which is untrue with a key saved. | Say plainly on the key cards, the dialog and the empty office that agents can't run on API keys yet, and what to do instead. Change Welcome so it doesn't promise otherwise. | With only a key saved, every message is true and gives a next step. |
| SETUP-3 | high | With Claude Code attached, New agent can only ever fail, and only after the form is filled in (409). | Expose whether an account can start agents from the server. When it can't, show the terminal instruction with the command up front instead of the form. | No path lets a user fill in a form that can't succeed. |
| SETUP-4 | high | Settings selects show values that aren't stored: query model shows `claude-opus-4-1` while `gpt-5-mini` is stored; the Anthropic default shows `claude-opus-5-5` while `claude-sonnet-4-5` is stored; the hub placeholder "any model your app reports" appears as a model. | Exclude the hub from `connectedModels`. Make each default a member of its account's list (`logic.go:86`). When a stored value isn't valid, correct it on the server and say so; never display a different value from the one in use. | A test checks every default is valid, and a select always shows the stored value. |
| SETUP-5 | medium | With the Codex CLI missing, the card says nothing. The only hint is a four second toast. | Show on the card that the CLI is missing, with the install step and restart note, following the Whisper card's pattern. Disable or relabel the button. | The message stays on the card. |
| SETUP-8, FIRST-10 | medium | Demo accounts look real on Accounts and Settings: "Signed in as you@example.com", Connected, and "will be added". | Add a `demo` flag to the snapshot, a Demo marker on any screen showing demo state, and past tense once attached. | Accounts in the demo is clearly marked. |
| SETUP-9 (UI) | low | Home on a fresh install has no action to connect an account. | Add `Connect an account` to Home's empty state, using the Agents page's control. | Playwright clicks it from a fresh start. |
| SETUP-10 | low | A bad API key gets only a toast. The key is never verified, yet shows "Saved". | Inline error on the field, a hint of the expected shape, and wording that says a saved key wasn't checked. | The error stays beside the field. |
| SETUP-12 | low | Settings changes show no confirmation. The hub token has no Copy button; replace and revoke are one click with no warning. The wipe confirm doesn't list what goes, and "all data" keeps settings. | Quiet "Saved" cue. Copy button. Warning on replace and revoke. Wipe lists what goes and what stays, and the wording matches what actually happens. | Each is covered by a test. |
| DAILY-7 | low | New agent defaults Project to the first project, silently misfiling agents. The name error appears at the bottom, far from the field. | Default to the office's current project filter, or no project. Show the error on Name and focus it. | Both covered by tests. |

## Work package C: Accessibility foundations

Owner: web. Files: new shared modal helper, every dialog's shell, `ThemeButton.tsx`, `Shell.tsx`, `Rail.tsx`, `FloorList.tsx`, tokens.

| ID | Sev | Problem | Required change | Done when |
|---|---|---|---|---|
| A11Y-1, 2, 3 | high | Dialogs say `aria-modal="true"` but Tab walks out of them, and the page behind stays live. Auto approve never takes focus at all. On close, focus falls to `<body>`. | One shared helper used by all dialogs (`Approvals.tsx`, `NewProjectDialog.tsx`, `ProjectDialog.tsx`, `Builder.tsx`, `AgentDialogs.tsx`, `NewAgentDialog.tsx`, `DeskDialog.tsx`): moves focus in, traps Tab and Shift+Tab, makes the page behind `inert`, and restores focus to the opener. Also restore focus after `Close panel`. | A Playwright test loops over every dialog and checks all three. `web/e2e/a11y.spec.ts` keeps passing. |
| A11Y-6 | medium | A new approval is silent for screen readers. `aria-label` sits on a plain `div`. | Add a polite live summary, such as "1 approval waiting: Atlas, npm run db:migrate", and give the board a real role. | Asserted in a test. |
| A11Y-7 | medium | White on red badges measure 3.36:1 in the dark theme at 9 to 11 px; the light theme `.pws` tick measures 4.39:1. | Change the tokens, following decision 36, then run `make gen`. Record the change next to decision 36. | The contrast check in `a11y.spec.ts` covers badges. |
| A11Y-9 | low | Minimise is 14 by 16 px and switches 33 by 19 px. | Grow hit areas to at least 24 by 24 px without changing how they look. | Measured in a test. |
| A11Y-10 | low | The page title never changes. The theme button is named after the opposite state. | Set `document.title` per route, such as "Agents · Mabari". Name the button "Switch to dark theme". | Covered by tests, updating any that assert the old name. |
| A11Y-11 | low | The floor list is one tab stop, and nothing explains its arrow keys. | Give it a proper composite role or a description. The list is the only keyboard path to an agent. | Announced in the aria snapshot. |
| A11Y-12 | low | See decision 2. | Neutral `live` badge, outlined question chips. | Contrast still passes. |
| DAILY-1 | medium | The collapsed rail hides the badges, because `shell.css:77` beats the rules that position them. Everyone below 1180 px gets no signal. | Remove `.badge` from that selector and check its position. | Badge visible at 1100 px. |
| NEW-2 | medium | Holding Space on Home's "Hold to talk" crashed headless Chromium once. Probably the headless speech API, but unproven. | Reproduce. Make sure a speech failure can't take down the page and that the user sees a clear message. If it can't be reproduced outside headless, write down what was tried. | Result recorded in the commit message. |

## Work package D: The office floor

Owner: web. Files: `Office.tsx`, `OfficeWall.tsx`, `FloorList.tsx`, `AgentPanel.tsx`, `web/src/office/*`, `Rail.tsx` count, `screens.css`.

| ID | Sev | Problem | Required change | Done when |
|---|---|---|---|---|
| FIRST-4, DAILY-2 | medium | "Need you" reads 3 on the floor and 2 on Home and the badge. | Decision 1. One shared selector. | A test reads every place with an approval, a question and a queued instruction present, and they agree. |
| FIRST-5 | medium | "Done" rows sit under WORKING, and the list count can be one above the header. | Group by the server's `working` flag. Done agents get their own group. | Header and group counts agree in a test. |
| DAILY-5, A11Y-8c | medium | The approval stack covers "Test coverage" and "Landing page". | Move the stack so project cards stay readable and clickable at 1280 and 1440 px, with one or two approvals waiting. | Asserted by bounding boxes in a test. |
| DAILY-4 | medium | Starting a project filters the whole office to it, hiding other agents and pending approvals. | Leave the filter alone, and keep the "started" toast. | Filter unchanged after a start. |
| DAILY-6 | medium | No visible way to add an agent from the office: only an unmarked free desk that moves. | Add `New agent` next to `New project`, using the existing dialog opener. | Playwright opens it from the header. |
| A11Y-5 | high | At 720x450 (200% zoom) and 390x844 the Agents page doesn't scroll. The floor's bottom, its toolbar and project cards are unreachable. | Let the page scroll, or fold the header and banner, so the whole floor and its controls are reachable with a floor minimum of about 360 px. No change at normal desktop sizes. | Test reaches the toolbar at both sizes. |
| A11Y-8a, b, DAILY-10 | medium | Speech bubbles collide with each other and with name tags. Bubbles break mid-word ("Bringin / g in a"). Projects cards cut a row in half with no "more" cue. Landing page says 3 agents on Projects and 0 in the office Project menu. | Stop mid-word breaks. Keep name tags readable when bubbles collide, using truncation or a limit per row. Add a "+n more" cue. Reconcile or relabel the counts. | Visual check at 10 and 19 agents, plus tests for what can be asserted. |
| DAILY-11 | low | The Colour key is a hidden scroll area, and still describes dashed curves and envelopes that decision 37 replaced with chips. | Show that it scrolls or make it fit, and describe the chips. Also update it for decision 1. | Text matches the floor. |
| FIRST-6 | low | Interrupt and Stop remain on a Done agent. | Hide or disable them when there's nothing to stop. Check what the prototype does first, and keep any path that restarts or removes the agent. | Covered by a test. |
| FIRST-14 (part) | low | "Any free agent" in the project question looks like plain text, not a chip. | Style it as the other choices are. Dialog behaviour stays (decision 3). | Visual check. |

## Work package E: Home, navigation and the rest

Owner: web. Files: `Home.tsx`, `HomeDock.tsx`, `calm.css`, `useHashRoute.ts`, `uiStore.ts`, `data/api.ts`, `Activity.tsx`, `ProjectChat.tsx`, toasts, `StatusScreens.tsx`.

| ID | Sev | Problem | Required change | Done when |
|---|---|---|---|---|
| A11Y-4 | high | Mabari's long reply covers the text box, Send and the dock. A click on Send hits the bubble. At 390x844 the bubble is 1290 px tall, clipped and can't be scrolled. | Keep the bubble clear of the controls and let it scroll within a maximum height (`calm.css:321`). | `elementFromPoint` on Send returns Send at 1440, 1024 and 390 px, and the whole reply can be read. |
| SETUP-7 | medium | Failures say the browser's raw "Failed to fetch", and the Home box is cleared. | Catch it once in `data/api.ts`: "Can't reach Mabari. Your change was not saved." Say that an approval was not sent. Restore typed text in the Home box on failure. | Playwright aborts `/api` and checks the wording and the box. |
| DAILY-3 | medium | Filters, the selected agent, the project chat and tabs are lost on reload, and nothing can be linked. | Keep office filters across reloads. Put selected agent and project chat in the hash, such as `#office?agent=…`, so Back closes them and links work. Keep bare hashes working, and don't lose the filters that already survive switching screens. | Reload keeps each one, and a link opens the agent. |
| FIRST-13 | low | "On it, sent to Ledger (Claude). <Reason>" is overwritten in under a second, and earlier messages vanish. | Keep the acknowledgement visible with the reply, and keep recent exchanges readable, within the prototype's layout. | Both visible at once after a send. |
| FIRST-12 | low | Toasts cover the composer and repeat each other ("Sent to Bolt", "Bolt replied"). | Keep toasts clear of the panel composer. Drop the duplicate. | No overlap, by bounding boxes. |
| DAILY-9, FIRST-14 (part) | low | Times are 12 hour in chat and replies, and 24 hour elsewhere. | Use the shared formatter from `format.ts` in `ProjectChat.tsx:24`, `AgentPanel.tsx:58` and `OfficeWall.tsx:138,286`. | A test checks no `toLocaleTimeString` remains in screens. |
| DAILY-12 | low | The Activity type filter has no Session or Errors option, though most rows are Session. There's no agent filter. | Offer every type that appears, plus an agent filter. | Covered by a test. |
| DAILY-13 | low | The Library title is about 40 px at y=105; other screens are about 32 px at y=94. | Same title style as other screens. | Measured in a test. |
| SETUP-13 | low | An empty Activity log says "Nothing matches" on a fresh install. | "Nothing has happened yet" when no filter is set. | Covered by a test. |

## Keep as it is

The testers confirmed these work. Fixes must not regress them.

- Welcome's copy and buttons; the demo opening straight onto the floor; the demo banner.
- Allow and Deny feedback; auto approve's amber state; the Sage queued card and its Remove button.
- "fix it" getting a project choice instead of a guess; query answers marked "Answered from the log" with sources.
- Reduced motion, including the canvas walking; focus rings on every stop; accessible names on every control; landmarks; no horizontal scroll at any tested size.
- Rail collapse below 1180 px; fast screen switching; Back and Forward; existing hash deep links; filters surviving screen changes; zoom shortcuts.
- Offline chip with recovery in about 10 s without a reload; approvals staying pending when a decision can't be sent; Settings reverting on a failed save.
- Folder checks in New project; the two-step wipe; tokens shown once; key fields as password fields.

## Tracker

| Package | IDs | Status |
|---|---|---|
| A | FIRST-1, 2, 3, 7, 8, 9, 11; SETUP-9 (reply), SETUP-11; DAILY-8; NEW-1 | open |
| B | SETUP-1, 2, 3, 4, 5, 6, 8, 9 (UI), 10, 12; FIRST-10; DAILY-7 | open |
| C | A11Y-1, 2, 3, 6, 7, 9, 10, 11, 12; DAILY-1; NEW-2 | open |
| D | FIRST-4, 5, 6, 14 (chip); DAILY-2, 4, 5, 6, 10, 11; A11Y-5, 8 | open |
| E | A11Y-4; SETUP-7, 13; DAILY-3, 9, 12, 13; FIRST-12, 13, 14 (times) | open |
