# Flows: record, run, resume, replay, export to Playwright, import from Chrome

A flow is a YAML file of steps that can be recorded by a human in a visible browser, run by an agent, resumed mid-way, and exported to a Playwright test.

## Recording a flow

Start a visible browser with human recording:

```bash
rastro record start https://example.test
# Browser window opens and starts recording
# User logs in, fills a form, navigates, clicks buttons...
rastro record stop --save login.yaml
```

Each human action (click, type, select, check, form submit, navigation) is recorded with:
- Role and accessible name of the target element
- Final value (for text input)
- Source marked as `human`
- Automatic expectations from the effects (URL, request methods/status)

Passwords are masked at capture time.

## Flow format (YAML)

A complete login flow example:

```yaml
name: Login with email and password

params:
  email:
    default: ""
  password:
    secret: true

steps:
  - open: https://example.test/login

  - click:
      role: button
      name: "Accept cookies"
    expect:
      requests: ["GET / 2xx"]

  - fill:
      role: textbox
      name: "Email"
    value: "{{email}}"

  - fill:
      role: textbox
      name: "Password"
    value: "{{password}}"

  - click:
      role: button
      name: "Entrar"
    expect:
      url: /dashboard
      requests: ["POST /api/login 2xx"]

  - wait:
      text: "Welcome"

  - assert:
      url: /dashboard
      text: "Welcome"

  - if:
      text: "Accept tracking"
    then:
      - click:
          role: button
          name: "Accept"
```

The step kind is the step's own key (`open:`, `click:`, `fill:`, ...), not a separate `kind:` field — the value under that key is the target/URL/condition the kind expects. `target`, `value`, `expect`, `then`, `else`, `id`, `note` are sibling fields at the same level.

### Step kinds

| Kind | Shape | Effect |
| --- | --- | --- |
| `open: url` | value is the URL string | Navigate to URL |
| `goto: url` | value is the URL string | Navigate to URL (same as open within a session) |
| `click: target` | value is a target | Click an element |
| `dblclick: target` | value is a target | Double-click |
| `fill: target`, `value:` | target + sibling `value` | Type text into an input (replaces content) |
| `type: target`, `value:` | target + sibling `value` | Type text (appends to content) |
| `select: target`, `value:` | target + sibling `value` | Select an option in a dropdown |
| `check: target` | value is a target | Check a checkbox |
| `uncheck: target` | value is a target | Uncheck a checkbox |
| `hover: target` | value is a target | Hover over an element |
| `press: key`, `target:` | value is the key string, optional sibling `target` | Press a key (Enter, Escape, etc.) |
| `back: true` | literal `true` | Navigate back |
| `forward: true` | literal `true` | Navigate forward |
| `reload: true` | literal `true` | Reload page |
| `wait: {...}` | `text` / `url` / `ms` | Wait for text, URL change, or milliseconds |
| `assert: {...}` | `text` / `url` / `request` | Assert text, URL, or request matched |
| `if: {...}`, `then:`, `else:` | condition + sibling step lists | Conditional execution |

### Target locator

A `target` is a bundle to identify an element:

```yaml
target:
  role: button              # ARIA role (preferred)
  name: "Entrar"            # accessible name (preferred)
  text: "Click me"          # visible text
  id: "submit-btn"          # element id
  label: "Email"            # label text (for inputs)
  placeholder: "user@..."   # input placeholder
  css: "#form .btn"         # CSS selector (fallback)
```

Rastro tries role+name first, then visible text, then other fields, finally CSS. The recorded locator bundle includes all matches found.

### Expectations

The `expect` block derived from a recorded action:

```yaml
expect:
  url: /panel               # assert top-level document URL
  requests:
    - "GET /api/user 2xx"   # assert request method, path, status class
    - "POST /api/save 2xx"  # method, path and a 3-digit status or an Nxx class — all three are required
```

`expect` (and the `if`/`assert` condition below) accepts only the fields shown — an unrecognized field is rejected. Expectations are optional. Rastro verifies them after the quiet window and stops at the first failure.

### Conditional steps

```yaml
- if:
    text: "Accept cookies"  # run then/else based on visibility
  then:
    - click:
        role: button
        name: "Accept"
  else:
    - click:
        role: button
        name: "Continue"
```

Condition can be `text`, `url`, or `request: "METHOD path STATUSCLASS"` (same three-token pattern as `expect.requests`).

### Parameters and substitution

```yaml
name: Fill form with a param

params:
  email:
    default: ""
  password:
    secret: true            # masked in trace and output

steps:
  - fill:
      role: textbox
      name: Email
    value: "{{email}}"      # substituted at runtime
```

A param entry accepts only `secret` and `default` — no `description` field.

Run with `rastro flow run login.yaml --param email=user@test.com --param password=secret`.

## Running a flow

```bash
rastro flow run login.yaml
# Output: step 1/5 ✓ navigated to /login
#         step 2/5 ✓ clicked Accept cookies
#         step 3/5 ✓ filled Email
#         step 4/5 ✓ filled Password
#         step 5/5 ✓ clicked Entrar, navigated to /dashboard
```

On failure:

```bash
rastro flow run login.yaml --param email=wrong@test.com
# Output: step 5/5 failed: expected POST /api/login 2xx, got 401
```

### Resume from a step

```bash
rastro flow run login.yaml --from 3     # skip to step 3 and continue
```

### Parametrize at runtime

```bash
rastro flow run login.yaml \
  --param email=alice@test.com \
  --param password=secret123
```

## Recording and continuing

Record a flow, save it, inspect it, then continue recording from a specific step:

```bash
rastro record start https://example.test
# User logs in and saves
rastro record stop --save flow.yaml

# ... inspect the flow, edit it if needed ...

rastro record start --continue flow.yaml --at 5
# Runs steps 1–4, then starts recording new steps from step 5 onward
rastro record stop
# Appends new steps to the saved flow
```

## Export to Playwright

```bash
rastro flow export login.yaml --playwright --out login.spec.ts
```

Generates a `@playwright/test` spec file with:
- Role, label, and name locators (CSS path as fallback)
- Expectations as URL assertions and response waits
- Conditional visibility checks

Example output:

```typescript
import { test } from '@playwright/test';

test('Login with email and password', async ({ page }) => {
  // step 1: open
  await page.goto('https://example.test/login');

  // step 2: click
  await page.getByRole('button', { name: 'Accept cookies' }).click();
  await page.waitForURL(/^\/$/);

  // step 3: fill
  await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');

  // step 4: fill
  await page.getByRole('textbox', { name: 'Password' }).fill('password123');

  // step 5: click
  const loginButton = page.getByRole('button', { name: 'Entrar' });
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/login') && r.status() < 400),
    loginButton.click(),
  ]);
  await page.waitForURL(/dashboard/);
});
```

Run the test with `npx playwright test login.spec.ts`.

## Import from Chrome DevTools Recorder

Chrome DevTools Recorder exports to JSON. Convert it to a Rastro flow:

```bash
rastro flow import recording.json flow.yaml
```

Supports Chrome Recorder steps:
- `navigate`: url
- `click`: aria, css, xpath, text, pierce selectors
- `change`: input value
- `keyDown`: Enter, Escape, etc.
- `waitForElement`: visibility check

The generated flow uses Rastro's locator format (role, name, text, CSS). Edit as needed before running.
