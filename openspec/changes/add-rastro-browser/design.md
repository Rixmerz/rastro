## Context

Research (2026-09-13) established: `playwright-core` 1.63.0 exposes `page.ariaSnapshot({ mode: 'ai' })` and `ariaSnapshotJSON({ mode: 'ai' })` publicly, returning a tree with refs (`e12`) that resolve with the `aria-ref=e12` selector. Playwright's own CLI and MCP live inside `playwright-core` but offer no action→effect attribution. Node 26 runs TypeScript directly with type stripping, and `node:sqlite` ships with Node. The target laptop has `/usr/bin/chromium` and a discrete NVIDIA GPU that must not be held by a headless browser.

## Goals / Non-Goals

**Goals:** minimal context per step; causal trace queryable mid-task; unattended safety; one flow format for agent and human sessions; CLI first, MCP and plugin as wrappers.

**Non-Goals:** a new rendering engine; anti-bot evasion; a hosted service; a custom trace viewer (Perfetto and Playwright trace viewer are used); Firefox/WebKit.

## Decisions

1. **TypeScript run directly by Node.** `erasableSyntaxOnly` + `rewriteRelativeImportExtensions`, relative imports end in `.ts`. No enums, no parameter properties, no namespaces. `tsc` still builds `dist/` for publishing. Rationale: daemon spawn and tests need no build step.
2. **Playwright for perception and actions, raw CDP for the trace.** Playwright's network events drop the CDP `initiator`; a `CDPSession` per page with `Network`, `Page`, `Runtime`, `Log` enabled is the trace source. Playwright is used for launch, contexts, locators, actionability waits, `ariaSnapshotJSON`, routing (write guard), tracing.
3. **SQLite via `node:sqlite`,** one database per session, WAL mode, file mode 0600. Response bodies of document/xhr/fetch up to 2 MB stored as files named by sha256 under `bodies/`.
4. **Daemon per session** listening on a Unix socket `<runtime>/rastro/<session>.sock` (runtime = `$XDG_RUNTIME_DIR` or `<home>/run`), directory mode 0700. Protocol: newline-delimited JSON. Request `{"id":n,"method":"view","params":{...}}`, response `{"id":n,"ok":true,"result":{"text":"...","data":{...}}}` or `{"id":n,"ok":false,"error":{"message":"...","hint":"..."}}`. Formatting happens in the daemon so CLI and MCP print identical text.
5. **Attribution is a pure function** over recorded events, run when the quiet window closes; results are written back to `events.action_id` and `events.bucket`. Pure so fixtures can unit-test it.
6. **Minimal view is a pure formatter** over `ariaSnapshotJSON({mode:'ai'})`; the snapshot JSON is stored per action (before/after) so `snapshot <id>` needs no browser.
7. **Human capture** uses `context.addInitScript` + `context.exposeBinding('__rastroCapture')`; the in-page script computes the locator bundle; the daemon records the action through the same path as agent actions with `source: 'human'`.
8. **Write guard** uses `context.route('**/*')` and only intercepts non-idempotent methods; everything else continues untouched.
9. **Chromium launch args:** `--disable-gpu`; headed adds `--ozone-platform=wayland` when `WAYLAND_DISPLAY` is set. Executable from `RASTRO_CHROMIUM` or `/usr/bin/chromium`, else Playwright's resolution.

## Module ownership

