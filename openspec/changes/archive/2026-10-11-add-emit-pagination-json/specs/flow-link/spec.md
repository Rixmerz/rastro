# flow-link Specification

## ADDED Requirements

### Requirement: Paginated reads
Linking SHALL mark the product request of a run (the last kept request, or a
request a `capture` matches) with a `paginate` block when it is a script GET
whose JSON response carries a list and either a cursor that the request sends
back as a query parameter, a next URL on the same origin, a page-number query
parameter or an offset query parameter, and SHALL say so in the recipe's
warnings. An HTTP run SHALL fetch the following pages, up to `maxPages`, and
merge their items into the list of the first response before extraction rules
and captures read it. A write request SHALL NOT paginate.

#### Scenario: A list read returns every page
- **WHEN** a linked routine captures `GET /api/jobs?page=1 2xx` and the API has three pages
- **THEN** the HTTP run fetches pages 2 and 3 and the captured output holds the items of all three

#### Scenario: Pagination stops on its own
- **WHEN** a page comes back empty or shorter than the first, the cursor is null, or the next URL points to another origin
- **THEN** no further page is fetched

### Requirement: Standalone clients from a recipe
`rastro flow emit <name> --lang ts|py` SHALL write a client that replays the
flow's recipe over HTTP without Rastro, with the same templates, extraction
rules, redirect handling, status checks, pagination and captures as the HTTP
runner. It SHALL refuse a stale or unreadable recipe and SHALL mark an
unverified one in the file and in its answer. The client SHALL contain no
credential: it SHALL take the session from a Cookie header or a Rastro cookie
file supplied by the caller, and keyring parameters from environment
variables.

#### Scenario: A linked routine becomes a Python client
- **WHEN** `rastro flow emit publish-file --lang py` runs on a fresh recipe
- **THEN** `publish_file_client.py` is written next to the recipe, runs with the standard library and returns the same outputs as `--engine http`

#### Scenario: A stale recipe is not emitted
- **WHEN** the flow was edited after it was linked
- **THEN** `flow emit` fails and asks to link again
