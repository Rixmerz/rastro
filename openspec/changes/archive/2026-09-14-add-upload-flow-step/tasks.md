# Tasks

## 1. Format

- [x] 1.1 `src/flow/format.ts`: add `upload` to `StepKind` and `STEP_KINDS`, with a target and a `value`, validated like `fill`.
- [x] 1.2 Add optional `description` to `FlowParam` and `paramSchema`; keep it through `stringifyFlow` and `parseFlow`.
- [x] 1.3 Tests: an `upload` step parses and round-trips; a `description` survives.

## 2. Runner

- [x] 2.1 `src/flow/runner.ts`: execute `upload` through `core.runAction` with `setInputFiles`, substituting the value from parameters.
- [x] 2.2 Call the shared sandbox check first; add it to `FlowRunnerCore` and expose it from `EngineCore`.
- [x] 2.3 Tests: a file in an allowed dir attaches; `/etc/hostname` is refused; a symlink out of an allowed dir is refused.

## 3. Capture

- [x] 3.1 `src/flow/capture-script.ts`: handle `input[type="file"]` explicitly — emit kind `upload` carrying the file's name, never `input.value`.
- [x] 3.2 `src/engine/flows.ts`: turn a captured upload into a step whose value is `{{<param>}}`, declaring the parameter with the recorded file name as its `description`.
- [x] 3.3 Tests: the saved YAML contains no `fakepath`, the step is an `upload`, and the parameter is declared and described.

## 4. Docs and gates

- [x] 4.1 README and CHANGELOG: the file is a parameter, and why the locator is not.
- [x] 4.2 `pnpm typecheck`, `pnpm lint`, `pnpm test` green, checked by exit code and not through a pipe.
