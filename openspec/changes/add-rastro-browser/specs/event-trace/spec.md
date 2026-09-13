## Purpose

Records everything that happens in a browser session as an append-only causal trace so an agent can investigate any action on demand without carrying that detail in context.

## ADDED Requirements

### Requirement: Append-only trace
The system SHALL record, with monotonic timestamps, agent and human actions (start and end), requests, responses, failures, redirects, WebSocket open/close and frame counts, top-level and frame navigations, console messages, uncaught exceptions, dialogs, downloads, tabs opened and closed, cookie and storage diffs per action, DOM mutation counts per action, and blocked writes. Events SHALL never be deleted during a session.

#### Scenario: Trace survives the browser
- **WHEN** the browser crashes and is relaunched
- **THEN** all events recorded before the crash are still returned by `rastro trace`

### Requirement: Attribution
Each event SHALL be classified as `attributed` to exactly one action, `background`, or `unattributed`. An event starting inside an action's window SHALL be attributed when its initiator is the document parser, a script, a preload, a redirect of an attributed request, or the navigation caused by the action. It SHALL be `background` when its resource type is ping/beacon/CSP report, its initiator stack contains a `setInterval` frame, its URL template (path with numeric and hex segments and query values normalized) recurred at least 3 times before the action with regular spacing, or its host is a known analytics host. Events inside the window from workers or other targets, or with no initiator information, SHALL be `unattributed`. On the bundled fixtures (login redirect, polling, tracking) at least 90% of requests SHALL be classified as the fixture declares.

#### Scenario: Polling is background
- **WHEN** a page polls `/api/poll?t=123` every 300 ms and the agent clicks a button that posts `/api/do`
- **THEN** `/api/do` is attributed to the click and the polling requests inside its window are background

#### Scenario: Redirect chain
- **WHEN** a form post answers 302 to `/panel`
- **THEN** the post, the redirect and the `/panel` document request are attributed to the same action

#### Scenario: Nothing is dropped
- **WHEN** an event cannot be classified
- **THEN** it is stored as unattributed and listed by `rastro effects <id> --all`

### Requirement: Investigation commands
The system SHALL provide: `detail <ref>` (role, name, element tag, link href, form method and action, input type, test id, a CSS path, and whether it is disabled); `history` (one line per action: id, source, kind, target name, masked value, duration, navigation, error counters); `effects <id>` (navigation, attributed requests with id, method, path and status, cookie and storage diffs, console errors, dialogs, tabs, downloads, blocked writes, and counts of hidden background and unattributed events; `--all` lists them); `trace` filtered by `--action`, `--since`, `--type`, `--bg` with `--limit`; `request <id>` (method, URL, status, timing, relevant request and response headers, initiator; `--body` response body truncated to 1 KB; `--full` writes the body to a file; `--curl` prints an equivalent curl command); `snapshot <id> --before|--after`; `screenshot`; `console`; `cookies`; `storage`; `tabs`; `eval`.

#### Scenario: Investigate a failed request
- **WHEN** the agent runs `rastro effects 4` and then `rastro request r31 --curl`
- **THEN** it sees `r31 GET /api/cart 500` in the effects and receives a curl command that reproduces the request with secrets masked

#### Scenario: Snapshot before an action
- **WHEN** the agent runs `rastro snapshot 4 --before`
- **THEN** it receives the minimal view of the page as it was immediately before action 4

### Requirement: Exports
`rastro export` SHALL write HAR 1.2 (`har`), Chrome Trace Event Format JSON loadable by Perfetto and the DevTools Performance panel (`perfetto`, actions as duration events and attributed events linked to their action with flow events), and a Playwright trace.zip (`pw-trace`, only when the session was opened with `--pw-trace`). Each export SHALL print the written path.

#### Scenario: Perfetto export
- **WHEN** the agent runs `rastro export perfetto`
- **THEN** a JSON file with a `traceEvents` array is written, each action appears as a begin/end pair and each attributed request has a flow event pointing to its action

#### Scenario: HAR export
- **WHEN** the agent runs `rastro export har`
- **THEN** a HAR 1.2 file containing every recorded request with status and timings is written
