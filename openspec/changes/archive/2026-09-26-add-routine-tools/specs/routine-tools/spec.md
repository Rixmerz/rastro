# routine-tools Specification

## ADDED Requirements

### Requirement: Routine manifest
A flow SHALL become a routine only when it carries a `tool:` block with a
non-empty `description` and an `effect` of `read`, `write` or `destructive`. The
block MAY declare `session`, `allowWrite`, `allowUpload`, `login` and
`loginWhen`. A flow without the block SHALL NOT be exposed as a routine. The
routine's name SHALL be the flow file's basename without its extension, and a
name starting with `rastro_` SHALL be rejected.

#### Scenario: Only flows with a manifest are routines
- **WHEN** the flows directory holds `publish-file.yaml` with a `tool:` block and `recorded.yaml` without one
- **THEN** `rastro routine list` shows `publish-file` and not `recorded`

#### Scenario: Two files with the same `name:`
- **WHEN** two files `a.yaml` and `b.yaml` both declare `name: recorded` and both carry a `tool:` block
- **THEN** they are listed as routines `a` and `b`

### Requirement: Typed routine parameters
A flow parameter SHALL accept a `type` of `string`, `integer`, `number`,
`boolean`, `path` or `url`, an `enum` and an `example`. Running a routine SHALL
validate every supplied value against its type before the first step, and
SHALL fail naming the parameter when a value is invalid or a required parameter
is missing. A `path` SHALL be absolute after expanding a leading `~/`.
Parameters sourced from the keyring SHALL NOT be accepted from the caller.

#### Scenario: A wrong type is refused up front
- **WHEN** a routine with `course: { type: integer }` is run with `course=abc`
- **THEN** it fails with an error naming `course` and no step runs

#### Scenario: A keyring parameter cannot be overridden
- **WHEN** a routine declares `password: { from: secret:school }` and the caller supplies `password`
- **THEN** the run is refused naming `password`

### Requirement: Probation
A routine SHALL be marked verified only after a run of the exact bytes of its
file completed successfully. Any change to the file's bytes SHALL make it
unverified again. Verification SHALL be stored outside the flows directory.

#### Scenario: An edit resets verification
- **WHEN** a verified routine's file is edited
- **THEN** `rastro routine list` shows it as unverified until it completes a run again

### Requirement: Scoped run with safe retry
`routineRun` SHALL apply the routine's `allowWrite` and `allowUpload` for the
duration of the run and restore the session's previous lists afterwards, also
on failure. When a step fails, the page matches `loginWhen`, a `login` flow is
declared and no write request (any method other than GET, HEAD or OPTIONS) was
sent during the run, it SHALL run the login flow once and rerun the routine
from the start. It SHALL NOT rerun a routine after a write request was sent.

#### Scenario: Expired login is recovered once
- **WHEN** the first step of a routine lands on a login page matching `loginWhen` and the routine declares `login: login-school`
- **THEN** `login-school` runs, the routine reruns from step 1, and the result says the login was refreshed

#### Scenario: No retry after a write
- **WHEN** a routine fails at step 6 after step 4 sent a POST
- **THEN** the routine is not rerun and the result says a write was sent and a retry is not safe

#### Scenario: The session's lists survive the run
- **WHEN** a session opened with `--allow-write a.example` runs a routine whose `allowWrite` is `[b.example]`
- **THEN** during the run writes to `b.example` are allowed, and afterwards the session's list is `[a.example]` again

### Requirement: Structured routine result
A routine run SHALL return whether it succeeded, the number of steps run, the
final page URL, the write requests sent (method, path, status and redirect
target), and the range of action ids as evidence. On failure it SHALL also
return the failing step, the reason, and whether a retry is safe.

#### Scenario: Failure says whether retrying is safe
- **WHEN** a routine fails at a click before any write request
- **THEN** the result names the step, the reason, and says the retry is safe

### Requirement: Routine tools over MCP
`rastro mcp` SHALL expose `rastro_routines`, listing each routine with its
description, parameters, verification state and any problem, and
`rastro_routine_run`, which runs any routine by name, verified or not. It SHALL
also expose each verified routine as a tool named after the routine, whose input
schema is generated from the routine's typed parameters and whose annotations
follow its `effect`: `read` as read-only, `destructive` as destructive, and
neither as idempotent. The server SHALL watch the routine directories and add,
update or remove those tools when files change, and a file that fails to parse
SHALL lose its tool without stopping the server.

#### Scenario: A routine goes live after its first good run
- **WHEN** an unverified routine completes a run through `rastro_routine_run`
- **THEN** a tool with the routine's name appears in the server's tool list

#### Scenario: A broken edit does not take the server down
- **WHEN** a routine file is saved with invalid YAML while the server runs
- **THEN** its tool is removed, `rastro_routines` shows the parse error, and the other tools keep working

#### Scenario: A timed-out call is not reported as a failure
- **WHEN** the call to the daemon times out while the routine is still running
- **THEN** the tool answers that the routine may still be running and must not be retried until its history shows how it ended

### Requirement: Routine directories
Routines SHALL be read from the directories in `RASTRO_FLOWS` when it is set,
and otherwise from `./.rastro/flows` when it exists followed by
`~/.config/rastro/flows`. When two directories hold the same routine name, the
first SHALL win and the other SHALL be reported as shadowed. Files ending in
`.link.yaml` SHALL NOT be read as flows.

#### Scenario: Project routines shadow user routines
- **WHEN** both the project and the user directory hold `publish-file.yaml`
- **THEN** the project's is used and the user's is listed as shadowed
