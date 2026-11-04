# Outside tools

The versions and facts each integration is built on. Check the official docs again before changing one.

| Tool | Version | Source | Facts relied on |
|---|---|---|---|
| Claude Code | 2.1.318 | code.claude.com/docs/en/hooks | `PermissionRequest` fires only when Claude Code would ask. Printing nothing leaves its normal prompt in place. A hook timeout doesn't block unless `onFailure: "block"` is set, which Mabari never sets. `additionalContext` carries text to Claude and should read as plain facts. |
| Codex app server | Not installed yet | learn.chatgpt.com/docs/app-server | JSONL over stdio, `initialize` then `initialized`. `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`. Approvals arrive as `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`. Generated schemas are version specific. |
| Web Speech API | Browser | developer.mozilla.org, `SpeechRecognition.processLocally` | Marked experimental. When `true`, recognition must be done locally. MDN doesn't state how it fails, so any error stops listening. |
| Web Audio API | Browser | Standard | An `AudioContext` needs a user gesture before it plays. |
