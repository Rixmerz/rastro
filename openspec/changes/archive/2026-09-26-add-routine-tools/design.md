# Design: routines as agent tools

## 1. The manifest lives in the flow file

```yaml
name: publish-file
tool:
  description: Publish a local file as a resource in a course section
  session: school            # daemon session the routine runs in
  effect: write              # read | write | destructive
  allowWrite: [lms.example.edu]
  allowUpload: [~/Documents]
  login: login-school        # optional flow run once when a login page shows up
  loginWhen: { url: /login/* }
params:
  course:  { type: integer, description: numeric course id, example: 12345 }
  section: { type: integer, description: section number }
  name:    { type: string,  description: name the resource shows under }
  file:    { type: path,    description: local file to publish }
steps: ...
```

A separate registry file was rejected: it drifts from the flow it describes, and
renaming a flow would leave a dangling entry. One file means one hash, which is
what probation keys on.

The tool name is the **file's basename**, not `name:`. Two recorded files on the
reference machine both say `name: recorded`. Names that collide with Rastro's
own tools (`rastro_*`) are rejected.

## 2. Probation is content-addressed

`rastroHome()/routines/verified/<sha256 of file bytes>` exists once a run of
exactly those bytes succeeded — through `routineRun` or plain `flow run`, both of
which happen in the daemon. Nothing to invalidate: an edit changes the hash, and
the new content starts unverified. A rename or a move keeps the verification,
because the bytes did not change. Last-run bookkeeping goes to
`routines/runs/<basename>.json` and is informational only.

State lives under `rastroHome()`, not next to the flow, because the flows
directory is hand-authored source (see `flowsDir()`), and a verification marker
committed to git would claim a run that happened on another machine.

## 3. Two stable tools plus one tool per verified routine

`rastro_routines` and `rastro_routine_run` are always present (unless
`--routines=off`). Dedicated tools are an optimisation for clients that re-read
the list: the SDK sends `notifications/tools/list_changed` on every
register/update/remove, but whether a given client re-fetches mid-session is not
something the server can know. With the stable pair, a routine added mid-session
is still runnable.

`--routines=catalog` keeps only the stable pair, for when N schemas on every
request cost more than they save. `--routines-only` drops the raw browser tools
entirely: an agent that can do nothing but run vetted routines.

## 4. Running: the daemon owns the run

`routineRun` is an RPC, not an orchestration in the MCP process, because:

- the allowlists must be **scoped to the run**. `open` on a live session
  *replaces* the lists, so doing it from outside would leave the agent's session
  with the routine's narrower lists afterwards. The daemon saves, applies and
  restores them in a `finally`.
- only the daemon knows which requests the run sent, which is what decides
  whether a retry is safe.

Login handling: when a step fails and the page matches `loginWhen`, and **no
write request has been sent**, the daemon runs the `login` flow once and reruns
the routine from the start. If a write went out, it stops and says so.

A write request is any non-GET/HEAD/OPTIONS request attributed to the run's
actions. That is conservative (a search form that POSTs counts), which is the
right direction to err in.

## 5. The client timeout is not a failure

`call()` times out at 120 s by default and a timeout does not stop the daemon.
An agent that reads "timed out" as "failed" and retries would duplicate a write.
`rastro_routine_run` calls with a long timeout (`RASTRO_ROUTINE_TIMEOUT_MS`,
default 15 min) and, if even that expires, answers that the routine **may still
be running** and must not be retried until `rastro_history` shows how it ended.

## 6. Result shape

Success, one line per fact:

```
publish-file ok · 9 steps
→ https://lms.example.edu/course/view.php?id=12345
writes: POST /course/modedit.php 303 → /course/view.php?id=12345
evidence: #41-#49
```

Failure:

```
publish-file failed at step 5: element not found: link "File"
page: https://lms.example.edu/course/view.php?id=12345
writes sent: none, safe to retry
evidence: #41-#45 · inspect with rastro_view, rastro_effects 45
```

`--json` / structured content carries the same fields.

## 7. Parameter typing

Types validate and coerce on both sides: the MCP tool schema is generated from
them (zod), and `routineRun` validates again in the daemon, since the CLI and
the generic tool bypass the MCP schema. Values still reach the flow as strings.
`path` must be absolute (a leading `~/` is expanded); the upload sandbox still
applies on top. Parameters that come from the keyring (`from: secret:...`) are
**absent from the input schema**, so an agent can neither see nor override them.

## 8. Directories

`RASTRO_FLOWS` (colon-separated) if set; otherwise `./.rastro/flows` when it
exists, then `~/.config/rastro/flows`. The first directory wins a name
collision and the loser is listed as shadowed. `*.link.yaml` files (the HTTP
recipes of the flow-link change) are not flows and are skipped.

## 9. Lint, not refusal

`rastro routine list` and the catalog flag, without refusing: a css locator
with a generated id (`#ext-gen51`, `#yui_...`), a parameter without a
description, a flow still named `recorded`. They are warnings because a human
may know better; probation is the hard gate.