| Path | Responsibility |
|---|---|
| `src/core/types.ts` | Shared contracts (below). Owned by the engineer; builders do not change it without asking. |
| `src/core/paths.ts` | Home, session dir, runtime dir, permissions. |
| `src/store/db.ts` | Schema, inserts, queries (`TraceStore`). |
| `src/security/redact.ts` | Masking of headers, cookies, body fields, known secret values; `«»` quoting. |
| `src/perception/view.ts` | Aria JSON → minimal view text/data; region grouping; find; diff of interactive counts. |
| `src/perception/locators.ts` | In-page locator bundle script; bundle → Playwright locator resolution. |
| `src/attribution/attribute.ts` | Pure attribution; URL template normalization; analytics host list. |
| `src/attribution/quiet.ts` | Quiet window waiter. |
| `src/engine/session.ts` | Browser/context/page lifecycle, tabs, policies (dialogs, downloads, popups, crash), write guard. |
| `src/engine/recorder.ts` | CDP → trace events, bodies, cookie/storage diffs, mutation counters. |
| `src/engine/engine.ts` | Implements `Engine`: every RPC method. |
| `src/engine/blocked.ts` | CAPTCHA / 2FA / bot-block detection. |
| `src/format/*.ts` | Text formatting of summaries, history, effects, trace, request, curl. |
| `src/export/har.ts`, `src/export/perfetto.ts` | Pure exporters from store records. |
| `src/daemon/server.ts`, `src/daemon/client.ts` | Socket server, auto-spawn, stale socket, idle exit. |
| `src/cli/main.ts` | Argument parsing, output contract (4 KB → file), exit codes. |
| `src/flow/format.ts`, `runner.ts`, `export-playwright.ts`, `import-chrome.ts`, `capture-script.ts` | Flow format, execution, codegen, import, human capture. |
| `src/mcp/server.ts` | MCP stdio server over the daemon client. |
| `plugin/` | `.claude-plugin/plugin.json`, `skills/rastro/SKILL.md` + `references/`, `agents/navegador.md`, `.mcp.json`. |
| `test/fixtures/server.ts` | Local HTTP fixture site: login, polling, tracking, dialogs, popup, captcha, large nav. |

## Contracts

The exact TypeScript lives in `src/core/types.ts`; the essential shapes:

- `EventBucket = 'attributed' | 'background' | 'unattributed'`
- `TraceEvent { id; t (ms, monotonic since session start); type; actionId: number | null; bucket: EventBucket | null; tabId; data }` with `type` in `action_start | action_end | request | response | request_failed | redirect | ws_open | ws_close | ws_frames | navigation | console | exception | dialog | download | tab_open | tab_close | cookie_diff | storage_diff | dom_delta | blocked_write | blocked_state | crash`
- `RequestRecord { id ('r' + n); cdpId; tabId; t; method; url; resourceType; status?; failed?; initiator: { type; url?; line?; stackHasInterval: boolean; parentRequestId? }; requestHeaders; responseHeaders?; postData?; bodyHash?; bodySize?; timing?; fromTarget: 'page' | 'worker' | 'other'; redirectedFrom? }`
- `LocatorBundle { role?; name?; text?; testId?; id?; label?; placeholder?; css?; tag?; inputType?; frame? }`
- `ActionRecord { id; source: 'agent' | 'human' | 'flow'; kind; ref?; target?: LocatorBundle; targetName?; value?; secret: boolean; t0; t1?; urlBefore; urlAfter?; summary?: EffectSummary; error?; snapshotBefore?; snapshotAfter? }`
- `EffectSummary { navigatedTo?; requests; failed: { status: number; count: number }[]; cookies: { added; changed; removed }; newElements; consoleErrors; dialogs: string[]; tabsOpened: string[]; downloads: string[]; blockedWrites: string[]; blocked?: string; hiddenBackground; hiddenUnattributed }`
- `RpcResult { text: string; data: unknown; files?: string[] }`
- `Engine` has one async method per RPC: `open, goto, back, forward, reload, view, act, detail, history, effects, trace, request, snapshot, screenshot, console, cookies, storage, tabs, eval, replay, export, recordStart, recordStop, flowSave, flowRun, flowExport, flowImport, status, close`, each `(params) => Promise<RpcResult>`.

## Risks / Trade-offs

- Ref stability across snapshots depends on Playwright caching refs on elements → verified in integration tests; fallback is resolving the locator bundle captured at view time.
- Heuristic attribution can misclassify → fixtures with declared ground truth and a 90% threshold; the unattributed bucket keeps data.
- `context.route` disables HTTP cache for intercepted requests → acceptable for agents; documented.
- `node:sqlite` is marked stable only in recent Node → engines `>=22.5`, tested on Node 26.
- Headed recording on Wayland may need flags → `--ozone-platform=wayland` when `WAYLAND_DISPLAY` is set.
