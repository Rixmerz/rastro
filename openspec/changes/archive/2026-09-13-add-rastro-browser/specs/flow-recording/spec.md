## Purpose

Lets a human record a flow in a visible browser, and lets an AI replay, resume, extend and convert recorded or agent-performed flows into scripts.

## ADDED Requirements

### Requirement: Locator bundle on every action
Every recorded action, from the agent or a human, SHALL store a locator bundle with the role and accessible name, visible text, test id, element id, label, placeholder and a CSS path when available, so the action can be replayed after refs expire.

#### Scenario: Replay after reload
- **WHEN** a flow built from agent actions is run in a fresh session
- **THEN** each step resolves its element from the locator bundle, trying role and name first and the CSS path last

### Requirement: Human recording
`rastro record start [url]` SHALL open a visible browser with a persistent profile and record the human's clicks, text entry (final value on change), selections, checks, Enter key presses, form submissions and navigations as actions with source `human`, in the same trace and with the same attribution as agent actions. Password values SHALL be masked at capture time. `rastro record stop [--save <file>]` SHALL end recording and optionally save the recorded actions as a flow.

#### Scenario: Record a login
- **WHEN** a human types an email and password and clicks "Entrar" during a recording
- **THEN** `rastro history` shows three human actions, the password masked, and `rastro effects` on the click shows the login post

### Requirement: Flow format
A flow SHALL be a YAML document with `name`, optional `params` (with a `secret` marker), and ordered `steps`. Step kinds SHALL be `open`, `goto`, `click`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `hover`, `wait` (text, url or ms), `assert` (text, url, or request method/path/status class), and `if` (text, url or request condition) with `then` and optional `else` step lists. Action steps SHALL carry a `target` locator bundle and MAY carry `expect` (url, requests) derived automatically from the effects recorded for that step. Values SHALL support `{{param}}` substitution. `rastro flow save <file> [--from <id>] [--to <id>]` SHALL build a flow from the session's actions.

#### Scenario: Expectations derived from recording
- **WHEN** a recorded click caused a navigation to `/panel` and an attributed `POST /api/login` answered 200
- **THEN** the saved step has `expect: { url: /panel, requests: ["POST /api/login 2xx"] }`

### Requirement: Run, resume and continue
`rastro flow run <file>` SHALL execute steps in the current session, verify expectations after each quiet window and stop at the first failing step with its index and reason. `--from <n>` SHALL start at step n. `--param k=v` SHALL substitute parameters. `rastro record start --continue <file> --at <n>` SHALL run steps before n and then start human recording, appending new steps after step n-1 when saved.

#### Scenario: Failing expectation
- **WHEN** step 3 expects `POST /api/login 2xx` and the server answers 401
- **THEN** the run stops with `step 3 failed: expected POST /api/login 2xx, got 401`

#### Scenario: Conditional step
- **WHEN** a step is `if: { text: "Aceptar cookies" }` with a click in `then`
- **THEN** the click runs only when that text is visible

### Requirement: Export and import
`rastro flow export <file> --playwright` SHALL generate a `@playwright/test` spec using role, label, text, test id or CSS locators in that order of preference, turning expectations into URL assertions and response waits, and conditions into visibility checks. `rastro flow import <chrome-recorder.json>` SHALL convert a Chrome DevTools Recorder recording (navigate, click, change, keyDown, waitForElement steps with aria, css, xpath, text and pierce selectors) into a flow.

#### Scenario: Export a login flow
- **WHEN** a three-step login flow is exported
- **THEN** the generated spec uses `page.getByRole('button', { name: 'Entrar' })`, waits for the login response, and asserts the `/panel` URL

#### Scenario: Import Chrome recording
- **WHEN** a Chrome Recorder JSON with a navigate step and a click with selectors `aria/Entrar[role="button"]` and `#submit` is imported
- **THEN** the flow has an `open` step and a `click` step whose target has role `button`, name `Entrar` and CSS `#submit`
