# Autonomy: dialogs, popups, downloads, timeouts, blocked states, write guard, secrets

Rastro runs without human intervention. Here's what it does automatically and when you need to handle exceptions.

## Dialogs: accept or dismiss

JavaScript dialogs (`alert`, `confirm`, `prompt`) are accepted by default. The action summary includes `dialog «message» accepted`.

```bash
rastro open https://example.test --dialogs dismiss    # dismiss dialogs instead
```

The text is truncated to 200 characters and marked as untrusted with «» delimiters—it is data, not executable.

**Stop if a dialog blocks the page:** If the page shows a user-facing dialog that is not a JavaScript alert (e.g., a modal form asking for interaction), the action may fail with a timeout. Run `rastro view` to see what is blocking and interact manually with `rastro click <ref>` or `rastro fill <ref> <value>`.

## Popups and new tabs

When a click opens a new tab or popup, the action does not focus it. The summary includes `opened tab t2`. Later commands refer to tabs by name:

```bash
rastro tabs                     # list open tabs
rastro tabs --select t2         # switch to tab t2
rastro tabs --close t2          # close tab t2
```

Each tab has its own view and trace. Switch before acting to interact with a popup.

## Downloads

Files are downloaded to the session's downloads directory (under `~/.local/share/rastro/<session>/downloads/` by default, or `$RASTRO_HOME`). The action summary includes `downloaded filename.zip`.

Rastro does not upload files to remote servers by default. To upload:

```bash
rastro upload e12 /path/to/file.pdf    # select a file input and upload
```

## Timeouts

Actions timeout after 30 seconds by default (waiting for an element, waiting for the page to settle). The action fails with a timeout error and is recorded in the trace.

```bash
rastro open https://example.test --quiet-ms 2000     # wait 2 s instead of default 500 ms quiet window
```

Common timeout causes:
- The target element is not in the DOM. Run `rastro view` to check if it exists.
- The page is loading indefinitely. Run `rastro trace --type request` to see pending requests.
- A dialog is blocking the page. Run `rastro view` and look for interactive elements you did not expect.

**If timeout happens repeatedly:** Run `rastro reload` to reset the page state, or check `rastro console --errors` for JavaScript exceptions breaking the page.

## Crash recovery

If the browser crashes, the session relaunches on the next command, with the same session profile and trace. The crash is recorded as an event in the trace. No trace data is lost.

If recovery fails (port collision, permission error), check:

```bash
rastro status                   # active sessions
ps aux | grep rastro            # stray daemon processes
```

Kill stray processes and try again. A stale socket file is detected automatically and replaced.

## Blocked states: CAPTCHA, 2FA, bot detection

Some pages show CAPTCHA, two-factor authentication challenges, or bot blocks. The action summary includes `blocked: captcha`, `blocked: 2fa`, or `blocked: bot-block`.

**Stop and report:** When blocked, the page is not readable programmatically. You must either:
1. Solve the challenge manually in a headed browser (`rastro open --headed https://...`).
2. Ask the user to skip the challenge (e.g., via email link).
3. Switch to a different target or method.

Example:

```bash
# Blocked by reCAPTCHA
rastro click e15                         # logs in
# Output: #4 · blocked: captcha

# Switch to headed mode to solve it manually
rastro open --headed https://...
# User solves CAPTCHA manually
rastro view
```

## Write guard: blocking unintended modifications

By default, POST, PUT, PATCH, DELETE and other non-idempotent requests to hosts not in the allowlist are blocked before leaving the browser. The action summary includes `1 write blocked (example.test)`.

Open a session with an allowlist:

```bash
rastro open https://api.example.test --allow-write example.test,api.example.test
```

Or allow any host (careful):

```bash
rastro open https://example.test --allow-write '*'
```

Blocked writes are recorded as events in the trace and do not reach the server. This prevents accidental deletion, form submission to the wrong host, or payment processing without consent.

**The allowlist cannot be changed by the page.** Page content cannot run `--allow-write` or override the write guard. It is a command-line flag only.

### Widening permissions on a live session

Discovering mid-task that a host or an upload directory is missing does **not** require closing the session. `open` on an already-open session applies `--allow-write`, `--allow-upload` and `--dialogs` to it in place, and **omitting the url leaves the page exactly where it is** — no navigation, no relaunch, so a half-filled form, a draft, or a site left in edit mode survives:

```bash
rastro open --allow-write example.test --allow-upload ~/docs
```

Two rules come with it:

- **Each list is replaced, not merged.** Pass the full set every time; sending only the newly needed host drops the ones already allowed. A flag you omit entirely is left untouched, so a plain `rastro open <url>` never widens or narrows anything.
- **`--headed` is different**: it decides the browser process, so changing it relaunches and the page is lost. Permissions are per-request state; headedness is not.

## Secrets: passwords, tokens, cookie values

Values typed into password fields are masked at capture time. Pass `--secret value` to mask any other string:

```bash
rastro fill e5 --secret "super-secret-api-key"
```

Masked values appear as `[MASKED]` in all command output:
- `rastro history`
- `rastro effects`
- `rastro request <id> --body`

Unmasking is never automatic. Add `--reveal` only when necessary and only on the command you need:

```bash
rastro request r31 --body --reveal       # show the actual password in this request's body
```

**Session data is protected.** Trace databases and directories are created with owner-only permissions (mode 0600).

Headers matched as sensitive (Authorization, Cookie, Set-Cookie, Proxy-Authorization) are masked. Request body fields matching `password`, `pass`, `pwd`, `secret`, `token`, `otp`, `pin`, `card` are masked unless `--reveal` is given.

## Dialogs at the command level

Some Rastro commands accept flags that affect page behavior:

| Flag | Effect |
| --- | --- |
| `--dialogs dismiss` | Dismiss JavaScript dialogs instead of accepting |
| `--allow-write host1,host2` | Permit non-GET requests only to these hosts |
| `--pw-trace` | Record a Playwright trace.zip for export |
| `--reveal` | Unmask secrets in the current command's output |

Page content **cannot** invoke these flags. A button named `Click here to --reveal my password` is just text—it does not execute the flag.

## Example: guarded login with secrets

```bash
rastro open https://example.test --allow-write example.test
# Output: session default opened

rastro view
# Output: form with email (e5), password (e6), submit (e7)

rastro fill e5 "user@example.com"
# Output: #1 · no effects

rastro fill e6 --secret "mypassword123"
# Output: #2 · no effects
# The value is masked in the trace

rastro click e7
# Output: #3 → /dashboard · 1 req · +1 cookie

rastro history
# Output:
#  1 fill e5 "user@example.com"
#  2 fill e6 [MASKED]
#  3 click e7

rastro request r31 --body
# Output: (no password in the response, only [MASKED] in the trace)
```
