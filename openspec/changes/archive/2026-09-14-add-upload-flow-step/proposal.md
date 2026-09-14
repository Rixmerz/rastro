# Uploading a file from a recorded flow

## Why

A real recording exposed this: a teacher recorded creating an assignment in
Moodle and attaching a PDF. Every step replayed except the one that mattered.

Two things are wrong today. `upload` is not a flow step kind at all — the format
lists it among the actions with "no flow-step equivalent" — so the capture fell
through to the generic text-input branch and saved a `fill` step. And the value
it saved was `C:\fakepath\Instrucciones.pdf`, which is what the browser shows a
page instead of the real path, deliberately: the path never leaves the browser.

So the recorded flow silently attaches nothing. It is not a matter of capturing
the path better — the path is not there to capture. The file has to be a
**parameter**, supplied at run time, exactly as the course already can be.

## What Changes

- `upload` becomes a flow step kind, carrying a target and a value like `fill`.
  It runs through the same upload sandbox as an agent's own `upload`.
- Capturing a `<input type="file">` emits an `upload` step whose value is a
  **parameter reference**, never the browser's placeholder path. The parameter
  is declared in the flow, and the recorded file name is kept as its
  `description` so whoever runs it knows what was originally attached.
- A flow parameter can carry a `description`.

## Impact

- Affected specs: `flow-recording`.
- Affected code: `src/flow/format.ts` (step kind, schema, `description`),
  `src/flow/runner.ts` (the step, and the sandbox check), `src/flow/capture-script.ts`
  (file inputs), `src/engine/flows.ts` (step building), `src/engine/engine.ts`
  (expose the sandbox check to the runner).

## Out of scope, deliberately

Parameterising the **locator**. Where a file belongs inside a course varies by
unit, and picking the right place is a judgment call: the agent looks at the
page with `view` and decides, then runs the flow for the mechanical part.
Freezing that choice into a recorded selector would make the flow wrong in a
way nobody notices until a file lands in the wrong unit.
