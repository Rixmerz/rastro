# Design

## Shape of the crawl

A **state** is what a person would call "the same screen": the URL template
(path with numeric/hex/uuid segments normalised, query values dropped) plus a
hash of the view's structure (regions and interactive items by role and name,
names with digits normalised). Text that changes between visits (counters,
timestamps) does not create new states.

An **element key** is `role + normalised name + region + ordinal`, not a ref:
refs are per snapshot and do not survive a reload.

The **frontier** is a priority queue of `(state, elementKey)` ordered by the
state's depth, then by discovery order. Every worker pops the shallowest item,
so all branches advance one level before any goes deeper — the "water level".
`--depth` caps the level, `--budget` caps total actions, `--time` caps wall
time; whatever is left in the frontier is written to the map as `unexplored`.

## Reaching a state

Each state stores the shortest **path** to it: the nearest URL-addressable
ancestor plus the element keys clicked from there. To work on a state, a worker
navigates to the ancestor URL and replays the path, checking the structure hash
at the end. A path that no longer lands on the state (the site changed, or the
state needed data a blocked write would have created) marks the state
`unreachable` with the reason, and the crawl moves on.

After activating an element the worker does not go back with history: it
re-reaches the source state the same way. `back` is cheaper but lies on SPAs;
re-reaching is honest and the path is usually short.

## Activating an element

Through `EngineCore.runAction`, so every activation is a normal action with
`source: 'flood'`: attribution, effects, snapshots, masking and the write
guard all apply unchanged.

- link / button / tab / menuitem / checkbox / switch: click.
- combobox / listbox: select the first non-default option.
- textbox in a form: filled with neutral filler by input type (`test@example.test`,
  `1`, `flood`), never a secret; the form is then submitted once. Password
  fields are left empty.
- External links (another registrable domain) are recorded, never followed.
- Denylist by name (`logout|sign out|delete|remove|pay|buy|unsubscribe|cancel
  account`, plus Spanish equivalents), extendable with `--skip` and
  overridable with `--include`.

## Pipes (workers)

The trace's causal attribution relies on one action at a time per page, so
parallelism is across sessions, not tabs: workers are daemon sessions
`flood-<name>-w1..wN`, each with its own profile dir, seeded at start with the
seed session's cookies and storage (the user logs in once in the seed session).
A coordinator in the daemon owns the frontier and the rate limiter; workers
only pop, act and report. A worker that crashes is relaunched and its item is
requeued once.

## Rate and backoff

A token bucket per registrable host shared by all workers (`--rate`, default
2/s), with ±30% jitter, and a per-host concurrency cap (default 2). On 429 or
503 the host's rate halves and honours `Retry-After`; it recovers slowly after
a quiet minute. `detectBlocked` runs after every action as today; a `captcha`
or `bot-block` result pauses the host, records the state as `blocked:<reason>`
and, after two in a row, stops flooding that host. `robots.txt` Disallow rules
are respected unless `--ignore-robots`.

## Blocked writes keep their shape

Today a blocked write records method, URL and host. Flood needs the body to
say what a form would send, so the write guard hands `request.postData()` to
the recorder before aborting, under the same masking and size cap as an
allowed write. This is a small change to `installWriteGuard` and benefits
normal sessions too (`effects` can show what a blocked click tried to send).

## The map

`map.json`: `{ seed, startedAt, finishedAt, limits, states[], edges[],
endpoints[], blocked[], unexplored[], external[] }`. Endpoints are grouped by
`method + host + path template`; each keeps statuses seen, content types, a
sample request id per worker, the triggering `(state, elementKey)` pairs, and
whether any instance was a blocked write.

`map.md` is the agent-facing view, sized to a token budget (`--md-budget`,
default ~4k tokens): the state tree indented by level, then the endpoint index
sorted writes-first, then blocked/unreachable. Every line carries a short id
(`S12`, `E7`) that `rastro flood show` expands. Page-originated strings are in
«» as everywhere else.

## Why not reuse `flow` / recording

A flow is a path someone chose. Flood is all paths nobody chose; it produces
candidates for flows. What it reuses is the action pipeline, the trace and the
investigation commands, which is exactly what makes the map drillable.
