# flood-map Specification

## Purpose
Maps a whole site by script, with no model in the loop, into a map an agent reads in one go and drills into: every reachable screen, what each element does, and the calls behind it, while staying polite to the site and never sending writes.

## Requirements

### Requirement: Breadth-first flood without a model
`rastro flood <url>` SHALL explore the site without any model in the loop: in
each reachable state it SHALL activate every interactive element at most once,
through the normal action pipeline with source `flood`, and SHALL queue every
new state found. The frontier SHALL be served shallowest-first across all
workers, and the crawl SHALL stop at `--depth`, `--budget` or `--time`,
recording what was left as unexplored.

#### Scenario: Level by level
- **WHEN** `rastro flood https://app.test --workers 3 --depth 2` runs on a site whose home links to A and B, and A links to C
- **THEN** no level-2 state (C) is worked on before every level-1 item of A and B has been taken by a worker

#### Scenario: Budget reached
- **WHEN** the budget is reached with items still queued
- **THEN** the map lists them under `unexplored` and the command exits successfully, saying so

### Requirement: Parallel workers share one frontier
`--workers N` SHALL run N separate sessions, each seeded with the seed
session's cookies and storage, so that each action's attribution stays
one-action-at-a-time per page. A crashed worker SHALL be relaunched and its
item requeued once.

#### Scenario: Logged-in flood
- **WHEN** the user logs in on session `app` and runs `rastro -s app flood https://app.test --workers 4`
- **THEN** all four workers start authenticated and the map is built from all of them

### Requirement: Polite pacing, never evasion
Flood SHALL pace actions per registrable host with a shared rate (default 2
per second) with jitter and a per-host concurrency cap, SHALL back off on 429
and 503 honouring `Retry-After`, and SHALL respect robots.txt unless
`--ignore-robots`, refusing to start when it disallows the start URL. When `detectBlocked` reports a CAPTCHA, bot-block or 2FA,
flood SHALL pause that host and record the state as blocked; after two
consecutive blocks it SHALL stop flooding that host. Flood SHALL NOT alter the
browser fingerprint, rotate identities or attempt to solve challenges.

#### Scenario: Rate limited
- **WHEN** the site answers 429 with `Retry-After: 10`
- **THEN** no worker acts on that host for 10 seconds and the host's rate is halved

#### Scenario: Bot wall
- **WHEN** two consecutive actions on a host end in `blocked: captcha`
- **THEN** flood stops working on that host, the map records it, and the remaining items for it are listed as unexplored

### Requirement: Writes stay blocked and keep their shape
Flood SHALL NOT widen the write allowlist. A blocked write SHALL be recorded
with method, URL and its body masked and capped as allowed writes are, so the
map shows what the element would send. Elements whose accessible name matches
the destructive or session-ending denylist SHALL be listed but not activated
unless named in `--include`. Password fields SHALL never be filled.

#### Scenario: A form found, not sent
- **WHEN** flood submits a contact form on a session with no `--allow-write`
- **THEN** the request is aborted, and the map's endpoint index lists `POST /api/contact` as a blocked write with its masked field names

#### Scenario: Logout skipped
- **WHEN** a state contains a link named «Cerrar sesión»
- **THEN** it appears in the map as skipped and is never clicked

### Requirement: The flood does not repeat itself
A control in a header, navigation or footer region SHALL be activated at most
once per flood; any other control at most once per state URL template; a link
at most once per target URL template. Elements skipped this way SHALL be
recorded with why.

#### Scenario: A list of thirty products
- **WHEN** a page lists thirty links to `/products/{id}`
- **THEN** one of them is followed and the other twenty-nine are recorded as `skipped:duplicate-link`

### Requirement: Running in the background
`--detach` SHALL start the flood in a detached process and return. `flood
status` SHALL say whether it is still running, `flood stop` SHALL end it after
the steps in flight keeping the remaining items as unexplored, and the MCP
tool that starts a flood SHALL always detach.

#### Scenario: Stopped by the user
- **WHEN** `rastro flood stop shop` runs while the flood is working
- **THEN** the flood ends with status `stopped` and what was left is listed under `unexplored`, ready for `flood resume`

### Requirement: A map an agent can read and drill into
Flood SHALL write `map.json` and a token-budgeted `map.md` with states, edges,
an endpoint index grouped by method, host and path template, and the blocked,
unreachable, unexplored and external entries. Every endpoint and state SHALL
reference the worker session and action ids that produced it, so `effects`,
`request` and `snapshot` work on them. `rastro flood show <name> <id>` and
`rastro_flood_map` SHALL expand an id to its detail, and `rastro flood resume
--from <state>` SHALL flood one branch deeper.

#### Scenario: From map to curl
- **WHEN** the agent reads `E7 GET /api/orders/{id} 200 ← S4 «Ver pedido»` in `map.md` and runs `rastro flood show shop E7`
- **THEN** it receives the request detail and the `rastro -s flood-shop-w2 request r88 --curl` command that reproduces it, secrets masked
