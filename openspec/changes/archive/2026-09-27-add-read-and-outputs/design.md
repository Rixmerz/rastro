# Design: read and outputs

## 1. `read` uses the view's regions and refs

The same landmark mapping as `view` (`main`, `aside`, `nav`, `dialog`…) picks
the element, through its aria ref, and the text is the element's `innerText`:
layout-aware, with line breaks where a reader sees them, which a mail body
needs. No argument means `main` when the page has one, else the whole body.
Several landmarks of one region (two `nav`s) are read in document order.

Lines are trimmed, runs of blank lines collapse to one, and icon-font glyphs
(Unicode private use area) are dropped. `--find` keeps each matching line with
two lines of context. The default cap is 12 000 characters; past it the text
ends with a note naming what was cut and how to narrow it. The CLI and MCP
output contract still spill anything over 4 KB to a file.

## 2. `capture` reads the network, not the DOM

A web app's data is cleaner in its own API responses than in its markup:
Outlook's `service.svc?action=GetItem` carries the mail as JSON. `capture`
waits (up to the session timeout) for a request of the run matching the
pattern with a stored body, and takes the most recent one. The pattern grows
one thing: a path containing `?` is matched against path and query, with `*`
as a glob, so `POST /owa/service.svc?action=GetItem* 2xx` works.

JSON paths: dotted names, `[n]`, and `[*]`, which maps the rest of the path
over each element. `fields: { name: path }` projects each element of an array
result (or the single object) into a small record — what a caller wants from a
40 KB response.

## 3. Outputs

`as` names the output; it must be an identifier and unique in the flow. Outputs
are masked with the secret registry. The text result prints each output after
the run's lines: a string as a block, an array one JSON line per element.

## 4. HTTP

A `capture` names the request that matters, so compile keeps every request it
matches (as it keeps what `expect.requests` names) and the recipe carries the
capture specs. The runner keeps each replayed response and applies the specs
at the end. A flow with a `read` step is refused by `flow link`: there is no
page to read over HTTP.
