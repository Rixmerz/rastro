# write-safety Specification

## ADDED Requirements

### Requirement: Named secret vault
Rastro SHALL store named secrets in the operating system keyring (libsecret,
under the attributes `service=rastro key=<name>`) so one credential can be
reused by every session and every flow. `rastro secret set <name>` SHALL read
the value from the terminal with echo disabled and SHALL NOT accept the value
as a command-line argument. When no terminal is attached, it SHALL open one
rather than reading from a pipe. `rastro secret list` SHALL print names only,
never values, and `rastro secret rm <name>` SHALL delete one. When the keyring
is unavailable the command SHALL fail with a message naming the missing piece,
and SHALL NOT fall back to storing the value on disk.

#### Scenario: Set then list
- **WHEN** the user runs `rastro secret set example.password`, types a value, and then runs `rastro secret list`
- **THEN** the listing contains `example.password` and does not contain the value

#### Scenario: Value never comes from argv
- **WHEN** the user runs `rastro secret set example.password hunter2`
- **THEN** the command exits non-zero with usage, and nothing is stored

#### Scenario: Keyring missing
- **WHEN** `secret-tool` is not installed and the user runs `rastro secret set x`
- **THEN** the command fails with a hint naming libsecret, and no file is written

### Requirement: No secret read command
Rastro SHALL NOT provide a command that prints a stored secret's value as part
of normal agent operation. The value SHALL be readable only inside the daemon
while resolving a flow parameter, and `rastro secret get <name>` SHALL require
`--reveal` and SHALL be documented as a human-only escape hatch.

#### Scenario: Get refuses without reveal
- **WHEN** the agent runs `rastro secret get example.password`
- **THEN** the command exits non-zero and the value is not printed
