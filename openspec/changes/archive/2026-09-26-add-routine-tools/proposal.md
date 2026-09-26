# Routines as agent tools

## Why

A saved flow already does a site task end to end: publish a file in a course,
send a mail with an attachment. But an agent still reaches it the long way. It
reads a skill that lists the flows, builds a `rastro flow run` command line with
`--param` pairs it has to get right from prose, and parses free-form lines to
learn whether it worked. When it fails, nothing says whether it is safe to try
again.

What the agent actually needs is a tool: `publish_file(course, section, name,
file)` with a typed schema, a result that says what was created, and a failure
that says where it stopped and whether anything was written. The agent should
not have to understand the flow, only its parameters.

Turning every flow file into a tool would be a disaster, though. Of the flows
saved on the machine this was designed on, three of seven are raw recordings
named `recorded` with locators like `#ext-gen51 > div:nth-of-type(1)`; one only
works after the agent has already picked a section by hand; all of them assume a
logged-in browser profile; and an agent that retries a timed-out "create" makes
two of whatever it created. This change exposes routines as tools with those
failure modes designed out.

## What Changes

- A flow can carry a `tool:` block (description, session, effect, write and
  upload allowlists, optional login flow and the condition that detects a login
  page). **Only flows with that block become routines.** Everything else stays a
  plain flow.
- Flow parameters gain a `type` (`string`, `integer`, `number`, `boolean`,
  `path`, `url`), an `enum` and an `example`, so a routine's input schema is
  typed and validated before the first step runs.
- A routine is exposed as its **own MCP tool only once the exact content of its
  file has completed a run successfully** (probation). Editing the file puts it
  back on probation. Until then it can only be run through the generic tool.
- `rastro mcp` always adds two stable tools, `rastro_routines` (catalog) and
  `rastro_routine_run` (run any routine by name), so nothing depends on the
  client re-reading the tool list.
- The MCP server watches the routine directories and adds, updates or removes
  tools live, announcing it with `notifications/tools/list_changed`. A file that
  stops parsing loses its tool and shows the error in the catalog; it never
  takes the server down.
- A new `routineRun` RPC runs a routine inside the daemon with the routine's own
  write/upload allowlists **for the duration of the run only**, detects a login
  page and runs the declared login flow once before retrying, and **never
  retries after a write request has gone out**. It returns a structured result:
  final URL, the write requests sent, evidence ids, and on failure the failing
  step plus whether a retry is safe.
- `effect: read | write | destructive` maps onto MCP tool annotations
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
- CLI: `rastro routine list | show <name> | run <name>`; `rastro mcp
  --routines-only` for an agent that may only run vetted routines, and
  `--routines=catalog|off` to control how many tool schemas ride on every
  request.
- Routine directories are the project's `.rastro/flows` **and** the user's
  `~/.config/rastro/flows`, project first, with name collisions reported instead
  of silently resolved. `RASTRO_FLOWS` overrides both.

## Impact

- Affected specs: new `routine-tools`; `agent-integration` (MCP server).
- Affected code: `src/flow/format.ts` (manifest, typed params), new
  `src/routines/` (registry, state, schema, result formatting),
  `src/engine/flows.ts` (`routineRun`, verification on success),
  `src/core/types.ts` (RPC method), `src/mcp/server.ts` (dynamic tools),
  `src/cli/main.ts` and `src/cli/args.ts` (`routine` commands, `mcp` flags),
  `src/core/paths.ts` (routine dirs and state dir).

## Out of scope, deliberately

- **MCP tools that create, edit or delete routines.** A routine is a file; an
  agent that can write files can already author one, and probation is what
  keeps an authored routine from going live before it has worked once.
- **Returning arbitrary values scraped from the page.** The result carries the
  final URL and the write requests (method, path, status, redirect target),
  which is enough to know what was created. Declarative extraction can come
  later if a routine needs it.
- **Running two routines on one session at the same time.** The daemon already
  serialises requests; a second call waits its turn.
