# flow-recording Specification

## ADDED Requirements

### Requirement: Upload as a flow step
A flow SHALL support an `upload` step carrying a target and a value, where the
value is the path of a local file. The step SHALL apply the same upload sandbox
as an agent-issued `upload`: a path outside the session's upload directories
SHALL be refused, with symlinks resolved before the check. The value SHALL be
substitutable from a parameter, so one flow can attach different files.

#### Scenario: Uploads a file given at run time
- **WHEN** a flow has an `upload` step with value `{{archivo}}` and is run with `--param archivo=/allowed/dir/report.pdf`
- **THEN** the file is attached and the step is recorded like any other action

#### Scenario: The sandbox still applies
- **WHEN** the same flow is run with `--param archivo=/etc/hostname`
- **THEN** the step fails with `upload outside allowed dirs` and nothing is attached

### Requirement: Recording a file input yields a parameter
Capturing an interaction with an `<input type="file">` SHALL record an `upload`
step whose value is a parameter reference, and SHALL declare that parameter in
the saved flow. The browser's placeholder path (`C:\fakepath\<name>`) SHALL
NEVER be written as the step's value, because it is not a path to anything. The
recorded file's name SHALL be preserved as the parameter's `description`.

#### Scenario: The placeholder path is not saved
- **WHEN** a human picks `Instrucciones.pdf` in a file input while recording, and the flow is saved
- **THEN** the step is an `upload` whose value is a parameter reference, the saved flow contains no `fakepath`, and the parameter's description names `Instrucciones.pdf`

#### Scenario: Running without the file is refused up front
- **WHEN** that flow is run without supplying the parameter
- **THEN** the run fails naming the missing parameter, before the first step

### Requirement: Documented flow parameters
A flow parameter SHALL accept an optional `description`, carried through saving
and re-parsing, so a flow can say what a caller is expected to supply.

#### Scenario: Description survives a round trip
- **WHEN** a flow declaring `archivo: { description: "the file to attach" }` is saved and parsed again
- **THEN** the description is still there
