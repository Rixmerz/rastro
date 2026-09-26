# Tasks

## 1. Format

- [x] 1.1 `src/flow/format.ts`: `tool:` manifest (description, session, effect, allowWrite, allowUpload, login, loginWhen) parsed and round-tripped.
- [x] 1.2 Typed params: `type`, `enum`, `example`; validation and coercion helper shared by daemon and MCP.
- [x] 1.3 Tests: manifest round trip, invalid effect refused, typed validation, keyring params refused from caller.

## 2. Registry and state

- [x] 2.1 `src/core/paths.ts`: `routineDirs()` (RASTRO_FLOWS, project, user) and `routinesStateDir()`.
- [x] 2.2 `src/routines/state.ts`: content-hash verification markers and last-run records.
- [x] 2.3 `src/routines/registry.ts`: scan, parse, basename naming, shadowing, `rastro_` rejection, `.link.yaml` skip, lint warnings.
- [x] 2.4 Tests: shadowing, invalid file surfaced as a problem, edit resets verification, lint.

## 3. Daemon

- [x] 3.1 `routineRun` RPC: typed validation, scoped allowlists restored in `finally`, login retry only without writes, structured result.
- [x] 3.2 `flowRun` and `routineRun` mark the file verified on success.
- [x] 3.3 Tests against the fixture server: scoped lists restored, login retry, no retry after a POST, verification marker written.

## 4. MCP

- [x] 4.1 `rastro_routines` and `rastro_routine_run`, long timeout and the "may still be running" answer.
- [x] 4.2 One tool per verified routine: generated schema, annotations from `effect`, secret params omitted.
- [x] 4.3 Watch the directories, debounce, reconcile tools (add/update/remove) without crashing on bad files.
- [x] 4.4 `--routines-only`, `--routines=catalog|off`.
- [x] 4.5 Tests with a fake daemon: tool list reflects verification, reload on file change, broken file.

## 5. CLI, docs and gates

- [x] 5.1 `rastro routine list|show|run`, usage strings, `mcp` flags.
- [x] 5.2 README, README.es, CHANGELOG, plugin skill reference.
- [x] 5.3 `pnpm typecheck`, `pnpm lint`, `pnpm test` green, checked by exit code and not through a pipe.
