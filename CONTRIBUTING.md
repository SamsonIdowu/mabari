# Contributing to Mabari

Thank you for helping. Mabari is a small Go server and a React app that show AI agents at work in a pixel office, on the person's own computer.

## Ground rules

- Keep the existing CSS class names and look when changing a screen; the pixel office and Home follow one design, and screenshots in pull requests help review.
- The UI stays calm: only red (approvals and errors) and amber (queued instructions) ask for attention.
- Never use provider logos or imitate another product's look. Provider colours only: orange for Claude, green for OpenAI and Codex, blue for custom agents.
- Security first: bind to `127.0.0.1`, keep secrets in the system keychain, back up any settings file before changing it, and never approve a risky action without a click.
- Numbers the server owns, such as estimates and costs, are computed in Go. The UI only formats them.
- New source files start with `SPDX-License-Identifier: Apache-2.0`.
- By contributing, you agree that your work is licensed under the Apache License 2.0.

## Set up

You need Go 1.27 or later, Node 22 or later and pnpm.

```sh
pnpm --dir web install
pnpm --dir web exec playwright install chromium
make dev        # Vite on 127.0.0.1:4317, the Go server on 127.0.0.1:4327
```

| Command | Does |
|---|---|
| `make test` | `go test -race`, Vitest, then Playwright |
| `make lint`, `make typecheck` | Code checks for Go and the web app |
| `make audit` | govulncheck, pnpm audit and the licence check |
| `make gen` | Regenerates `web/src/gen/models.ts` and `tokens.css` (never edit those by hand) |
| `make build` | `bin/mabari` with the web app embedded |
| `make docker`, `make docker-smoke` | Builds and checks the Docker images |
| `make release-snapshot` | Every archive and package into `dist/`, nothing published |

If Mabari is already running on 4317, run the browser tests beside it with `MABARI_WEB_PORT=4417 MABARI_API_PORT=4427`.

## Where things live

| Path | Purpose |
|---|---|
| `cmd/mabari` | The binary and its subcommands |
| `internal/models` | The data model; Go structs are the source of truth for TypeScript types |
| `internal/events` | The engine: the office's live state, the event log and the WebSocket feed |
| `internal/connectors/*` | One package per source of agents |
| `internal/server` | HTTP API, sign in, and the web app host |
| `internal/service` | Running Mabari at login on macOS, Linux and Windows |
| `web/` | The React app (Vite, TanStack Query, Zustand) |
| `deploy/` | Docker images, compose files and the systemd unit for packages |

## Writing an adapter for a new kind of agent

The simplest way to bring your own agent in is the hub API in [docs/HUB_API.md](docs/HUB_API.md): your program posts its state over HTTP and collects instructions. No Go needed.

To add a built-in connection, write a connector. Look at `internal/connectors/hub` first: it is the smallest. A connector implements `events.Connector`:

```go
type Connector interface {
	Start()
	Stop()
	Instruct(agent *models.LiveAgent, text string)        // an instruction from the person
	Decide(agent *models.LiveAgent, approval models.Approval) // resume after allow or deny
	Interrupt(agent *models.LiveAgent)
	StopAgent(agent *models.LiveAgent)
	Retry(agent *models.LiveAgent)
	AddSubagent(lead *models.LiveAgent, name, task, model string) *models.LiveAgent
	Models() []string                                    // models this account offers
}
```

1. Pick a `Source` name and register the connector in `cmd/mabari/main.go` with `engine.AddConnector(Source, connector)`. Agents carry their source, so the engine sends each instruction, decision and interrupt to the connector that owns the agent.
2. Report what your agents do through the engine, always inside `engine.Do(func() { ... })`, which serialises every change and broadcasts it: `AddAgent` to seat one, `AddEvent` for each tool call (run text through `internal/redact` first), `RequestApproval` when it wants permission, `AddMessage` for replies, `Touch` to keep it alive and `RemoveAgent` when it leaves.
3. Never approve anything yourself. `RequestApproval` waits for a click, unless the person turned on auto approve, and `internal/risk` decides what counts as low risk.
4. If you talk to an outside tool, read its current docs first and record the version and the facts you rely on in [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).
5. Test against a fake of the outside tool, as `internal/connectors/codex` does with a fake app server. Tests never touch real settings, real accounts or the real keychain.

## Sending a change

- Small commits with clear messages, in the style `feat(area): what changed`.
- `make test`, `make lint` and `make audit` pass.
- UI changes are compared with the prototype in both themes, and pass the accessibility checks in `web/e2e/a11y.spec.ts`.
