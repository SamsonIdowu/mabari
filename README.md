# Mabari

See your AI agents at work, in a little office. Mabari runs on your own computer and shows every agent session as a pixel character at a desk: Claude Code sessions in orange, Codex in green, your own agents in blue.

- **Watch** what each agent is doing, with its live feed, decision trail and time estimate.
- **Ask** a question about an agent's work without interrupting it. It is answered from the log.
- **Instruct** an agent by typing or by voice. Claude Code gets it at its next checkpoint; Codex straight away.
- **Approve** risky actions with a click, from the floor or the notice board. Nothing risky runs on its own unless you turn on auto approve.
- **Start a project** from a description: Mabari plans a team, and nothing starts until you approve the plan.

Everything stays on your computer. Mabari answers on `http://localhost:4317` only, unless you turn on LAN access, and then other devices sign in with an access key.

## Install

```sh
brew install --cask SamsonIdowu/tap/mabari     # macOS and Linux
scoop install mabari                           # Windows, after adding the bucket
docker compose -f deploy/docker/compose.yaml up -d
```

Then open <http://localhost:4317>, and run `mabari service install` to start it at every login. [docs/INSTALL.md](docs/INSTALL.md) covers every method, the `.deb` and `.rpm` packages, direct downloads and Docker.

## Connect your agents

| Agent | How it connects |
|---|---|
| Claude Code | `mabari connect claude`, or **Accounts → Attach Claude Code**. Mabari adds hooks to `~/.claude/settings.json` after showing you the change and keeping a backup. Sessions you start in your terminal take a desk. |
| Codex | Sign in with ChatGPT under **Accounts**. Mabari runs `codex app-server`, so the Codex CLI must be installed. |
| API keys | Add an Anthropic or OpenAI key under **Accounts** to answer queries with a model. Keys are kept in your system keychain. |
| Your own agents | Report over HTTP with a hub token. See [docs/HUB_API.md](docs/HUB_API.md). |

Not ready to connect anything? **Explore a demo office** on the first screen.

## Voice

Hold Space or the mic to talk. Speech is recognised on this computer, by the browser or by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) if you choose Local Whisper in Settings. Spoken instructions always wait for Send or Enter, and voice can never approve anything.

## Build from source

You need Go 1.27 or later, Node 22 or later and pnpm.

```sh
pnpm --dir web install
make build && ./bin/mabari     # one binary with the web app inside
make dev                       # or: Vite and the Go server with reloading
make test                      # Go, Vitest and Playwright
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to work on Mabari or write an adapter for a new kind of agent, and [SECURITY.md](SECURITY.md) for how it protects itself and how to report a problem.

## Licence

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
