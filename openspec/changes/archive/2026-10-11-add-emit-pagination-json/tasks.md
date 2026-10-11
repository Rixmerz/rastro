# Tasks

## 1. Pagination

- [x] 1.1 `src/link/paginate.ts`: detection (cursor, next URL, page, offset), next page, merge.
- [x] 1.2 Recipe `paginate` block; only reads; validated on parse.
- [x] 1.3 Compile marks the product request and warns; runner follows pages, merging items.
- [x] 1.4 Tests: detection cases, stop rules, compile, runner end to end.

## 2. Standalone clients

- [x] 2.1 `src/link/emit.ts`: TypeScript and Python runtimes with the runner's rules.
- [x] 2.2 `rastro flow emit`: fresh recipes only, unverified warned, env vars for keyring params.
- [x] 2.3 Tests: both clients run against a local site and match the runner; no credential in the file; strict tsc on the emitted TypeScript.

## 3. `--json`

- [x] 3.1 Envelope with `schemaVersion`, errors as JSON on stdout, exit codes in the help.
- [x] 3.2 CLI and e2e tests read `.data`.

## 4. Docs and gates

- [x] 4.1 README, README.es, CHANGELOG, skill reference.
- [x] 4.2 `pnpm typecheck`, `pnpm lint`, unit tests green.
