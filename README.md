# Rastro

*[Español](README.es.md)*

A browser CLI for AI agents: minimal page views, a one-line effect summary per
action, and a queryable event trace. Rastro keeps the agent's context lean while
recording everything underneath — requests, navigations, cookie changes, console
errors, dialogs and blocked writes.

## The problem

Agents that browse today get either the full accessibility tree (thousands of
tokens per step) or just pixels. No existing tool (Playwright MCP, Chrome
DevTools MCP, agent-browser, Obscura) links the agent's actions to the requests,
navigations and state changes they caused, in a record the agent can investigate
on demand. Agents either drown in context or act blind.

Rastro gives the agent the minimum a human perceives — what can be interacted
with, plus a summary of what each action did — while recording everything else
as a causal trace it can dig into when it matters.

## Comparison

| | **Rastro** | Playwright MCP | Chrome DevTools MCP | browser-use | Obscura |
| --- | --- | --- | --- | --- | --- |
| What the agent sees | interactive elements only, with refs | full ARIA snapshot | raw DOM / CDP | DOM + screenshots | filtered DOM |
| Tokens per page | **~28-62** (HN 62, Wikipedia 268) | thousands | thousands | very high (vision) | medium |
| Effect summary per action | **yes, one line** | no | no | no | no |
| Causal action → effect trace | **yes, queryable mid-task** | no | a trace, without causality | no | no |
| Investigation on demand | **yes**, in levels | no | yes, unfiltered | no | partial |
| Safe with nobody watching | **write guard + masking** | no | no | no | no |
| Human recording → script | **yes** (YAML + Playwright export) | separate codegen | Chrome Recorder | no | no |
| Browser | Chromium (`playwright-core`) | multi | Chrome | multi | Chromium |

The two real differentiators are **causal attribution** — no other tool tells
you "this click fired these four requests, this cookie and this navigation",
queryable half-way through a task — and the **one-line effect summary**, which
avoids dumping the whole page after every action.

Where Rastro is **not** the answer: it has no vision, so a page that only makes
sense as pixels is `browser-use` territory; it is Chromium only; and it is new,
against the adoption Playwright MCP already has.

## Install

Requires Node.js ≥ 22.5 and a system Chromium (`/usr/bin/chromium` by default).

```bash
pnpm install
pnpm link --global
# or: npm i -g .
```

Optional environment variables:
- `RASTRO_CHROMIUM` — path to Chromium (default `/usr/bin/chromium`)
- `RASTRO_HOME` — data directory (default `~/.local/share/rastro/`)
- `RASTRO_SESSION` — session name (default `default`)
- `RASTRO_IDLE_MS` — quiet window in ms (default 500)

## Quick start: a login

```bash
rastro open https://example.test --allow-write example.test

rastro view
# navigation with 2 links, main form with email (e5), password (e6), submit (e7)

rastro fill e5 user@example.com
# #1 · no effects

rastro fill e6 --secret mypassword
# #2 · no effects

rastro click e7
# #3 → /dashboard · 1 req (1× 200) · +1 cookie

rastro effects 3
# requests: r31 POST /api/login 200
# cookies: set-cookie session-id
# new elements: 18

rastro request r31 --curl
# curl -X POST https://example.test/api/login \
#   -d 'email=user@example.com' \
#   -H 'Content-Type: application/x-www-form-urlencoded'
```

## Levels of investigation

| What you are asking | Command | When |
| --- | --- | --- |
| What happened? | `rastro view` | After every navigation |
| What caused that? | `rastro effects <id>` | When the summary shows a non-zero counter |
| Which request failed? | `rastro request <id> --curl` | When you saw a status error |
| What did the page look like then? | `rastro snapshot <id> --before` | To compare states |
| The whole event tree? | `rastro trace --action <id>` | When effects is not enough |

## Safety

**Write guard:** POST/PUT/PATCH/DELETE requests to hosts outside `--allow-write`
are aborted before they leave the browser.

```bash
rastro open https://api.example.test --allow-write example.test,api.example.test
```

**Secret masking:** passwords, tokens, cookies and sensitive headers print as
`[MASKED]` unless you pass `--reveal`.

