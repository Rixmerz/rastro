# Borrowing a browser profile the user already has

## Why

Every session runs on a profile of its own under `~/.local/share/rastro/profiles`.
To act with the logins of the browser the user works in, they had to log in
again inside Rastro, site by site. There was no way to point a session at an
existing profile, and pointing one there by hand (a symlink) failed quietly:
Playwright's `--password-store=basic` leaves every cookie unreadable, and an
open browser holding the profile swallows the launch until it times out.

## What Changes

- `rastro profiles` / `rastro_profiles` list the profiles of installed
  Chromium-family browsers, with whether each is free or held by an open
  browser.
- `rastro profile use <browser[:profile]>`, `open --profile` and `profile` on
  `rastro_open` bind a session to one; `rastro` unbinds. The binding is stored
  in the session directory and sticks.
- Launching on a profile an open browser holds is refused up front, with a
  hint that the user must close it. Agent-facing docs say never to close it
  for them.
- A borrowed profile launches with the browser that owns it, keeps the system
  keyring, is not reseeded, and gets its saved tabs back after Rastro closes.

## Non-goals

- Attaching to the user's running browser over CDP. It would need the browser
  restarted with a debugging switch anyway, so it saves the user nothing.
- Restoring the user's open tabs inside the Rastro session.
