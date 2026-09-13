## 1. Foundation

- [x] 1.1 Write `src/core/types.ts` and `src/core/paths.ts` contracts
- [x] 1.2 Fixture site `test/fixtures/server.ts` (login, polling, tracking, dialogs, popup, captcha, large nav) with declared attribution ground truth
- [x] 1.3 `src/store/db.ts` TraceStore with schema, inserts, queries, 0600 permissions, unit tests
- [x] 1.4 `src/security/redact.ts` masking and `«»` quoting, unit tests
- [x] 1.5 `src/perception/view.ts` minimal view, regions, collapse, find, unit tests
- [x] 1.6 `src/attribution/attribute.ts` pure attribution, URL templates, analytics hosts, unit tests
- [x] 1.7 `src/export/har.ts` and `src/export/perfetto.ts`, unit tests
- [x] 1.8 `src/flow/format.ts`, `export-playwright.ts`, `import-chrome.ts`, unit tests

## 2. Engine

- [x] 2.1 `src/engine/session.ts` launch, contexts, tabs, dialogs, downloads, popups, crash relaunch, write guard
- [x] 2.2 `src/engine/recorder.ts` CDP events, bodies, cookie/storage diffs, mutation counters
- [x] 2.3 `src/attribution/quiet.ts` and `src/perception/locators.ts`
- [x] 2.4 `src/engine/blocked.ts` CAPTCHA / 2FA / bot block detection
- [x] 2.5 `src/format/*.ts` summaries, history, effects, trace, request, curl
- [x] 2.6 `src/engine/engine.ts` all browsing and investigation RPC methods
- [x] 2.7 Integration tests on fixtures: view token budget, act summary, stale ref, policies, write guard, secrets, attribution >= 90%

## 3. Daemon and CLI

- [x] 3.1 `src/daemon/server.ts` and `client.ts` with auto-spawn, stale socket, idle exit
- [x] 3.2 `src/cli/main.ts` commands, `--json`, 4 KB to file, exit codes
- [x] 3.3 End-to-end CLI test against fixtures

## 4. Flows and human recording

- [x] 4.1 `src/flow/capture-script.ts` and record start/stop in the engine
- [x] 4.2 `src/flow/runner.ts` run, `--from`, params, expectations, conditions, continue recording
- [x] 4.3 `flow save`, `flow export`, `flow import` wired to engine and CLI
- [x] 4.4 Integration tests: headless capture via synthetic page events, save, run, export

## 5. Integrations

- [x] 5.1 `src/mcp/server.ts` with resource links
- [x] 5.2 `plugin/` skill (<= 1500 tokens) + references, `navegador` agent, `.mcp.json`, plugin.json
- [x] 5.3 README

## 6. Validation

- [x] 6.1 typecheck, lint, full test suite green
- [x] 6.2 Adversarial review and security audit; fixes applied
- [x] 6.3 Real-site token measurement and GPU check (`fuser /dev/nvidia*`)
- [x] 6.4 Install `rastro` binary on PATH and the plugin locally
