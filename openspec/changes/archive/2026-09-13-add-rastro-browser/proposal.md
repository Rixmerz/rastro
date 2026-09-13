## Why

AI agents that browse today either receive the whole accessibility tree or DOM on every step (thousands of tokens) or see pixels. None of the existing tools (Playwright MCP/CLI, agent-browser, Chrome DevTools MCP, Obscura) link an agent action to the network requests, navigations, cookie changes and errors it caused in a record the agent can query mid-task. Agents therefore either drown in context or act blind. Rastro gives the agent the minimum a human perceives (what can be interacted with, and a one-line outcome of each action) while recording everything underneath as a causal event trace that can be investigated on demand. A second mode lets a human record a flow in a visible browser so an AI can turn it into scripts, add conditions and resume recording.

## What Changes

- New CLI `rastro` backed by a per-session daemon that drives the system Chromium through Playwright and a raw CDP session.
- Minimal view of a page: only interactive elements with refs, grouped by landmark region, large regions collapsed to counts.
- Actions by ref that return a single-line effect summary after the page goes quiet.
- Append-only event trace in SQLite with action attribution (quiet window + CDP initiator + background detection), queryable per action, time range and type.
- On-demand investigation: element detail, action history, effects, request detail with curl, snapshots before/after, console, cookies, storage.
- Exports: HAR 1.2, Chrome Trace Event Format (Perfetto / DevTools), Playwright trace.zip.
- Autonomous policies: dialogs, popups, downloads, timeouts, crash recovery, CAPTCHA/2FA detection as a blocked state.
- Write guard blocking non-idempotent requests to hosts outside a per-session allowlist; secret masking; page text marked as untrusted.
- Human recording mode and a YAML flow format: run, resume from a step, continue recording, conditions, export to a Playwright test, import from Chrome DevTools Recorder JSON.
- MCP server wrapping the same daemon, and a Claude Code plugin (skill, `navegador` subagent, MCP config).

## Capabilities

### New Capabilities

- `agent-browsing`: sessions, minimal view, actions by ref with effect summaries, navigation, autonomous policies.
- `event-trace`: append-only trace, attribution of events to actions, investigation commands, exports.
- `write-safety`: write guard, secret masking, untrusted page content handling.
- `flow-recording`: human recording, flow format, flow run/resume/continue, Playwright export, Chrome Recorder import.
- `agent-integration`: CLI output contract and token budget, daemon lifecycle, MCP server, Claude Code plugin.

### Modified Capabilities

(none)

## Impact

- New repository `rastro` (TypeScript on Node >= 22.5, executed directly by Node 26 type stripping).
- Runtime dependencies: `playwright-core` 1.63.0 (pinned), `yaml`, `@modelcontextprotocol/sdk`, `zod`.
- Uses the system Chromium (`/usr/bin/chromium`, overridable with `RASTRO_CHROMIUM`); launches with `--disable-gpu` so the laptop's discrete GPU is not held.
- Data under `~/.local/share/rastro/` (overridable with `RASTRO_HOME`), trace databases created with mode 0600.
