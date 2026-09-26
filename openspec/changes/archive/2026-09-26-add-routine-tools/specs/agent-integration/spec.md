# agent-integration Specification

## MODIFIED Requirements

### Requirement: MCP server
`rastro mcp` SHALL run a stdio MCP server exposing open, view, act, navigate, effects, trace, request, history, detail and export tools with short descriptions, sharing sessions with the CLI, plus the routine tools defined by `routine-tools`. `--routines-only` SHALL expose only the routine tools, `--routines=catalog` SHALL expose only the two stable routine tools, and `--routines=off` SHALL expose none. Files produced by exports, full bodies and large outputs SHALL be returned as resource links, not inline content.

#### Scenario: Shared session
- **WHEN** an MCP client opens a page with the open tool
- **THEN** `rastro view` in a shell shows the same page

#### Scenario: Routines only
- **WHEN** the server runs with `--routines-only`
- **THEN** the tool list holds `rastro_routines`, `rastro_routine_run` and the verified routines, and no browser tool
