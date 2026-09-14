# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioned with [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Secret vault** in the system keyring (libsecret): `rastro secret
  set|list|rm`. `set` asks for the value on the terminal with echo off and
  refuses it as an argument; when the process has no terminal, it opens one.
  **There is no `get`** except behind `--reveal`, documented as human-only.
- Flow parameters accept `from: secret:<name>` (or `--param k=secret:<name>`).
  The **daemon** resolves the reference at run time, registers the value for
  masking, and aborts before the first step when the entry is missing. The value
  never passes through `argv`.
- `rastro flow save|run` accept a **bare name**, resolved against
  `./.rastro/flows/` and, failing that, `~/.config/rastro/flows/`. A path is
  still treated as a path.

### Fixed — zombie daemons

- **`rastro status` was killing healthy daemons.** A daemon handles one request
  at a time, so during a navigation, a flow or a slow XHR, `status` sat waiting;
  at the 2 s timeout it was declared dead and **its socket was deleted**. The
  next command could not find it, spawned a second daemon on the same browser
  profile, and the first was orphaned with its Chromium still open — exactly the
  zombie that function was meant to report on. A timeout is now reported as
  `busy`; only a refused or absent socket is cleaned up.

### Added — daemon control

- The daemon writes `daemon.pid` (0600) and appears as `rastro[<session>]` in `ps`.
- `rastro kill [--force]` stops it by signal. `close` travels through the same
  serialised queue as everything else, so it cannot reach a wedged daemon, which
  is exactly when it is needed. When the process is already gone, it cleans up
  the files it left behind.
- `rastro status` distinguishes `running`, `busy` and `stopped` instead of lying.

### Fixed

All three came out of using Rastro against a real site, not out of the suite.

- `eval` cut its result at 1024 bytes inside the engine, with no marker and no
  spill file: any large extraction lost its tail in silence. It no longer
  truncates, and the CLI spills anything over 4 KB to a 0600 file, as it already
  did for every other output.
- `request --body --json` returned headers and timings but never the body.
- A download left Playwright's own artifact on disk at **0644** — a second,
  world-readable copy of the file, next to the 0600 one.

### Known, unfixed

- The `human capture: overlapping fast gestures (R4)` test is **intermittent**:
  it fails in roughly one run in three, and always when run in isolation with
  `-t`. It fails the same way on the commit before this change, so it predates
  it. It depends on the POST being attributed to the click inside the quiet
  window.

- Against the loopback test server, requests started by `fetch()` never emit
  `Network.loadingFinished`, so their body is not stored and no test can cover
  that path. **It does work against real sites** (verified with two different
  XHR POSTs, one of 165 KB), so this is a limitation of the fixture, not of the
  recorder. Body tests lean on the navigation response for now.

## [0.1.0] — 2026-09-13

First release. Rastro arrives complete: minimal perception, causal trace,
investigation on demand, safety for unattended operation, and human flow
recording.

### Added

**Minimal perception (the core)**
- `rastro view` shows only the interactive surface a human perceives: elements
  with a `ref` (`e12`), grouped by region, with large regions collapsed to a
  preview plus a count. Measured on real sites: Hacker News 62 tokens, `/login`
  55, Wikipedia 268.
- Every action (`click`, `fill`, `press`, `select`, `goto`…) returns **one line
  of effect**: `#3 → /dashboard · 1 req (1× 200) · +1 cookie`. The agent does not
  get the whole page again.
- Built on `playwright-core` 1.63's `page.ariaSnapshot({mode:'ai'})`; refs
  resolve through the `aria-ref=eN` selector and are stable across snapshots of
  the same element.

**Causal event trace**
- A raw CDP session per page (Playwright drops the `initiator`) recording
  requests, responses, navigations, cookies, console, dialogs and downloads into
  append-only SQLite (`node:sqlite`, WAL, one DB per session, mode 0600).
- **Action → effect attribution**, the differentiator: a quiet window (500 ms,
  5 s cap) + CDP's `initiator` + background-noise detection (analytics hosts,
  `setInterval` stacks — which need `Runtime.setAsyncCallStackDepth` — recurring
  URLs by coefficient of variation < 0.35, ping/beacon). Three buckets:
  `attributed` / `background` / `unattributed`. **Nothing is discarded.**
- Investigation in levels: `effects <n>` → `request <id> --curl` →
  `snapshot <n> --before` → `trace --action <n>`.
- Response bodies in a sha256-named `BodyStore`, outside the trace.

**Safety for running with nobody watching**
- **Write guard:** POST/PUT/PATCH/DELETE to hosts outside `--allow-write` are
  aborted before leaving the browser; covers 307/308 redirects via CDP Fetch.
- **Secret masking** in *every* output: `--json`, HAR, `pw-trace` and ARIA
  snapshots. It recognises field names in English, Spanish and Portuguese
  (`clave`, `contrasena`, `senha`, `codigo`), with diacritics stripped, and the
  form-urlencoded form of the value. `--reveal` unmasks one command at a time.
- **Page content delimited in «»** — data, never instructions.
- Block detection (CAPTCHA, 2FA, bot-block) reporting `blocked:` and stopping
  automatic execution.
- Upload sandbox (`--allow-upload`), downloads at 0600, explicit dialog and
  popup policies.

**Flows (phase 2)**
- `rastro record start/stop` records a human session in a visible browser and
  saves it as causal YAML (per tab, rejecting cross-frame steps).
- A runner with parameters, conditions and expectations.
- Export to a Playwright test; import from Chrome DevTools Recorder.

**Integration**
- CLI first; one daemon per session over a Unix socket (newline-delimited JSON,
  auto-spawn, idle exit).
- MCP server with 10 tools and `resource_link` for files.
- Claude Code plugin: the `rastro` skill (≤ 1500 tokens), the `navegador`
  subagent, `.mcp.json`.
- Exports: HAR 1.2, Chrome Trace Event Format (Perfetto/DevTools), Playwright
  `trace.zip`.

### Platform notes

- **The discrete GPU stays asleep.** `--disable-gpu` alone does not stop
  Chromium's GPU process from opening `/dev/nvidiactl`. Rastro points the
  browser's environment at the non-NVIDIA vendors
  (`__EGL_VENDOR_LIBRARY_FILENAMES`, `VK_ICD_FILENAMES`,
  `__GLX_VENDOR_LIBRARY_NAME=mesa`, `CUDA_VISIBLE_DEVICES=""`). Verified: zero
  NVIDIA file descriptors with Wikipedia open. Opt out with
  `RASTRO_KEEP_GPU_ENV=1`; values the user sets win.
- TypeScript run directly by Node ≥ 22.5 (type stripping, `erasableSyntaxOnly`:
  no enums, no parameter properties, no namespaces; relative imports end in
  `.ts`).

### Quality

- 336 tests across 19 files (unit, integration, and end-to-end CLI → daemon →
  real engine), with `tsc` and `eslint` clean.
- One adversarial review (20 findings) and one security audit (13 findings, 5
  high) fixed in full, each with a regression test. The 5 high ones were secret
  leaks through `--json`, snapshots, HAR and `pw-trace`.

[0.1.0]: https://github.com/Rixmerz/rastro/releases/tag/v0.1.0
