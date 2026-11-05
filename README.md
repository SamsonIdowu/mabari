# Mabari

See your AI agents at work, in a little office. Mabari runs on your own computer and shows every agent session as a pixel character at a desk: Claude Code sessions in orange, Codex in green, your own agents in blue.

- **Watch** what each agent is doing, with its live feed, decision trail and time estimate.
- **Ask** a question about an agent's work without interrupting it. It is answered from the log.
- **Instruct** an agent by typing or by voice, from the agent itself, a project's chat, or Mabari on Home.
- **Approve** risky actions with a click. Nothing risky runs on its own unless you turn on auto approve.
- **Start a project** from a description, or attach a folder, and open Claude Code in it from Mabari.

Everything stays on your computer. Mabari answers on `http://localhost:4317` only, unless you turn on LAN access, and then other devices sign in with an access key.

## Install in one line

| System | Install the app | Or run it in Docker |
|---|---|---|
| macOS, Linux | `curl -fsSL https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.sh \| sh` | `curl -fsSL https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.sh \| sh -s -- --docker` |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.ps1 \| iex` | `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.ps1))) -Docker` |

Then open **<http://localhost:4317>**. Not ready to connect anything? Pick **Explore a demo office** on the first screen.

### What the installer needs

The installer downloads the release build for your system when one is published. Until then, or with `--from-source` (`-FromSource` on Windows), it builds Mabari from source, which needs:

| Tool | Version | Get it |
|---|---|---|
| git | any recent | <https://git-scm.com/downloads> |
| Go | 1.27 or later | <https://go.dev/dl/> |
| Node.js | 22 or later (pnpm comes through Corepack or `npx`) | <https://nodejs.org/> |

The Docker route needs only **git** and **Docker** with Compose v2 (Docker Desktop on macOS and Windows, Docker Engine on Linux). The image is built on your computer, so the first start takes a few minutes.

## Step by step

### macOS

1. Install the tools: `xcode-select --install` gives you git; get Go and Node from the links above, or with Homebrew: `brew install go node`.
2. Run the installer:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.sh | sh
   ```

   It puts `mabari` in `~/.local/bin` and the source in `~/.mabari/src`. If `~/.local/bin` isn't on your `PATH`, add it: `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`, then open a new terminal.
3. Start it with `mabari` and open <http://localhost:4317>.
4. To start it at every login: `mabari service install` (a LaunchAgent in `~/Library/LaunchAgents`). Mabari shows the file and asks before writing it.

### Linux

