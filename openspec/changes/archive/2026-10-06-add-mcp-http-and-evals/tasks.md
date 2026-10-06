# Tasks

## 1. HTTP transport

- [x] 1.1 `src/mcp/http.ts`: Streamable HTTP on `/mcp`, a server and routine watcher per session.
- [x] 1.2 Bearer token from `RASTRO_MCP_TOKEN` or a saved 0600 file; constant-time compare.
- [x] 1.3 Loopback by default, `Host` check on loopback, warning off loopback.
- [x] 1.4 `rastro mcp --http [--host] [--port]`, usage errors without `--http`.
- [x] 1.5 Tests: tools and daemon calls over HTTP, two sessions, 401, 403, 404/400, token file, CLI start.

## 2. Evals

- [x] 2.1 `evals/harness.ts`: client over stdio or HTTP, per-step token record, report.
- [x] 2.2 `evals/mcp.eval.ts`: login + effects + curl, write guard, read, injection, large page, captcha; budgets; no secret leaks.
- [x] 2.3 `pnpm evals`, outside `pnpm test`.

## 3. Docs and gates

- [x] 3.1 README, README.es (Browserbase column, MCP over HTTP, evals), CHANGELOG.
- [x] 3.2 `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm evals` green, by exit code.
