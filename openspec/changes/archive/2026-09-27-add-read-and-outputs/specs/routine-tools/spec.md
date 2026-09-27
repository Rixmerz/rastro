# routine-tools Specification

## ADDED Requirements

### Requirement: Steps that produce outputs
A flow SHALL support a `read` step (a region or target, and an optional `find`)
and a `capture` step (a request pattern whose path may include a query, an
optional JSON path with `[*]`, and optional `fields`), each naming its output
with a unique identifier in `as`. A `capture` SHALL use the most recent request
of the run that matches and has a stored JSON body, waiting up to the session
timeout, and SHALL fail the step when none arrives or the path selects nothing.
A routine's result SHALL carry its outputs, masked, in both its text and its
structured data.

#### Scenario: A routine returns the inbox
- **WHEN** a routine opens a mail list and captures `POST /api/mail?action=list* 2xx` with `json: items[*]` and `fields: { from: sender.name, subject: subject }`
- **THEN** its result has an output that is a list of `{ from, subject }` records

#### Scenario: A capture that never arrives fails its step
- **WHEN** no request of the run matches the capture's pattern within the timeout
- **THEN** the routine fails at that step, naming the pattern
