# MCP over HTTP, and evals that drive it like an agent

## Why

Set side by side with Browserbase's MCP server, two gaps stood out. Rastro's
MCP server speaks only stdio, so a client that connects to a URL (a remote
agent, a hosted client, anything that does not spawn processes) cannot use it.
And the token budgets the specs promise are checked by unit tests of the
formatter and one CLI e2e, never through the MCP protocol an agent actually
uses, so nothing measures what an agent reads end to end.

## What Changes

- **`rastro mcp --http`** serves the same tools over Streamable HTTP at
  `/mcp`, with `--host` (default `127.0.0.1`) and `--port` (default `7713`).
  - Every request needs a bearer token: `RASTRO_MCP_TOKEN`, or one generated
    on the first run and kept 0600 under `RASTRO_HOME`. The server prints
    where it is, never the token.
  - On loopback the `Host` header must name the server, against DNS
    rebinding. Another address is allowed and warns.
  - One MCP session per client, each with its own routine watcher, closed
    with the session; past 32 the least recently used is closed.
- **`pnpm evals`**: scenarios driven through a real `rastro mcp` process over
  stdio and HTTP, against the fixture site and a real Chromium, asserting the
  outcome, that no secret reaches the agent, and the token budgets; a report
  of what the agent read, optionally as JSON.
- README comparison gains Browserbase MCP.

## Impact

- Affected specs: `agent-integration` (MCP server; new MCP evals requirement).
- Affected code: new `src/mcp/http.ts`; `src/mcp/server.ts`,
  `src/cli/{main,args}.ts`; new `evals/`, `vitest.evals.config.ts`;
  `test/fixtures/server.ts` falls back to IPv4 on hosts without IPv6.

## Out of scope, deliberately

- OAuth: a single bearer token is enough for a server that drives one
  person's own browser.
- LLM-driven evals: they need a model key and are not deterministic; these
  evals script the agent's calls so a regression is a red test.
