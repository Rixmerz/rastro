# Tasks

## 1. Read

- [x] 1.1 `src/perception/read.ts`: region/ref/default target, innerText, normalisation, find, cap.
- [x] 1.2 `read` RPC, `rastro read`, `rastro_read`; masked.
- [x] 1.3 Tests: plain text view cannot show, region, find, cap.

## 2. Outputs

- [x] 2.1 `src/flow/json-path.ts`: dotted, `[n]`, `[*]`, fields projection.
- [x] 2.2 `format.ts`: `read` and `capture` steps, `as`, query-aware request patterns.
- [x] 2.3 Runner: outputs, capture wait, masking; `flowRun` and routine results carry them.
- [x] 2.4 Result text; Playwright export handles the new steps.
- [x] 2.5 Tests: parse round trip, json path, capture from a fixture JSON API, read step, missing capture fails.

## 3. HTTP

- [x] 3.1 Compile keeps captured requests, recipe carries capture specs, `read` refused.
- [x] 3.2 Runner applies captures; dispatch returns outputs.
- [x] 3.3 Tests: capture over HTTP end to end on the fixture.

## 4. Docs and gates

- [x] 4.1 README, README.es, CHANGELOG, skill references.
- [x] 4.2 `pnpm typecheck`, `pnpm lint`, `pnpm test` green, by exit code.
