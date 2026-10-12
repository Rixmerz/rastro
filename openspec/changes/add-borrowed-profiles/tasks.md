# Tasks

## 1. Profiles

- [x] 1.1 `src/core/profiles.ts`: browser table, discovery from Local State, ref resolution, binding load/save.
- [x] 1.2 Lock inspection (`SingletonLock`), refusal with a close-it-first hint.
- [x] 1.3 Saved-tab backup and restore, stale backup set aside.

## 2. Launch

- [x] 2.1 `createContext`: borrowed binary, user-data dir, `--profile-directory`, keyring defaults dropped, no seeding, lock check, backup; restore on close, relaunch and failed launch.
- [x] 2.2 `open --profile`: bind before launch, refuse a switch while running, note on launch.

## 3. Surfaces

- [x] 3.1 CLI: `rastro profiles`, `rastro profile [show|use]`, `open --profile`.
- [x] 3.2 MCP: `rastro_profiles`, `profile` on `rastro_open`, server instructions.
- [x] 3.3 Write allowlist saved with the binding (`profile use --allow-write`), used when `open` names none.
- [x] 3.4 Tests: lock states, discovery, ref resolution, backup/restore.

## 4. Docs and gates

- [x] 4.1 README, README.es, CHANGELOG, skill, navegador agent.
- [x] 4.2 `pnpm typecheck`, `pnpm lint`, `pnpm test` green, by exit code.
