# Tasks

## 1. Recipe and compiler

- [x] 1.1 `src/link/recipe.ts`: recipe types, parse (zod) and stringify.
- [x] 1.2 `src/link/compile.ts`: request selection, field extraction per body type, param binding with the short-value rule, value tracing with validated rules, token-like constant warnings.
- [x] 1.3 Credential check over the serialized recipe; abort on a hit.
- [x] 1.4 Unit tests: form + hidden input, JSON path, Location header, earlier query, secret binding, ambiguous short value, credential abort.

## 2. Runner

- [x] 2.1 `src/link/jar.ts`: cookie jar (domain/path/secure/expiry/host-only), load/save 0600.
- [x] 2.2 `src/link/run.ts`: substitution, manual redirects, status-class check, extraction, write tracking, fallback signal before the first write.
- [x] 2.3 Unit tests against a local HTTP server: extraction chain, redirect cookies, mismatch before and after a write.

## 3. Daemon, routines and CLI

- [x] 3.1 Export the cookie jar after each successful browser flow/routine run.
- [x] 3.2 `flowLink` RPC (run-then-compile, or compile from an action range); refuse when not linkable.
- [x] 3.3 Engine choice `browser|http|auto` for routines; recipe freshness and verification.
- [x] 3.4 `rastro flow link`, `--engine` on `routine run` and `rastro_routine_run`; link status in `routine list`.
- [x] 3.5 End-to-end test on the fixture server: link a CSRF form, rerun over HTTP with a new value, server receives it.

## 4. Docs and gates

- [x] 4.1 README, README.es, CHANGELOG, plugin skill reference.
- [x] 4.2 `pnpm typecheck`, `pnpm lint`, `pnpm test` green, checked by exit code and not through a pipe.
