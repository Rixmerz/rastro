# Reading pages, and routines that return what they read

## Why

An agent asked to read a mail in Outlook could not, whatever the model. `view`
lists what can be interacted with, and a mail body is plain text: it never
shows up. The MCP server has no `eval` either, so over MCP there was no way at
all to read the words on a page. A small model then flails; a large one gives
up the same way, only later.

Routines have the matching gap. They report what they wrote (final URL,
writes) and nothing they read, so every "read" task — list the inbox, open a
mail, fetch a timetable — is out of reach for them, and those are exactly the
tasks a small, fast model should be handed as a single typed call.

## What Changes

- **`rastro read`** (and `rastro_read` over MCP) returns the visible text of the
  page's main region, of a named region (`--region aside`), of one element
  (`--ref e5`), filtered to the lines around a word (`--find`), capped with a
  note when truncated, and masked like every other output.
- **Two new flow steps that produce outputs**, each naming its output with `as`:
  - `read`: the text of a region or target, as `rastro read` returns it;
  - `capture`: the JSON response of a request the run caused, matched by a
    request pattern (the path may now include a query), narrowed by a JSON
    path with `[*]` over arrays and an optional `fields` projection.
- Routine results carry `outputs`, in the text form and in the structured data,
  for the browser engine and the HTTP engine alike.
- **`capture` works over HTTP**: `flow link` keeps the captured request in the
  recipe and the replay applies the same capture to its response. A routine
  that uses `read` is not linkable, since page text needs a page.

## Impact

- Affected specs: `agent-browsing` (read), `routine-tools` (outputs),
  `flow-link` (captures over HTTP).
- Affected code: new `src/perception/read.ts` and `src/flow/json-path.ts`;
  `src/flow/format.ts` (steps, `as`, query in request patterns),
  `src/flow/runner.ts`, `src/engine/engine.ts` (`read` RPC),
  `src/mcp/server.ts`, `src/cli/`, `src/routines/result.ts`,
  `src/link/{compile,recipe,run}.ts`, `src/flow/export-playwright.ts`.

## Out of scope, deliberately

- Reading inside cross-origin iframes: `read` sees the top document.
- Screenshots or OCR: text that is only pixels stays out of reach.
