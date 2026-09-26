# flow-link Specification

## ADDED Requirements

### Requirement: Compile a run into an HTTP recipe
`rastro flow link <name>` SHALL compile a successful browser run of the flow
into `<name>.link.yaml` next to the flow, either by running the flow with the
given parameters or from an earlier run given as an action range with the
parameter values it used. The recipe SHALL list the document, xhr and fetch
requests the run's actions caused, without redirect hops, in order, with their
method, URL, body and the status class recorded for each.

#### Scenario: A form post is linked
- **WHEN** a flow opens a page with a form and submits it, and `rastro flow link` runs it with `--param name=Ada`
- **THEN** the recipe holds the GET of the page and the POST of the form, and the POST body carries `{{name}}` where `Ada` was sent

### Requirement: Dynamic values become extraction rules
Every non-parameter value sent in a request that appeared in an earlier
response of the run SHALL be replaced by a variable with an extraction rule
that reads it from that response, and the rule SHALL be checked against the
recorded response before it is accepted. A value that could not be traced and
looks like a token SHALL be listed in the recipe's warnings.

#### Scenario: A CSRF token is extracted, not frozen
- **WHEN** the page carries a hidden input `csrf` whose value the form post sends
- **THEN** the recipe extracts `csrf` from the page response and the post sends `{{csrf}}`

### Requirement: Recipes carry no credentials
A recipe SHALL NOT contain a cookie value, an `Authorization` value or the value
of any secret parameter. Linking SHALL abort without writing the file when the
serialized recipe would contain one.

#### Scenario: A secret is bound, never written
- **WHEN** a login flow with a secret password parameter is linked
- **THEN** the recipe sends `{{password}}` and the file does not contain the password

### Requirement: Recipes are bound to their flow
A recipe SHALL record the content hash of the flow it was compiled from, and a
recipe whose hash no longer matches the flow SHALL be treated as stale and not
used.

#### Scenario: Editing the flow stales the recipe
- **WHEN** a linked flow's file is edited
- **THEN** `rastro routine list` shows its link as stale and `auto` runs it in the browser

### Requirement: HTTP execution with a safe fallback
A routine SHALL run with engine `browser`, `http` or `auto`. `http` SHALL replay
the recipe with Node's HTTP client and the session's exported cookie jar,
without starting a browser. `auto` SHALL use the recipe only when it is fresh
and verified, and SHALL fall back to the browser when a response does not match
its recorded status class **only if no write request was sent yet**; after a
write it SHALL fail and report the writes sent. A recipe SHALL become verified
after one successful HTTP run of its exact bytes.

#### Scenario: Linked routine runs without a browser
- **WHEN** a verified, fresh recipe exists and the routine runs with `auto`
- **THEN** the requests are sent over HTTP and no browser is launched

#### Scenario: Expired cookies fall back before any write
- **WHEN** the first GET of an HTTP run is redirected to a login page instead of the recorded 2xx
- **THEN** the routine reruns in the browser

### Requirement: Cookie jar export
After each successful browser run of a flow or routine, the daemon SHALL write
the session's cookies to a file readable only by the user, which the HTTP
runner SHALL read and update with the `Set-Cookie` headers it receives.

#### Scenario: The jar is private
- **WHEN** a browser run completes
- **THEN** the session's cookie file exists with mode 0600
