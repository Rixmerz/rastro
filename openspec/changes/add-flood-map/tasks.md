# Tasks

## 1. Building blocks

- [x] 1.1 `src/flood/state.ts`: URL template and structure hash, element keys, tests on fixture pages with changing counters.
- [x] 1.2 `src/flood/frontier.ts`: depth-ordered queue, dedupe by `(state, elementKey)`, budget/depth/time limits, unexplored dump.
- [x] 1.3 `src/flood/policy.ts`: denylist by name (en/es), external-domain check, filler values by input type, robots.txt parser.
- [x] 1.4 `src/flood/rate.ts`: per-host token bucket with jitter, concurrency cap, backoff on 429/503 and `Retry-After`.

## 2. Engine

- [x] 2.1 Write guard records the (masked, capped) body of a blocked write; `effects` shows it.
- [x] 2.2 Action source `flood`; `reach(state)` = goto ancestor + replay path + verify hash.
- [x] 2.3 Worker loop: pop, reach, activate via `runAction`, classify outcome (new state, same state, blocked, error), report.

## 3. Coordinator

- [x] 3.1 Daemon-side coordinator: spawn N worker sessions seeded with the seed session's cookies/storage, shared frontier and limiter, crash requeue.
- [x] 3.2 Map builder: endpoint grouping by template, edges, blocked/unreachable/external; `map.json` + budgeted `map.md`.
- [x] 3.3 `flood resume --from <state> --depth +n`, `flood stop`, progress line.

## 4. Surfaces

- [x] 4.1 CLI: `rastro flood <url>` (`--workers --depth --budget --time --rate --skip --include --ignore-robots --name`), `flood status|show|resume|stop|list`.
- [x] 4.2 MCP: `rastro_flood_start`, `rastro_flood_status`, `rastro_flood_map` with levels.
- [x] 4.3 Fixtures: a small SPA with tabs, a modal, a form, a polling endpoint, a logout link and a page that answers 429; e2e test that the map lists every fixture endpoint and never activates logout.

## 5. Docs and gates

- [x] 5.1 README, README.es, CHANGELOG, skill, navegador agent.
- [x] 5.2 `pnpm typecheck`, `pnpm lint`, `pnpm test` green, by exit code.
