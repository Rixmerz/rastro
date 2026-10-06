# agent-integration Specification

## MODIFIED Requirements

### Requirement: MCP server
`rastro mcp` SHALL run a stdio MCP server exposing open, view, read, act, navigate, effects, trace, request, history, detail and export tools with short descriptions, sharing sessions with the CLI, plus the routine tools defined by `routine-tools`. `--routines-only` SHALL expose only the routine tools, `--routines=catalog` SHALL expose only the two stable routine tools, and `--routines=off` SHALL expose none. Files produced by exports, full bodies and large outputs SHALL be returned as resource links, not inline content.

With `--http` the same server SHALL be served over Streamable HTTP at `/mcp`, on `--host` (default `127.0.0.1`) and `--port` (default `7713`), with one MCP session per client and at most 32 kept, closing the least recently used past that. Every request SHALL carry a bearer token, taken from `RASTRO_MCP_TOKEN` or else generated once and kept in a 0600 file under the Rastro home; the server SHALL print where the token is and never the token. On a loopback address a request whose `Host` header does not name the server SHALL be refused. Binding to any other address SHALL print a warning.

#### Scenario: Shared session
- **WHEN** an MCP client opens a page with the open tool
- **THEN** `rastro view` in a shell shows the same page

#### Scenario: Routines only
- **WHEN** the server runs with `--routines-only`
- **THEN** the tool list holds `rastro_routines`, `rastro_routine_run` and the verified routines, and no browser tool

#### Scenario: HTTP without the token
- **WHEN** a request reaches `rastro mcp --http` without the bearer token, or with a wrong one
- **THEN** it is answered 401 and no MCP session is created

#### Scenario: DNS rebinding
- **WHEN** a request with the right token reaches the loopback server with a `Host` header naming another site
- **THEN** it is answered 403

## ADDED Requirements

### Requirement: MCP evals
`pnpm evals` SHALL drive a real `rastro mcp` process through an MCP client, over stdio and over HTTP, against the fixture site and a real Chromium, in scenarios covering a login and the request it caused, a write blocked by the guard, reading text the view omits, a page whose text tries to instruct the agent, a large navigation, and a CAPTCHA. Each scenario SHALL assert its outcome, that no secret value appears in any tool response, and the token budgets of the output contract; connecting (tool schemas plus instructions) SHALL cost at most 2000 tokens. The run SHALL report the tool calls and tokens read per scenario. Evals SHALL NOT run as part of `pnpm test`.

#### Scenario: A budget regression
- **WHEN** a change makes the login page's view exceed 400 tokens
- **THEN** `pnpm evals` fails on that scenario

#### Scenario: A leaked secret
- **WHEN** any tool response of the login scenario contains the password it filled
- **THEN** `pnpm evals` fails
