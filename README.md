# Mabari

See your AI agents at work, in a little office. Mabari runs on your own computer and shows every agent session as a pixel character at a desk.

Mabari is in early development. The screens and connections are being built in stages; see [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Run it

You need Node 22 or later and pnpm.

```sh
pnpm install
pnpm dev
```

Then open <http://localhost:4317>.

## Test it

```sh
pnpm exec playwright install chromium
pnpm test
```
