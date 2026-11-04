# Mabari

See your AI agents at work, in a little office. Mabari runs on your own computer and shows every agent session as a pixel character at a desk.

Mabari is in early development. The screens and connections are being built in stages; see [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Run it

You need Go 1.27 or later, Node 22 or later and pnpm.

```sh
pnpm --dir web install
make dev
```

Then open <http://localhost:4317>.

## Build one binary

```sh
make build
./bin/mabari
```

## Test it

```sh
pnpm --dir web exec playwright install chromium
make test
```

## Licence

Apache 2.0. See [LICENSE](LICENSE).
