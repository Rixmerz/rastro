# agent-browsing Specification

## Purpose
Lets an AI agent browse the web autonomously while seeing only what a human perceives: what can be interacted with, and a one-line outcome of each action.

## Requirements

### Requirement: Sessions
The system SHALL keep a named browser session alive across CLI invocations, isolated from other sessions, with its own browser profile and trace. The default session name SHALL be `default`. A session SHALL run headless unless opened for human recording or with an explicit headed flag.

#### Scenario: Open and reuse a session
- **WHEN** the agent runs `rastro open https://example.test` and then `rastro view`
- **THEN** the second command observes the page opened by the first without relaunching the browser

#### Scenario: Two sessions do not share state
- **WHEN** the agent opens `-s a` on one URL and `-s b` on another
- **THEN** `rastro -s a view` shows only the first page and each session has its own trace

#### Scenario: Close a session
- **WHEN** the agent runs `rastro close`
- **THEN** the browser exits, the trace remains on disk, and a later `rastro trace` for that session still returns its events

### Requirement: Minimal view
`rastro view` SHALL print the page URL and title followed by only interactive elements (links, buttons, text inputs, comboboxes, checkboxes, radios, switches, sliders, tabs, menu items, options in open listboxes), each with a ref, role and accessible name, grouped by landmark region (banner, navigation, main, complementary, contentinfo, dialog, form, other). A region with more than 8 interactive elements SHALL be collapsed to a count by role unless requested with `--region`. Link URLs SHALL be omitted unless `--urls` is given. Headings SHALL NOT be listed except the page title line. `--all` SHALL write the full accessibility tree to a file and print its path.

#### Scenario: Login page
- **WHEN** a page has a navigation with 2 links and a main form with an email field, a password field and a submit button
- **THEN** the view lists `main:` with three refs and `nav:` with two links, and no link URLs

#### Scenario: Large region collapsed
- **WHEN** the navigation contains 42 links
- **THEN** the view prints `nav: 42 links` with a hint to expand it, and `rastro view --region nav` lists all 42 with refs

#### Scenario: Find by text
- **WHEN** the agent runs `rastro view --find "Entrar"`
- **THEN** only interactive elements whose name contains the text are listed

### Requirement: Stable refs
A ref SHALL identify the same element across consecutive views while that element stays attached to the document. Using a ref that no longer resolves SHALL fail with an error telling the agent to run `rastro view` again.

#### Scenario: Stale ref
- **WHEN** the agent acts on ref `e12` after a navigation removed that element
- **THEN** the command fails with `ref e12 not found; run rastro view` and no action is recorded as performed

### Requirement: Actions with effect summary
`rastro act <ref> <kind> [value]` SHALL support `click`, `dblclick`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `hover`, `scroll` and `upload`. Navigation SHALL be available as `open`, `goto`, `back`, `forward` and `reload`. Every action and navigation SHALL receive a sequential action id and SHALL return, after the page becomes quiet, exactly one line containing: the action id, the new URL if the top-level document navigated, the count of attributed requests, failed or 4xx/5xx responses, cookies added/changed/removed, net new interactive elements, console errors, dialogs, new tabs, downloads, blocked writes and the blocked state if any. Zero-valued counters SHALL be omitted.

#### Scenario: Click that navigates and fails a request
- **WHEN** clicking the submit button posts a login, redirects to `/panel` and `/panel` requests `/api/cart` which answers 500
- **THEN** the output is one line like `#4 → /panel · 9 req (1× 500) · +2 cookies · 18 new elements · console: 1 error`

#### Scenario: Action with no visible effect
- **WHEN** the agent hovers an element that triggers nothing
- **THEN** the output is `#5 · no effects`

### Requirement: Quiet window
An action SHALL be considered finished when no attributable request is pending and no DOM mutation happened for the quiet period (default 500 ms), or when the maximum window (default 5000 ms) elapses. Long-lived connections (WebSocket, EventSource) SHALL NOT keep the window open. Both limits SHALL be configurable per session.

#### Scenario: Page with polling
- **WHEN** a page polls an endpoint every 300 ms and the agent clicks a button that fetches once
- **THEN** the action returns within the maximum window and the summary counts only the button's request

### Requirement: Autonomous policies
With no human present, the system SHALL apply policies and report each occurrence in the action summary: JavaScript dialogs accepted by default (dismissed with `--dialogs dismiss`); new tabs and popups recorded and not focused; downloads saved to the session downloads directory; every wait bounded by a timeout (default 30 s); a crashed page or browser relaunched with the trace preserved. When the page shows a CAPTCHA, a two-factor challenge or an explicit bot block, the action SHALL report `blocked: <reason>` and SHALL NOT retry.

#### Scenario: Confirm dialog
- **WHEN** a click opens `confirm("¿Seguro?")`
- **THEN** the dialog is accepted and the summary includes `dialog «¿Seguro?» accepted`

#### Scenario: Popup
- **WHEN** a click opens a new tab
- **THEN** the summary includes `opened tab t2`, the current tab stays active, and `rastro tabs` lists it

#### Scenario: CAPTCHA
- **WHEN** after an action the page contains a reCAPTCHA, hCaptcha or Turnstile challenge
- **THEN** the summary includes `blocked: captcha`

#### Scenario: Timeout
- **WHEN** an action target never becomes actionable
- **THEN** the command fails after the timeout with the reason and the attempt is recorded in the trace
