# Routines and linked flows

## When to use a routine

If `rastro_routines` (MCP) or `rastro routine list` (CLI) lists a routine for
the task, **run it instead of browsing**. You only need its parameters, not the
site. Browse with `view`/`act` only for what no routine covers, or for the
judgment a routine deliberately leaves out (which section a file belongs in,
say), then run the routine for the mechanical part.

```bash
rastro routine list
rastro routine show publish-file          # params, types, last run, link state
rastro routine run publish-file --param course=12345 --param file=/abs/path.pdf
```

Over MCP, a verified routine is its own tool (`publish-file`); any routine,
verified or not, runs through `rastro_routine_run { name, params }`.

## Reading the result

- `publish-file ok · 9 steps` then `→ <final url>`: done. The `writes:` line
  says what was created (method, path, status, redirect target). **Do not run it
  again to "make sure".**
- `failed at step N: <reason>` with **`retry is safe`**: nothing was written.
  Fix the cause (a param, a login) and run it again.
- `failed ...` with **`a write was sent: do NOT retry`**: something may already
  exist. Check the site (`rastro_view`, `rastro_effects <last id>`) before any
  new attempt.
- `still running ... Do NOT run it again`: the call outlived the client timeout.
  Check `rastro_history` for how it ended.
- `http replay gave way to the browser before any write`: the HTTP recipe did
  not fit (usually an expired session) and the browser ran it instead. Nothing
  to do.

## Making a routine

1. Record or write the flow; save it under a clean name (`publish-file.yaml`).
2. Add a `tool:` block: `description`, `effect` (`read|write|destructive`),
   `allowWrite` hosts (include an SSO host if the login posts there),
   `allowUpload` dirs, and `login` + `loginWhen` if the site logs you out.
3. Type every parameter (`type`, `description`, `example`); secrets come from
   the keyring with `from: secret:<name>`, never as parameters.
4. Turn a judgment call into a parameter (the section number) or leave it out
   of the routine. A routine must work from a cold start.
5. Run it once: `rastro routine run <name> ...`. A successful run of these exact
   bytes verifies it; any edit sends it back to probation.

`rastro routine list` warns about generated css ids (`#ext-gen51`),
undocumented params and a leftover `name: recorded`.

## Linking to HTTP (no browser)

```bash
rastro flow link <name> --param ...        # runs it once for real, then compiles
rastro routine run <name> --engine http --param ...   # verifies the recipe
```

After that, `auto` (the default) replays over HTTP and only falls back to the
browser before any write. Editing the flow stales the recipe; link again.
Read the link's `warning:` lines: a constant that looks like a token, or a
short value it could not bind, may need a hand edit in `<name>.link.yaml`,
which un-verifies it until another `--engine http` run.
Not linkable: JS-signed requests, WebSockets, browser-minted bearer tokens,
uploads whose body the browser hides.
