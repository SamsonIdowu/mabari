# Security policy

Mabari runs on your own computer. A click in Mabari can approve real actions by Claude Code and Codex, so who can reach it matters.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/SamsonIdowu/mabari/security/advisories/new), not in a public issue. Include the steps to reproduce the problem and the version you used. We aim to reply within a week.

## Supported versions

Only the latest release gets security fixes.

## How Mabari protects itself

- **Local by default.** Mabari listens on `127.0.0.1:4317` only. The Docker compose file publishes the port on `127.0.0.1` only.
- **Host and Origin checks.** Requests must name `localhost` or `127.0.0.1`, which stops DNS rebinding, and writes and WebSocket upgrades must come from Mabari's own page, which stops other websites.
- **The access key.** Anyone who isn't the person at this computer under a local name signs in with the access key: another device while LAN access is on, any browser through Docker, and, when Settings asks for it on a shared computer, everyone. Sessions are signed with the key, last 30 days and end when the key changes. Failed sign ins are slowed down. See the key in Settings or with `mabari access-key`; `--rotate` makes a new one.
- **Hooks and the hub.** Claude Code hooks sign each call and each reply with an install token, and the hub API needs its own token.
- **Secrets.** API keys and tokens live in the system keychain, or in Docker in a file encrypted with XChaCha20-Poly1305 and sealed with a key from a Docker secret. They are never written in plain text, and the master key is never copied into a service file.
- **Settings files.** Before Mabari changes Claude Code's `settings.json` it shows the change, asks, and keeps a backup. `mabari service install` shows the file it writes and removes only that file on uninstall.
- **Risky actions** always need a click, unless you turn on auto approve for everything.
- **Checks.** CI runs `govulncheck`, `pnpm audit`, a licence check, Trivy on both images, and the Docker hardening checks in `deploy/docker/smoke.sh`.

## What it doesn't protect against

- Programs running as you on this computer can do what you can, including reading the keychain. The access key on a shared computer protects against other people's accounts, not your own programs.
- With LAN access on, traffic on your network is plain HTTP. Use it only on networks you trust.
