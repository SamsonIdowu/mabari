# Installing Mabari

Mabari runs on your own computer and opens at **http://localhost:4317**. It only answers on this computer.

## Pick a way to run it

The one-line installers in the [README](../README.md#install-in-one-line) are the quickest way:

| | Installer (macOS, Linux, Windows) | Docker |
|---|---|---|
| One command to install | `install.sh` or `install.ps1` | `install.sh --docker` or `install.ps1 -Docker` |
| Starts at login | `mabari service install` | Compose's restart policy |
| Keys kept in | macOS Keychain, Secret Service or Credential Manager | An encrypted file, sealed with a Docker secret |
| Claude Code sessions | Yes | Yes, with `compose.claude.yaml` (see below) |
| Codex agents | If the Codex CLI is installed | Only in the `agents` image |
| Native folder picker | Yes | No: mount folders under `/workspace` |
| Local Whisper | Install whisper.cpp | Only in the `agents` image, built with `WHISPER_CPP_VERSION` (checked with 1.9.5) |
| Upgrades | Run the installer again, then `mabari service restart` | Run the installer again |

The installer downloads a release build when one is published, and otherwise builds from source (git, Go 1.27+ and Node 22+).

## Release builds

When releases are published, each has archives for macOS, Linux and Windows (amd64 and arm64), `.deb` and `.rpm` packages, and `checksums.txt`.

```sh
sudo apt install ./mabari_<version>_linux_amd64.deb      # or: sudo dnf install ./mabari-<version>.x86_64.rpm
systemctl --user enable --now mabari
```

The package installs `/usr/bin/mabari` and a systemd user unit for every user. Nobody's Mabari starts until they turn it on. To keep it running after you log out, run `loginctl enable-linger $USER`; Mabari never does that for you.

For an archive, check it against `checksums.txt`, unpack it, and put `mabari` somewhere on your `PATH`. The checksums file is signed with cosign. To check it:

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
docker compose -f deploy/docker/compose.yaml up -d --build
```

The Docker installer (`install.sh --docker` or `install.ps1 -Docker`) does both for you.

Keep `mabari_master_key` safe. Without it the stored keys can't be read.

Through Docker, every browser signs in with the access key, because Mabari can't tell your browser from another device once Docker's networking is in between. Print it with:

```sh
docker compose -f deploy/docker/compose.yaml exec mabari /mabari access-key
```

The container publishes the port on `127.0.0.1` only. Inside, Mabari listens on all of the container's addresses, which Docker needs. To reach it from other devices, publish it on another address in `compose.yaml`, such as `0.0.0.0:4317:4317`; they sign in with the same access key. The container runs as a user without privileges, on a read-only file system, with every capability dropped.

**Project folders.** Mount each one under `/workspace` in `compose.yaml`, for example `- ~/code/shop:/workspace/shop`. There is no native folder picker in Docker, so New project lists what is mounted.

**Claude Code on your computer.** Claude Code's hooks run on your computer and report to the container. Install Mabari on your computer as well (with the installer), then run:

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
