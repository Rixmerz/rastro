# agent-integration Specification

## Purpose
Makes Rastro cheap in tokens and usable by any agent: a lean CLI contract, a self-managing daemon, an MCP server and a Claude Code plugin.

## Requirements

### Requirement: Output contract and token budget
Every command SHALL print plain text by default and a JSON object with `--json`. Output longer than 4 KB SHALL be written to a file under the session output directory and the command SHALL print the path followed by the first 20 lines. Errors SHALL be printed to stderr with a non-zero exit code and a message that says what to do next. Measured as characters divided by 4, the minimal view of each bundled fixture page SHALL be at most 400 tokens and an action summary line at most 40 tokens.

#### Scenario: Large output
- **WHEN** `rastro trace` would print 12 KB
- **THEN** it writes the full text to a file and prints its path and the first 20 lines

#### Scenario: JSON output
- **WHEN** the agent runs `rastro act e5 click --json`
- **THEN** stdout is a single JSON object with the action id and the effect counters

### Requirement: Daemon lifecycle
The first command for a session SHALL start a background daemon automatically and later commands SHALL reuse it through a local socket readable only by the user. The daemon SHALL exit after an idle period (default 60 minutes) or on `rastro close`. A stale socket SHALL be detected and replaced. `rastro status` SHALL list active sessions.

#### Scenario: Auto start
- **WHEN** no daemon is running and the agent runs `rastro open https://example.test`
- **THEN** a daemon starts, the page opens, and the command returns

#### Scenario: Stale socket
- **WHEN** the daemon was killed and its socket file remains
- **THEN** the next command removes the socket, starts a new daemon and succeeds

### Requirement: MCP server
`rastro mcp` SHALL run a stdio MCP server exposing open, view, act, navigate, effects, trace, request, history, detail and export tools with short descriptions, sharing sessions with the CLI. Files produced by exports, full bodies and large outputs SHALL be returned as resource links, not inline content.

#### Scenario: Shared session
- **WHEN** an MCP client opens a page with the open tool
- **THEN** `rastro view` in a shell shows the same page

### Requirement: Claude Code plugin
The repository SHALL ship a Claude Code plugin with a skill whose body is at most 1500 tokens covering the base commands and linking deeper references, a `navegador` subagent that receives a browsing goal and returns a short conclusion with evidence ids, and an MCP configuration for `rastro mcp`.

#### Scenario: Skill size
- **WHEN** the skill file is measured as characters divided by 4
- **THEN** the body is at most 1500 tokens
