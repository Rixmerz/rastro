# Design

## Binding

`sessions/<name>/profile.json` holds the browser id, its user-data dir, the
profile directory (`--profile-directory`), the display name and the browser
binary. It is written by `profile use` (CLI, refused while the session runs)
or by `open --profile` (daemon, only before the browser starts). `open` on a
running session with a different profile errors instead of switching: the
old profile may be the user's, and has to be released deliberately.

Profiles are found from a fixed table of browsers (user-data dir per platform
plus candidate binaries) and each dir's `Local State` → `profile.info_cache`.
A ref is `browser` or `browser:profile`, where the profile matches the
directory or the display name, case-insensitively.

## Saved write allowlist

`profile use … --allow-write` stores `allowWrite` in the binding. At launch the
session takes `open`'s `allowWrite` when given and the saved list otherwise;
replacing rather than merging keeps one rule for what a run may write. Only the
CLI saves it: an agent widening what the user's accounts may write, for every
later run, is a decision for the user.

## Must be closed first

Chromium marks a profile in use with a `SingletonLock` symlink to
`<host>-<pid>`. `createContext` reads it on every launch, relaunches included:
a live pid on this host is refused, naming the browser and pid; a pid whose
command line has `--remote-debugging-pipe` is another Rastro session; another
host is refused too; a dead pid is stale and left to Chromium. Without this
check, Chromium forwards the launch to the running instance over its
singleton socket and exits 0. The user's window gets a stray tab, and
Playwright waits for a browser that already left.

## Keeping the profile the user's

- Binary: the binding's, never `RASTRO_CHROMIUM`, so another brand or an older
  version never opens it.
- Keyring: `--password-store=basic` and `--use-mock-keychain` are dropped from
  Playwright's defaults. A distro wrapper puts its flags-file switches before
  ours, so `basic` would otherwise win over the user's
  `--password-store=gnome-libsecret`.
- No DuckDuckGo seeding of its Preferences.
- Saved tabs: measured on a synthetic profile, an automated run writes its own
  `Session_*`/`Tabs_*` files as the newest, so the user's "continue where you
  left off" would reopen Rastro's tabs. `Sessions/` is copied to
  `sessions/<name>/profile-sessions-backup` (with a completion marker) before
  launch and put back after close, and after a failed launch. A backup found at
  launch means a run that died; it is moved to `.prev`, not restored, because
  the user may have saved newer tabs since.
