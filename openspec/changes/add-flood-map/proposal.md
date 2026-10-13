# Flood: map a whole site by script, then hand the map to an agent

## Why

Rastro traces what one action causes, but an agent still discovers a site one
`view` → `click` → `effects` at a time, paying tokens and minutes for every
step, most of which turn out to be dead ends. Mapping "what does every button
on this site call, and from where" is mechanical work: it needs no judgment,
only patience. It should run as a script, without a model in the loop, as fast
as the site tolerates, and leave behind a map the agent reads in one go and
then digs into where it matters.

The picture is water filling a maze: every open path rises one level at a
time, all pipes together (breadth-first across parallel workers), until the
level is reached or the budget runs out.

## What Changes

- `rastro flood <url>` crawls breadth-first: in every reachable page state it
  activates each interactive element once (click, select first option, submit
  with neutral filler), records the effects through the normal action
  pipeline, restores the state, and queues every new state it found.
- **Pipes.** `--workers N` runs N sessions in parallel, each its own browser
  context seeded with the seed session's cookies, all draining one shared
  frontier ordered by depth, so the whole site rises level by level.
- **Polite by construction.** A per-host rate (`--rate`, default 2 actions/s
  across all workers), jitter, a per-host concurrency cap, exponential backoff
  on 429/503 and `Retry-After`, and robots.txt honoured unless
  `--ignore-robots`. A detected CAPTCHA / bot-block / 2FA (`detectBlocked`)
  stops that host and is recorded in the map. Flood **detects and backs off; it
  never evades** — no fingerprint spoofing, no CAPTCHA solving, same stance as
  the rest of Rastro.
- **Writes stay blocked.** The write guard keeps its empty default. A blocked
  write is recorded with its method, URL and (masked) body — the browser built
  it, it never left — so the map still shows the endpoint a button would call.
  Elements whose name looks destructive or session-ending (logout, delete,
  pay, unsubscribe…) are listed but never activated unless `--include`.
- **The map.** `.rastro/floods/<name>/map.json` (full graph) and `map.md`
  (compact, token-budgeted): states, the elements in each, the edges between
  states, and an **endpoint index** — every request template (method + path
  with ids normalised) with statuses, content type, which elements trigger it
  and from which states, and the `worker#action` ids that caused it.
- **Digging in.** Every action keeps its id in its worker's trace, so the
  existing `effects`, `request --curl`, `snapshot` work on it
  (`rastro -s flood-<name>-w2 request r31 --curl`). `rastro flood show
  <name> [endpoint|state|element]` resolves those for the agent, and
  `rastro flood resume <name> --from <state> --depth +2` floods one branch
  deeper on demand.
- MCP: `rastro_flood_start`, `rastro_flood_status`, `rastro_flood_map` (levels:
  summary → endpoints → one state / one endpoint with request detail).

## Non-goals

- Evading bot detection (stealth plugins, UA/fingerprint spoofing, proxies
  rotation, CAPTCHA solving).
- Sending writes by default, or filling forms with meaningful data. Flood maps
  what a form would call; doing it is a routine's job.
- Load testing. Speed comes from parallel workers inside the rate budget, not
  from exceeding it.
- Linking flood results into recipes automatically. An endpoint found by flood
  becomes a recipe the usual way: a routine, then `flow link`.
