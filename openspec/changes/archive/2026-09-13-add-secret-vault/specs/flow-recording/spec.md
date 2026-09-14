# flow-recording Specification

## ADDED Requirements

### Requirement: Secret references in flow parameters
A flow parameter SHALL be able to name a vault entry instead of carrying a
value, written as `secret:<name>` either in the flow's `params` block or in a
`--param <key>=secret:<name>` argument. The daemon SHALL resolve the reference
against the keyring at run time, SHALL register the resolved value with the
secret registry so it is masked in all output, and SHALL NOT pass it through
the command line. A reference naming an entry that does not exist SHALL abort
the run before the first step, naming the missing entry.

#### Scenario: Flow runs with a vault password
- **WHEN** a flow declares `password: { secret: true, from: "secret:example.password" }` and the user runs `rastro flow run login.yaml`
- **THEN** the step fills the stored value and no output of that run contains it

#### Scenario: Missing entry fails early
- **WHEN** the referenced entry is not in the keyring
- **THEN** the run aborts before the first step with an error naming `example.password`

### Requirement: Default flow home
`rastro flow save` and `rastro flow run` SHALL accept a bare name in addition
to a path. A bare name SHALL resolve against `./.rastro/flows/` when that
directory exists in the working directory, and otherwise against
`~/.config/rastro/flows/`, in both cases with a `.yaml` extension appended when
absent. `save` SHALL create the target directory with owner-only permissions.
An argument containing a path separator or a `.yaml` extension SHALL keep
being treated as a path, unchanged.

#### Scenario: Save and run by name
- **WHEN** the user runs `rastro flow save login-example` and later `rastro flow run login-example`
- **THEN** the flow is written to and read from the flow home, without either command naming a directory

#### Scenario: A path is still a path
- **WHEN** the user runs `rastro flow save ./tmp/x.yaml`
- **THEN** the file lands at that path and the flow home is not involved
