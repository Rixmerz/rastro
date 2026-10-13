# Flood: a scripted map of a whole site

Use it when the goal is to *understand a site*: every screen, every button,
and the API calls behind them. For one task on a known site, browse or use a
routine instead. Flood costs browser time, not tokens: it runs without you,
and you read the result.

## Run

```bash
rastro -s <session> flood <url> [--name n] [--workers 2] [--depth 3] [--budget 300] [--time 10m]
rastro flood <url> --detach         # background; then rastro flood status <name>
```

- Log in first in `<session>`: workers copy its cookies. Without a running
  session they start logged out.
- Writes stay blocked. Do not try to widen it: flood maps what a form would
  send, it does not send it.
- Logout/delete/pay-like elements are skipped. Add names with `--skip a,b`.
  Only pass `--include` when the user asked for that element.
- Never pass `--ignore-robots` unless the user owns the site or said so.
- A `blocked` host in the map (CAPTCHA, bot wall) is the end of the road for
  this flood. Report it. There is no way around it, and you should not try one.

## Read

```bash
rastro flood show <name>            # overview: writes, reads, state tree, blocks (~4k tokens)
rastro flood show <name> E7         # one endpoint: triggers, samples, drill-in commands
rastro flood show <name> S4         # one state: each element, outcome, where it led
```

Element outcomes: `done` (led to another state), `same` (stayed, maybe
called something), `error`, `blocked:<reason>`, `external`, `unreachable`,
`skipped:denylist|skip|robots|duplicate-link|seen|disabled`, `pending`
(left unexplored).

## Dig in

Every sample names its worker session and ids. Those are ordinary traces:

```bash
rastro -s flood-<name>-w2 request r311 --curl
rastro -s flood-<name>-w2 effects 88
rastro -s flood-<name>-w2 snapshot 88 --after
```

Over MCP, pass `session: "flood-<name>-w2"` to `rastro_request` /
`rastro_effects`.

To go deeper where it matters: `rastro flood resume <name> --from S4 --depth +2`.
To turn an endpoint into something repeatable, make a routine that reaches it,
then `flow link` it.
