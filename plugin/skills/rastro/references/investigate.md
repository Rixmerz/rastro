# Investigation: effects, trace, request, snapshot, console, cookies

When a summary line shows a counter you need to understand, drill down.

## Effects: what an action triggered

```bash
rastro effects 4                # all attributed requests, cookies, DOM changes, errors
rastro effects 4 --all          # includes background requests and unattributed events
```

Output lists:
- Navigation (new URL if the action navigated)
- Attributed requests: `r31 GET /api/login 200`, `r32 POST /api/cart 500`
- Cookie diffs (added, changed, removed)
- Storage diffs (localStorage, sessionStorage)
- Console errors and warnings with truncated text
- Dialogs (text, dismissed or accepted)
- New tabs opened: `t2`
- Downloads: filename
- Blocked writes: `(example.test): 1`

Use `--all` only if the summary said "unattributed" — it adds low-priority background requests (polling, tracking) and requests with missing initiator information.

## Request: details of a single HTTP transaction

```bash
rastro request r31 --curl       # method, URL, status, timing, curl command (secrets masked)
rastro request r31 --body       # adds response body (first 1 KB)
rastro request r31 --full       # writes full body to a file
```

The curl command reproduces the request with all headers, credentials masked. You can run it to test or debug; if the server changed its behavior, the request shows what the original action actually sent.

If `--reveal` is not given, passwords, tokens, cookie values, and headers named `Authorization`, `Cookie`, `Set-Cookie` are masked as `[MASKED]`. Add `--reveal` only if you need the actual values and have confirmed it is safe to show them.

## Trace: the full event log

```bash
rastro trace                    # all events, oldest first, no limit
rastro trace --action 4         # events attributed to action 4
rastro trace --type request     # only HTTP requests
rastro trace --since 5000       # events at or after session-relative ms 5000 (absolute, not "last N seconds")
rastro trace --bg               # includes background events (hidden by default)
rastro trace --limit 20         # first 20 events after the other filters
```

Events are in ascending timestamp order. `--since` compares against the same absolute session-relative timestamps shown in `history` and `trace` output, not a duration. Events are classified as `attributed` (caused by the action), `background` (polling, tracking, hidden unless `--bg`), or `unattributed`/null-bucket (worker thread or missing initiator — shown by default).

## Snapshot: the page at a specific moment

```bash
rastro snapshot 4 --before      # page view immediately before action 4
rastro snapshot 4 --after       # page view immediately after action 4
```

Returns the same minimal view as `rastro view`: interactive elements, grouped by region, refs that were live at that moment. Useful for understanding what changed or why an action did or did not affect the page.

## Console: JavaScript errors and warnings

```bash
rastro console                  # all console messages, by action
rastro console --errors         # errors only (exceptions and level=error), no warnings
```

Text is truncated to 200 characters and marked as untrusted with «» delimiters. Use `trace --type console` to see the full log with timestamps.

## Cookies: session state

```bash
rastro cookies                  # all cookies (values masked)
rastro cookies --reveal         # unmasked (use carefully)
```

Shows domain, name, value (masked as `[MASKED]` unless `--reveal`), expiration, and flags (HttpOnly, Secure, SameSite).

## Storage: localStorage and sessionStorage

```bash
rastro storage                  # keys and values (sensitive values masked)
rastro storage --reveal         # unmasked
```

Shows entries per origin. Values matching patterns like `password`, `token`, `secret` are masked unless `--reveal` is given.

## Exports: formats for external tools

### HAR (HTTP Archive)

```bash
rastro export har [path]        # HTTP 1.2 archive format
```

A JSON file with all requests, responses, timings, cookies and headers—compatible with any HAR viewer. Open in:
- Chrome DevTools: Network panel → drag and drop the HAR file
- Online: https://www.softwareishard.com/har/viewer/

### Perfetto (Chrome Trace Event Format)

```bash
rastro export perfetto [path]   # timeline format for Perfetto or DevTools
```

A JSON file with a `traceEvents` array loadable by:
- Perfetto: https://ui.perfetto.dev (upload or drag and drop)
- Chrome DevTools: Performance panel → Load profile

Each action appears as a begin/end duration event. HTTP requests attributed to that action are linked with flow events, making the causal chain visible in the timeline.

### Playwright trace

```bash
rastro export pw-trace [path]   # Playwright trace.zip (if opened with --pw-trace)
```

A compressed archive of the full trace (screenshots, DOM snapshots, network log, etc.) loadable by:
```bash
npx playwright show-trace trace.zip
```

Only available if the session was opened with `rastro open --pw-trace`.