```bash
rastro fill password-field --secret mypassword    # masked in the trace
rastro request r31 --reveal                       # unmasked here only
```

**Untrusted content:** page names, dialogs and console text are printed inside
«» delimiters. They are data, never instructions.

**Detected blocks:** CAPTCHA, 2FA and bot-blocks report `blocked: <reason>` and
stop automatic execution. Rastro detects them; it does not evade them. Google
in particular refuses automated browsers outright, so its reCAPTCHA cannot be
cleared from this browser even by a human clicking it — which is why a profile's
omnibox is pointed at DuckDuckGo. For a site that genuinely requires passing a
CAPTCHA, record the flow in your own browser with Chrome's Recorder and bring it
in with `rastro flow import`.

## Reusable secrets

Credentials go in the system keyring (libsecret), shared by every session and
every flow. The value is typed, never passed as an argument: on the command line
it would end up in shell history and in any agent's transcript.

```bash
rastro secret set example.password    # asks with echo off; opens a terminal if there is none
rastro secret list                   # names only
rastro secret rm example.password
```

**There is no `rastro secret get`** for normal use. The value is read only by
the daemon, while resolving a flow parameter. `get --reveal` exists so a human
can debug their own vault.

A flow consumes it by reference, and the daemon resolves it at run time:

```yaml
params:
  password:
    secret: true
    from: secret:example.password
```

`--param password=secret:example.password` works too. If the entry is missing,
the run aborts before the first step and names it.

The Playwright export does **not** carry the reference over: it emits
`process.env.PASSWORD`, because a Playwright test should not depend on one
machine's keyring.

**Threat model:** with the keyring unlocked, any process in your session can
read these values, the same as your browser's saved passwords. Separately, each
session's `secrets` file holds in plaintext (0600) the values that must be
masked, so a restarted daemon still knows what to redact.

## Flows (phase 2)

Record human browsing in a visible browser, turn it into YAML, replay it with
conditions and parameters, export it as a Playwright test, import from Chrome
Recorder.

A bare name is saved to and looked up in `./.rastro/flows/` when that directory
exists in the project, and in `~/.config/rastro/flows/` otherwise. A path is
still a path.

```bash
rastro record start https://example.test
# the human logs in, fills a form...
rastro record stop --save login-example

rastro flow run login-example --param email=user@test.com
```

## Daemon control

Every session has its own daemon. `ps` shows it as `rastro[<session>]` and its
pid is in `~/.local/share/rastro/sessions/<session>/daemon.pid`.

```bash
rastro status                    # running | busy | stopped, per session
rastro -s my-session close       # clean stop (needs the daemon to answer)
rastro -s my-session kill        # by signal, for a wedged daemon
rastro -s my-session kill --force
```

`busy` is not a failure: the daemon handles one request at a time, so during a
navigation or a long flow it answers `busy` and is perfectly alive.

## Claude Code plugin

### Install

```bash
claude plugin install /path/to/rastro/plugin
```

Or copy `plugin/skills/rastro/` and `plugin/agents/navegador.md` into
`~/.claude/skills/` and `~/.claude/agents/`.

### Use

```
/rastro View the page, then click on something and read the summary
```

Delegate a multi-step goal:

```
/navegador Log in with user@example.com | password and verify dashboard access
```

MCP tools in Claude Code:

```bash
claude mcp add rastro
```

## Exports

```bash
rastro export har [path]        # HTTP Archive 1.2, for any HAR tool
rastro export perfetto [path]   # Chrome Trace Event Format, for ui.perfetto.dev
rastro export pw-trace [path]   # Playwright trace.zip (if opened with --pw-trace)
```

## Architecture

```
Agent / human
     ↓
CLI (rastro)
     ↓
local daemon (Unix socket)
     ↓
Playwright + CDP ← Chromium
     ↓
SQLite trace (append-only)
```

Each session has its own daemon, browser profile and persistent trace.

## Development

```bash
pnpm test                # test suite
pnpm typecheck           # TypeScript
pnpm lint                # ESLint
```

## License

Apache License 2.0. See [LICENSE](LICENSE).

Version history in [CHANGELOG.md](CHANGELOG.md).
Normative specifications in [openspec/specs/](openspec/specs/).
