# Design

## Backend: libsecret, and nothing else

`secret-tool` is already on this machine and it is the same keyring Brave uses
(`--password-store=gnome-libsecret`). Verified from a non-interactive process:
`store` / `lookup` / `clear` all succeed with no TTY and no prompt, which is the
constraint that decides the whole design — the daemon is spawned with the
session's `process.env` and reads the value there.

No encrypted-file fallback. A fallback would be a second, weaker code path that
nobody exercises, and its failure mode (a file the user believes is protected)
is worse than a loud error. When the keyring is unreachable, say so and stop.

Attributes are `service=rastro key=<name>`. Names are user-global on purpose:
"reusable across scripts" is the point, so they are not scoped per session.

## Why no `get`

An agent never needs to read a secret — it needs the browser to receive it. A
`get` command exists only to put the value somewhere an agent can see it, which
in this product means the transcript. The value crosses exactly one boundary:
keyring → daemon → `page.fill`. `get --reveal` stays for a human debugging their
own vault, and is documented as such.

## Where the resolution happens

Inside the daemon, in the flow runner, not in the CLI. If the CLI resolved it,
the value would have to travel as an RPC parameter and would appear in `argv`
of any process spawned in between. The runner already holds the
`SecretRegistry`, so the resolved value is registered for masking in the same
place it is used.

`paramSchema` in `src/flow/format.ts:129` already exists; it gains an optional
`from` field. The `secret:` prefix is reserved so a future `env:` or `file:`
source can slot in without another format change.

## Flow home lookup order

`./.rastro/flows/` first so a repository can carry its own flows and they land
in git with the code they drive; `~/.config/rastro/flows/` otherwise. Config,
not data: these are user-authored source, and `~/.local/share/rastro` is where
Rastro puts things it generated and may delete.

An argument that contains a separator or ends in `.yaml` is a path. That keeps
every existing invocation working and makes the rule explainable in one line.

## What stays broken, deliberately

The session's `secrets` file still holds masking material in plaintext at 0600.
It exists so a restarted daemon still knows which strings to redact, and moving
it into the keyring is a separate change with its own tradeoff (a keyring entry
per session, cleaned up by nobody). This change documents it rather than
half-solving it.
