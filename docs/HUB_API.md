# Hub API

Your own scripts and agents can report to the Mabari office. They take a desk, show their state, and are drawn in blue.

## Get a token

Open **Accounts**, then **Generate a token** under *Hub token for custom apps*. The token starts with `mab_` and is shown once. Making a new one replaces the old one, and **Revoke** turns it off.

Send it on every call:

```
Authorization: Bearer mab_…
```

The hub listens on the same address as Mabari, `http://127.0.0.1:4317`. It is never reachable from another computer.

## Report what an agent is doing

`POST /hub/v1/events`

```json
{
  "agent": "price-bot",
  "name": "Scraper",
  "model": "gpt-4o",
  "state": "running",
  "task": "Check today's prices",
  "progress": 0.4,
  "tool": "fetch",
  "summary": "GET https://shop.example/prices",
  "say": "Halfway there"
}
```

| Field | Required | Meaning |
|---|---|---|
| `agent` | yes | Your id for the agent: 1 to 64 letters, numbers, dashes or underscores. The first report seats it at a free desk. |
| `name` | no | The name on its tag. Defaults to `agent`. Used on the first report only. |
| `model` | no | The model it uses, shown on its tag. |
| `state` | no | `thinking`, `reading`, `editing`, `running`, `browsing`, `idle`, `done`, `error`, `paused`, or `end` to leave the office. |
| `task` | no | One line about what it is working on. |
| `progress` | no | 0 to 1. |
| `tool`, `summary` | no | Adds a line to its live feed. |
| `say` | no | A short speech bubble on the floor. |
| `folder` | no | Its working folder, shown in its panel. |
| `error` | no | What went wrong, with `state: "error"`. |

Text is shortened to one line, and anything that looks like a secret is masked before it is stored.

Replies:

| Status | Meaning |
|---|---|
| `200 {"ok": true}` | Applied. |
| `400` | A field is not valid. The body says which. |
| `401` | The token is missing, wrong or revoked. |
| `409` | Every desk is taken. |

## Collect instructions

People can send your agent instructions from the office. Ask for them when it suits your agent, for example between steps:

`GET /hub/v1/agents/{agent}/instructions`

```json
{ "instructions": ["Also check shipping prices"] }
```

Each instruction is handed over once, oldest first. Interrupt, Stop and Retry from the agent's panel arrive as the instructions `Please pause.`, `Please stop.` and `Please retry.`. Mabari can't reach into your app, so acting on them is up to it.

## Example

```sh
TOKEN=mab_…
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agent":"price-bot","name":"Scraper","state":"running","task":"Check prices"}' \
  http://127.0.0.1:4317/hub/v1/events
```
