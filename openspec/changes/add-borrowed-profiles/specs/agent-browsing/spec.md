# agent-browsing Specification

## ADDED Requirements

### Requirement: Borrowing an installed browser profile
Rastro SHALL list the profiles of installed Chromium-family browsers
(`rastro profiles`, `rastro_profiles`) and SHALL let a session bind to one
(`rastro profile use`, `open --profile`, `profile` on `rastro_open`), the
binding persisting with the session until changed. A borrowed profile SHALL be
launched with the browser that owns it, SHALL keep the system keyring, and
SHALL NOT have its preferences rewritten. A running session SHALL NOT switch
profiles.

#### Scenario: Bind by display name
- **WHEN** the user runs `rastro -s personal profile use brave-origin:Personal`
- **THEN** session `personal` launches Brave Origin on the profile whose name is "Personal"

#### Scenario: A saved write allowlist
- **WHEN** the user runs `rastro -s personal profile use brave-origin --allow-write youtube.com` and then `rastro -s personal open` without `--allow-write`
- **THEN** writes to youtube.com are allowed and writes to any other host are blocked, and `open` says so

#### Scenario: Switching while running
- **WHEN** a session is running and `open` names a different profile
- **THEN** the call fails and asks for the session to be closed first

### Requirement: A borrowed profile must be closed first
Before every launch on a borrowed profile, Rastro SHALL check whether another
process holds it. If one does, the launch SHALL fail without starting a
browser, naming the browser and pid and saying that the user has to close it.
Rastro SHALL NOT close or signal that browser.

#### Scenario: The user's browser is open
- **WHEN** Brave Origin is running on the bound profile and the agent calls `rastro_open`
- **THEN** the call fails at once with a hint to close Brave Origin completely, and the user's browser is untouched

#### Scenario: Another session holds it
- **WHEN** a second session binds the profile a running session uses
- **THEN** its launch fails, saying another Rastro session holds the profile

### Requirement: The user's saved tabs survive
Rastro SHALL copy a borrowed profile's saved-session files aside before
launching and SHALL restore them after the browser closes or fails to launch,
so the user's browser does not restore Rastro's tabs. A copy left by a run that
did not close cleanly SHALL be kept aside, not restored over newer files.

#### Scenario: Clean close
- **WHEN** a session on a borrowed profile opens pages and is closed
- **THEN** the profile's `Sessions/` holds exactly the files it held before the launch
