# Design: flow link

## 1. Input is a run, with its parameter values

Binding `{{param}}` back into a request needs the values the run used, so
`flow link` either runs the flow itself (`--param` as usual) or takes an action
range from an earlier run plus the same `--param` values. Secret values are
known to the daemon (the secret registry) and are always bound, never written.

## 2. Selecting requests

From the requests attributed to the run's actions, keep `document`, `xhr` and
`fetch` that did not fail, drop redirect hops (`redirectedFrom` set: the runner
follows redirects itself), and drop a GET that nothing downstream extracts
from, that sets no cookie, and that is not the last request. The last request
always stays, since for a read routine its response is the product.

## 3. Tracing dynamic values

Every request is broken into fields: query values, form fields
(`application/x-www-form-urlencoded`), JSON leaves, multipart text parts, and
non-standard headers (`x-*`). For each field value, in order:

1. equal to a parameter value → `{{param}}`. Values of fewer than 3 characters
   bind only when exactly one field of the request carries them; otherwise they
   stay literal and a warning names the ambiguity.
2. found in an earlier response → an extraction rule, from the most recent
   response backwards:
   - JSON body: the path whose value equals it (`json: data.itemid`);
   - HTML body: a hidden or plain input with that value (`input: sesskey`);
   - `Location` header or body text: a regex with enough left context to match
     it first, **validated against the recorded body before it is accepted**;
   - an earlier request's URL query (`query: id` of request `q2`).
3. otherwise a constant; flagged when it looks like a token (≥ 16 characters of
   hex/base64, or a 10–13 digit timestamp).

Substrings inside a longer value (a param inside a URL path) bind for values of
3 characters or more.

## 4. Recipe format

```yaml
flow: publish-file
flowHash: <sha256 of the flow file>
params: [course, section, name, file]
requests:
  - id: q1
    method: GET
    url: https://lms.example.edu/course/view.php?id={{course}}
    expect: 2xx
    extract:
      sesskey: { input: sesskey }
  - id: q2
    method: POST
    url: https://lms.example.edu/course/modedit.php
    form:
      sesskey: "{{sesskey}}"
      name: "{{name}}"
    expect: 3xx
warnings: []
```

Bodies are one of `form`, `json`, `multipart` (text parts and `{ file: param }`
parts) or `raw`. `Cookie` and `Authorization` headers are never written: the
jar supplies cookies, and a request that needed an `Authorization` header that
no response produced makes the flow not linkable.

## 5. The safety check before writing

After compiling, the serialized recipe is searched for every secret value, every
cookie value in the session and every captured `Authorization` value. Any hit
aborts the link; the recipe is not written.

## 6. Running

The runner resolves parameters (keyring included), loads the session's cookie
jar, sends each request with `redirect: 'manual'`, stores `Set-Cookie`, follows
up to 10 redirects (303, and 301/302 after POST, become GET), and compares the
first hop's status class with `expect`. Extraction reads the final response of
the chain.

A mismatch before the first write request is a **fallback** signal in `auto`
mode: the routine reruns in the browser, which also refreshes the cookie jar. A
mismatch after a write is a failure reported with the writes already sent.

## 7. Cookie jar

After every successful browser run the daemon writes `context.cookies()` to
`sessions/<s>/cookies.json` (0600). The jar implements the subset that matters:
domain and path matching, `Secure`, expiry, host-only cookies. `Set-Cookie`
from HTTP runs updates the file; nothing flows back into the browser profile.

## 8. Uploads

A multipart body is compiled only when the recorder captured it. A file part
whose file name matches the upload step's recorded file becomes
`{ file: <param> }`, read from disk at run time through the same upload sandbox
check. When the body was not captured (Chromium does not always expose file
bytes), the flow is reported not linkable rather than linked without the file.