1. Install the tools, for example on Debian or Ubuntu: `sudo apt install git golang nodejs` (check the versions: Go 1.27+ and Node 22+; use the links above if your distribution's are older). On Fedora: `sudo dnf install git golang nodejs`.
2. Run the installer:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.sh | sh
   ```

3. Start it with `mabari` and open <http://localhost:4317>.
4. To start it at every login: `mabari service install` (a systemd user unit). Keys are kept in the Secret Service (GNOME Keyring or KWallet). On a server without a keyring, keep them in an encrypted file instead:

   ```sh
   umask 077; openssl rand -base64 32 > ~/.mabari/master_key
   MABARI_SECRETS=encrypted-file MABARI_MASTER_KEY_FILE=~/.mabari/master_key mabari service install
   ```

### Windows

1. Install the tools: `winget install Git.Git GoLang.Go OpenJS.NodeJS.LTS`, then open a new PowerShell window.
2. Run the installer in PowerShell:

   ```powershell
   irm https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.ps1 | iex
   ```

   It puts `mabari.exe` in `%LOCALAPPDATA%\Programs\Mabari`, adds that folder to your `PATH`, and keeps the source in `%USERPROFILE%\.mabari\src`.
3. Open a new terminal, start it with `mabari` and open <http://localhost:4317>.
4. To start it at every login: `mabari service install` (a Task Scheduler task for you only).

### Installer options

| macOS, Linux (`sh -s -- …`) | Windows (`-Option`) | Does |
|---|---|---|
| `--docker` | `-Docker` | Runs Mabari in Docker instead of installing the app |
| `--from-source` | `-FromSource` | Builds from source even when a release exists |
| `--service` | `-Service` | Runs `mabari service install` afterwards |
| `--bin DIR` | `-BinDir DIR` | Where the app goes |
| `--src DIR` | `-SrcDir DIR` | Where the source goes |
| `--ref REF` | `-Ref REF` | The branch or tag to build (default `main`) |

For example: `curl -fsSL https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.sh | sh -s -- --service`. On Windows, pass options like this: `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/SamsonIdowu/mabari/main/install.ps1))) -Service`.

### Update and uninstall

- **Update:** run the same one-liner again. It updates the source and replaces the app (or rebuilds the container). If the service is running, follow with `mabari service restart`.
- **Uninstall:** `mabari service uninstall` if you installed the service, then delete the app (`~/.local/bin/mabari`, or `%LOCALAPPDATA%\Programs\Mabari`) and the source (`~/.mabari/src`). Your data stays in `~/.mabari` (`%APPDATA%\Mabari` on Windows) until you delete it.

## Docker

The Docker one-liner gets the source into `~/.mabari/src`, makes a master key, and runs:

```sh
docker compose -f deploy/docker/compose.yaml up -d --build
```

What to know:

- **Only this computer can reach it.** The port is published on `127.0.0.1:4317`. To change the port, set `MABARI_HOST_PORT` before `up`.
- **Sign in with the access key.** Through Docker every browser signs in with an access key, because Mabari can't tell your browser from another device once Docker's networking is in between. Print it with:

  ```sh
  docker compose -f ~/.mabari/src/deploy/docker/compose.yaml exec mabari /mabari access-key
  ```

- **Keys are sealed with `deploy/docker/mabari_master_key`.** The installer makes it once (it is never committed). Keep it: without it the stored keys can't be read.
- **Your data** lives in the `mabari-data` volume, so it survives updates.
- **Project folders:** mount each one under `/workspace` in `deploy/docker/compose.yaml`, for example `- ~/code/shop:/workspace/shop`. Docker has no native folder picker.
- **Claude Code on your computer** can report to the container: install the app as well, run `mabari connect claude --token-file ~/.mabari/hook_token`, then start with both files: `docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.claude.yaml up -d`.
- **Agents inside the container:** the larger `agents` image includes the Claude Code and Codex CLIs: `docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.agents.yaml up -d --build`, then sign in once with `… exec mabari claude` or `… exec mabari codex login`.
- **Stop:** `docker compose -f ~/.mabari/src/deploy/docker/compose.yaml down`. **Update:** run the Docker one-liner again.

The container runs as a user without privileges, on a read-only file system, with every capability dropped.

## Connect your agents

| Agent | How it connects |
|---|---|
| Claude Code | `mabari connect claude`, or **Accounts → Attach Claude Code**. Mabari adds hooks to `~/.claude/settings.json` after showing you the change and keeping a backup. Every Claude Code session you start, in a terminal or an editor, takes a desk. |
| Codex | Sign in with ChatGPT under **Accounts**. Mabari runs `codex app-server`, so the Codex CLI must be installed. |
| API keys | Add an Anthropic or OpenAI key under **Accounts** to answer queries with a model. Keys are kept in your system keychain. |
| Your own agents | Report over HTTP with a hub token. See [docs/HUB_API.md](docs/HUB_API.md). |

Agent files load on their own: `~/.claude/agents` and `~/.codex/agents` for your account, and a project's `.claude/agents` and `.codex/agents` once the project has its folder.

## Projects

A project works in its own folder. **New project** makes the folder (or clones a repository into it) and opens Claude Code there. On the **Projects** page, each card has **Chat**: send a message or a `/command` and it goes to the Claude Code session working in that project, or opens Claude Code in the folder with it. On Home, pick the project in the dock, or name it ("send /review to Shop"), and Mabari passes it on.

## Voice

Hold the mic on Home, or Space, to talk to Mabari; release to send. Hold the mic for 2 seconds or swipe up to lock it on, then tap to send or press Esc to cancel. Speech is recognised on this computer, by the browser or by [whisper.cpp](https://github.com/ggml-org/whisper.cpp) if you choose Local Whisper in Settings. Voice can never approve anything.

## Settings

| Setting | Default | Does |
|---|---|---|
| `MABARI_PORT` (or `--port`) | `4317` | The port Mabari listens on |
| `MABARI_DATA_DIR` | `~/.mabari` (`%APPDATA%\Mabari` on Windows) | Where Mabari keeps its database and logs |
| `MABARI_SECRETS` | `keychain` | `keychain`, or `encrypted-file` with `MABARI_MASTER_KEY_FILE` |
| `MABARI_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `MABARI_LOG_FILE` | none | Also write the log to this file |

Run `mabari --help` for the subcommands: `serve`, `connect`, `service`, `access-key`, `healthcheck`, `version` and more.

## Build from source by hand

```sh
git clone https://github.com/SamsonIdowu/mabari.git && cd mabari
pnpm --dir web install
make build && ./bin/mabari     # one binary with the web app inside
make dev                       # or: Vite and the Go server with reloading
make test                      # Go, Vitest and Playwright
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to work on Mabari, and [SECURITY.md](SECURITY.md) for how it protects itself and how to report a problem.

## Troubleshooting

- **`mabari: command not found`:** the app's folder isn't on your `PATH` yet. Open a new terminal, or add `~/.local/bin` (macOS, Linux) as shown above.
- **The port is taken:** start it on another one, `mabari serve --port 4400`, or set `MABARI_PORT`.
- **The build fails:** check `go version` (1.27+) and `node --version` (22+), then run the installer with `--from-source`.
- **Docker asks for an access key:** print it with the `access-key` command above.

## Licence

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
