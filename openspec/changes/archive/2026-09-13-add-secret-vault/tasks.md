# Tasks

## 1. Vault

- [x] 1.1 `src/security/vault.ts`: `secretSet`, `secretGet`, `secretList`, `secretRemove` over `secret-tool`, plus `parseSecretRef`. Missing binary or non-zero exit raises a `RastroError` with a hint.
- [x] 1.2 Unit tests for `parseSecretRef` and for the error when `secret-tool` is absent (stub the binary lookup).

## 2. Interactive prompt

- [x] 2.1 `src/cli/prompt.ts`: read one line from `/dev/tty` with echo off; when there is no tty, spawn the user's terminal running the same command and wait for it.
- [x] 2.2 Reject a value passed as a positional argument.

## 3. CLI surface

- [x] 3.1 `secret set|list|rm` in the dispatch table, with usage lines.
- [x] 3.2 `secret get` gated behind `--reveal`.
- [x] 3.3 Tests: `set` with a positional value exits non-zero; `list` prints names only.

## 4. Flow home

- [x] 4.1 `src/core/paths.ts`: `flowsDir()` and `resolveFlowRef(arg)` implementing the lookup order and the "a path stays a path" rule.
- [x] 4.2 Wire `flow save` and `flow run` in `src/cli/main.ts` through it.
- [x] 4.3 Tests for both branches of the rule, including the `.yaml` suffix.

## 5. Secret references in flows

- [x] 5.1 `src/flow/format.ts`: optional `from` on `paramSchema`, validated against the `secret:<name>` shape.
- [x] 5.2 Resolve in the daemon's flow runner, register with `SecretRegistry`, abort before step 1 when the entry is missing.
- [x] 5.3 Tests: masked in output; missing entry aborts early naming the entry.

## 6. Docs and gates

- [x] 6.1 README section and CHANGELOG entry, including the keyring threat-model line and the plaintext `secrets` file that stays.
- [x] 6.2 `pnpm typecheck`, `pnpm lint`, `pnpm test` all green, checked by exit code and not through a pipe.
