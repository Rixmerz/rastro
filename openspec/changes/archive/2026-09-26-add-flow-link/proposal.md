# Linking a flow to the HTTP calls it causes

## Why

Every routine run today launches Chromium: hundreds of megabytes and seconds of
start-up to send what, underneath, is a handful of HTTP requests. Rastro already
knows which requests each action caused — that is its whole trace — so it can
compile a recorded run into those requests and replay them directly, with
nothing but Node's `fetch`.

The hard part is not the URLs. It is the values that change on every run: a
Moodle `sesskey`, an ASP.NET `__VIEWSTATE`, a draft item id handed out by one
request and consumed by the next. A recipe that freezes them replays once and
then fails, or worse, posts stale state. So compiling has to find where each
such value came from and turn it into an extraction rule.

## What Changes

- `rastro flow link <name>` compiles a successful browser run of a flow into an
  **HTTP recipe**, `<name>.link.yaml`, next to the flow. It either runs the flow
  once in the browser (a real run, with its real effects) or compiles from an
  earlier run given by action ids.
- The compiler keeps the requests the run's actions caused (documents, xhr and
  fetch, no redirect hops), binds parameter values back to `{{param}}`, and
  traces every other non-trivial value to the earlier response it came from
  (JSON path, hidden form input, regex over the body, redirect `Location`),
  emitting an extraction rule. Values it cannot trace are kept as constants and
  **listed as warnings** when they look like tokens.
- The recipe contains templates and rules only: **no cookie, no token, no
  secret value**. Compilation aborts if one would be written.
- The recipe is bound to the flow's content hash; a changed flow makes it stale.
- `routineRun` and `rastro routine run` pick an engine: `browser`, `http`, or
  `auto` (default). `auto` uses the recipe only when it is fresh and verified,
  and falls back to the browser **only while no write request has been sent**.
- The HTTP runner uses a cookie jar exported from the browser session after
  each successful browser run (mode 0600), follows redirects itself, and checks
  each response against the status class recorded for it.
- A recipe is verified the same way a routine is: after one successful HTTP run
  of its exact bytes, requested explicitly with `--engine http`.

## Impact

- Affected specs: new `flow-link`.
- Affected code: new `src/link/` (compile, recipe format, cookie jar, HTTP
  runner), `src/engine/flows.ts` (`flowLink` RPC, cookie export),
  `src/routines/` (engine choice), `src/mcp/server.ts` and `src/cli/` (engine
  flag, `flow link`).

## Out of scope, deliberately

- **Compiling a Playwright script.** The input is a trace, not source code. A
  Playwright test can be linked only by running the equivalent flow in Rastro.
- **Requests signed by page JavaScript, WebSockets, and short-lived bearer
  tokens minted client-side.** The compiler cannot see how they are produced, so
  such a flow is reported as not linkable and keeps running in the browser.
- **Writing cookies back into the browser profile.** The jar flows one way,
  browser to HTTP; a session cookie rotated by the HTTP runner is not pushed
  back.
