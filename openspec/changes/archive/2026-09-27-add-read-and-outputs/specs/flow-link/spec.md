# flow-link Specification

## ADDED Requirements

### Requirement: Captures over HTTP
Linking a flow SHALL keep every request a `capture` step matches and SHALL
carry the capture specs in the recipe; an HTTP run SHALL apply them to the
replayed responses and return the same outputs a browser run returns. Linking
a flow that contains a `read` step SHALL be refused.

#### Scenario: A read routine over HTTP returns data
- **WHEN** a linked routine that captures a JSON response runs with engine `http`
- **THEN** its result carries the captured output, taken from the replayed response

#### Scenario: Page text cannot be linked
- **WHEN** `flow link` is run on a flow with a `read` step
- **THEN** it is refused as not linkable and no recipe is written
