# Installing Mabari

Mabari runs on your own computer and opens at **http://localhost:4317**. It only answers on this computer.

## Pick a way to run it

| | Homebrew (macOS, Linux) | Scoop (Windows) | .deb or .rpm | Direct download | Docker |
|---|---|---|---|---|---|
| One command to install | Yes | Yes | Yes | Unpack an archive | `docker compose up` |
| Starts at login | `mabari service install` | `mabari service install` | `systemctl --user enable --now mabari` | `mabari service install` | Compose's restart policy |
| Keys kept in | macOS Keychain or Secret Service | Credential Manager | Secret Service | Your system's keychain | An encrypted file, sealed with a Docker secret |
| Claude Code sessions | Yes | Yes | Yes | Yes | Yes, with `compose.claude.yaml` (see below) |
| Codex agents | If the Codex CLI is installed | Same | Same | Same | Only in the `mabari-agents` image |
| Native folder picker | Yes | Yes | Yes | Yes | No: mount folders under `/workspace` |
| Local Whisper | Install whisper.cpp | Install whisper.cpp | Install whisper.cpp | Install whisper.cpp | Only in `mabari-agents`, built with `WHISPER_CPP_VERSION` (checked with 1.9.5) |
| Upgrades restart the service | Yes | Yes | Yes | Replace the binary, then `mabari service restart` | `docker compose up -d --build` |

## Homebrew

```sh
brew install --cask SamsonIdowu/tap/mabari
mabari service install
```

## Scoop

```powershell
scoop bucket add mabari https://github.com/SamsonIdowu/scoop-bucket
scoop install mabari
mabari service install
```

## .deb and .rpm

```sh
sudo apt install ./mabari_<version>_linux_amd64.deb      # or: sudo dnf install ./mabari-<version>.x86_64.rpm
systemctl --user enable --now mabari
```

The package installs `/usr/bin/mabari` and a systemd user unit for every user. Nobody's Mabari starts until they turn it on. To keep it running after you log out, run `loginctl enable-linger $USER`; Mabari never does that for you.

## Direct download

Download the archive for your system from the release page, check it against `checksums.txt`, unpack it, and put `mabari` somewhere on your `PATH`. Then run `mabari`, or `mabari service install` to start it at every login.

The checksums file is signed with cosign. To check it:

```sh
cosign verify-blob --certificate checksums.txt.pem --signature checksums.txt.sig \
  --certificate-identity-regexp 'https://github.com/SamsonIdowu/mabari/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com checksums.txt
```

## The local service

`mabari service install` shows the file it will write and asks before writing it. It runs Mabari as you, never as an administrator, so Mabari keeps your keychain and your folders.

| System | What install writes | Logs |
|---|---|---|
| macOS | `~/Library/LaunchAgents/dev.mabari.plist`, started at login, restarted after a crash | `~/.mabari/logs/mabari.log` |
| Linux | `~/.config/systemd/user/mabari.service`, restarted after a failure | the journal and `~/.mabari/logs/mabari.log` |
| Windows | A Task Scheduler task for you only, at logon, restarted after a failure | `%APPDATA%\Mabari\logs\mabari.log` |

Other commands: `mabari service start`, `stop`, `restart`, `status`, `logs` and `uninstall`. Uninstall removes only the file install wrote, and keeps your data. Settings has a **Run at login** switch that does the same as install and uninstall, taking effect at the next login.

The service copies your `PATH` and these settings when you install it: `MABARI_PORT`, `MABARI_DATA_DIR`, `MABARI_SECRETS`, `MABARI_MASTER_KEY_FILE` and `MABARI_LOG_LEVEL`. It never copies `MABARI_MASTER_KEY`, because the service file is plain text. Run install again after changing them.

On a Linux machine without a keyring, such as a server, use an encrypted file instead:

```sh
umask 077; openssl rand -base64 32 > ~/.mabari/master_key
MABARI_SECRETS=encrypted-file MABARI_MASTER_KEY_FILE=~/.mabari/master_key mabari service install
```

## Docker

```sh
make docker-key                                    # once: writes deploy/docker/mabari_master_key
docker compose -f deploy/docker/compose.yaml up -d
```

Keep `mabari_master_key` safe. Without it the stored keys can't be read.

The container publishes the port on `127.0.0.1` only. Inside, Mabari listens on all of the container's addresses, which Docker needs, and still refuses requests that don't name `localhost` or `127.0.0.1`. The container runs as a user without privileges, on a read-only file system, with every capability dropped.

**Project folders.** Mount each one under `/workspace` in `compose.yaml`, for example `- ~/code/shop:/workspace/shop`. There is no native folder picker in Docker, so New project lists what is mounted.

**Claude Code on your computer.** Claude Code's hooks run on your computer and report to the container. Install Mabari on your computer as well (Homebrew, Scoop or a download), then run:

```sh
mabari connect claude --token-file ~/.mabari/hook_token
docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.claude.yaml up -d
```

The token file is shared with the container as a Docker secret. The container never changes `~/.claude` itself.

**Agents inside the container.** The `mabari-agents` image adds the Claude Code and Codex command line tools, at the versions Mabari was tested with. It is about 1.6 GB, against about 33 MB for the default image.

```sh
docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.agents.yaml up -d
docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.agents.yaml exec mabari claude
docker compose -f deploy/docker/compose.yaml -f deploy/docker/compose.agents.yaml exec mabari codex login
```

Each tool signs in with its own login, kept in the `mabari-agents-home` volume. To build Local Whisper in as well, set `WHISPER_CPP_VERSION`, for example `WHISPER_CPP_VERSION=1.9.5`, before `up --build`.

**Checking an image.** `make docker-smoke` starts each image with compose on port 4398, loads the demo, checks the WebSocket, the port binding and the hardening, then removes it.
