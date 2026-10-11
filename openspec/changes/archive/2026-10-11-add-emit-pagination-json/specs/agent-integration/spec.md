# agent-integration Specification

## MODIFIED Requirements

### Requirement: Output contract and token budget
Every command SHALL print plain text by default. With `--json` it SHALL print
one line on stdout: `{"schemaVersion":1,"ok":true,"data":…}` on success, or
`{"schemaVersion":1,"ok":false,"error":{"kind","message","hint"}}` on failure,
`kind` being `usage` or `runtime`. A routine that ran and failed SHALL answer
`ok: false` with its result in `data`. Output longer than 4 KB SHALL be written
to a file under the session output directory and the command SHALL print the
path followed by the first 20 lines. Errors SHALL be printed to stderr with a
message that says what to do next and exit code 1, or 2 for a usage error.
Measured as characters divided by 4, the minimal view of each bundled fixture
page SHALL be at most 400 tokens and an action summary line at most 40 tokens.

#### Scenario: Large output
- **WHEN** `rastro trace` would print 12 KB
- **THEN** it writes the full text to a file and prints its path and the first 20 lines

#### Scenario: JSON output
- **WHEN** the agent runs `rastro act e5 click --json`
- **THEN** stdout is a single JSON line whose `data` holds the action id and the effect counters, with `schemaVersion` 1 and `ok` true

#### Scenario: JSON error
- **WHEN** the agent runs `rastro flow emit missing --json`
- **THEN** stdout is a single JSON line with `ok` false and the error's message and hint, and the exit code is 1
