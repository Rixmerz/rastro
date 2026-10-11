# Standalone clients, paginated reads and a versioned `--json`

## Why

Compared with reverse-api-engineer, which has an LLM read a HAR and write an
API client, Rastro already does the hard part better: `flow link` compiles a
real run into a recipe deterministically, traces CSRF tokens to the response
that handed them out, keeps credentials out of the file and verifies the
recipe with one HTTP run. Three gaps remained:

1. **The recipe only runs inside Rastro.** Code that wants to call the site
   (a backend job, a script in another repo) has to shell out to `rastro`.
2. **A recipe replays exactly what the run fetched.** A read routine that
   captured page 1 of a list returns page 1, while an LLM-written client would
   have generalised to the rest.
3. **`--json` had no version and errors were text on stderr**, so a parser
   could not tell a failure from an answer, nor notice a shape change.

## What Changes

- **`rastro flow emit <name> [--lang ts|py] [--out path]`** writes a standalone
  client from a fresh recipe: TypeScript (Node >= 22.18 runs it as is) or
  Python (standard library only). The recipe goes in as data and a small
  runtime replays it with the runner's rules, so the client does exactly what
  the verified recipe does: no inference. Like the recipe, the file holds no
  credential: the session comes from a Cookie header or the Rastro session's
  `cookies.json`, and keyring parameters from environment variables. A stale
  recipe is refused; an unverified one is emitted with a warning.
- **Pagination.** `flow link` marks a read routine's product request (the last
  kept request, or a captured one) with a `paginate` block when its JSON
  response looks like one page of a list: a cursor handed out in the response
  and sent back as a query parameter, a next URL on the same origin, a page
  number, or an offset with a limit. The HTTP runner and emitted clients
  follow the pages up to `maxPages` (default 10) and merge their items into
  the first response, so extraction rules and captures see every item. Only
  reads paginate; the compile says so in a warning, and deleting the block
  restores the recorded behaviour.
- **`--json` envelope.** Every `--json` answer is one line:
  `{"schemaVersion":1,"ok":true,"data":…}`, or
  `{"schemaVersion":1,"ok":false,"error":{"kind","message","hint?"}}` with the
  usual text still on stderr. Exit codes: 0 success, 1 runtime, 2 usage.

## Impact

- Affected specs: `flow-link` (pagination, standalone clients),
  `agent-integration` (output contract).
- Affected code: new `src/link/paginate.ts`, `src/link/emit.ts`;
  `src/link/recipe.ts`, `src/link/compile.ts`, `src/link/run.ts`,
  `src/cli/main.ts`, `src/cli/args.ts`, `src/routines/registry.ts`.
- **Breaking:** `--json` output is wrapped in the envelope. Callers read
  `.data` where they read the top level before.

## Non-goals

- Inferring endpoints the run never touched, or writing idiomatic SDKs: the
  client is a faithful replay, not a guess.
- Stealth or anti-bot evasion: a blocked page still stops a run.
