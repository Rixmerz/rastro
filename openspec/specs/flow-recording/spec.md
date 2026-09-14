# flow-recording Specification

## Purpose
Lets a human record a flow in a visible browser, and lets an AI replay, resume, extend and convert recorded or agent-performed flows into scripts.

## Requirements

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

### Requirement: Secret references in flow parameters
A flow parameter SHALL be able to name a vault entry instead of carrying a
value, written as `secret:<name>` either in the flow's `params` block or in a
`--param <key>=secret:<name>` argument. The daemon SHALL resolve the reference
against the keyring at run time, SHALL register the resolved value with the
secret registry so it is masked in all output, and SHALL NOT pass it through
the command line. A reference naming an entry that does not exist SHALL abort
the run before the first step, naming the missing entry.

#### Scenario: Flow runs with a vault password
- **WHEN** a flow declares `password: { secret: true, from: "secret:example.password" }` and the user runs `rastro flow run login.yaml`
- **THEN** the step fills the stored value and no output of that run contains it

#### Scenario: Missing entry fails early
- **WHEN** the referenced entry is not in the keyring
- **THEN** the run aborts before the first step with an error naming `example.password`

### Requirement: Default flow home
`rastro flow save` and `rastro flow run` SHALL accept a bare name in addition
to a path. A bare name SHALL resolve against `./.rastro/flows/` when that
directory exists in the working directory, and otherwise against
`~/.config/rastro/flows/`, in both cases with a `.yaml` extension appended when
absent. `save` SHALL create the target directory with owner-only permissions.
An argument containing a path separator or a `.yaml` extension SHALL keep
being treated as a path, unchanged.

#### Scenario: Save and run by name
- **WHEN** the user runs `rastro flow save login-example` and later `rastro flow run login-example`
- **THEN** the flow is written to and read from the flow home, without either command naming a directory

#### Scenario: A path is still a path
- **WHEN** the user runs `rastro flow save ./tmp/x.yaml`
- **THEN** the file lands at that path and the flow home is not involved

### Requirement: Upload as a flow step
A flow SHALL support an `upload` step carrying a target and a value, where the
value is the path of a local file. The step SHALL apply the same upload sandbox
as an agent-issued `upload`: a path outside the session's upload directories
SHALL be refused, with symlinks resolved before the check. The value SHALL be
substitutable from a parameter, so one flow can attach different files.

#### Scenario: Uploads a file given at run time
- **WHEN** a flow has an `upload` step with value `{{archivo}}` and is run with `--param archivo=/allowed/dir/report.pdf`
- **THEN** the file is attached and the step is recorded like any other action

#### Scenario: The sandbox still applies
- **WHEN** the same flow is run with `--param archivo=/etc/hostname`
- **THEN** the step fails with `upload outside allowed dirs` and nothing is attached

### Requirement: Recording a file input yields a parameter
Capturing an interaction with an `<input type="file">` SHALL record an `upload`
step whose value is a parameter reference, and SHALL declare that parameter in
the saved flow. The browser's placeholder path (`C:\fakepath\<name>`) SHALL
NEVER be written as the step's value, because it is not a path to anything. The
recorded file's name SHALL be preserved as the parameter's `description`.

#### Scenario: The placeholder path is not saved
- **WHEN** a human picks `Instrucciones.pdf` in a file input while recording, and the flow is saved
- **THEN** the step is an `upload` whose value is a parameter reference, the saved flow contains no `fakepath`, and the parameter's description names `Instrucciones.pdf`

#### Scenario: Running without the file is refused up front
- **WHEN** that flow is run without supplying the parameter
- **THEN** the run fails naming the missing parameter, before the first step

### Requirement: Documented flow parameters
A flow parameter SHALL accept an optional `description`, carried through saving
and re-parsing, so a flow can say what a caller is expected to supply.

#### Scenario: Description survives a round trip
- **WHEN** a flow declaring `archivo: { description: "the file to attach" }` is saved and parsed again
- **THEN** the description is still there
