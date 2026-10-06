## Purpose

The `bash` tool: runs one shell command in the project root, with a time limit, cancellation that stops everything the command started, and an environment without obvious secrets. It implements the `Tool` port and always needs approval (ADR-0005).

## ADDED Requirements

### Requirement: Running a command

`bash` SHALL run the command with `bash -c` in the project root, with stdin closed, and SHALL return stdout and stderr combined in arrival order, followed by a status line. A zero exit status SHALL give a normal result; a non-zero one SHALL give an error result. It SHALL always need approval.

#### Scenario: Success

- **WHEN** the command is `echo hello`
- **THEN** the result is "hello" followed by the line "[exit code 0]", not an error

#### Scenario: Failure

- **WHEN** the command is `echo oops >&2; exit 3`
- **THEN** the result contains "oops" and "[exit code 3]", and is an error

#### Scenario: Runs in the project root

- **WHEN** the command is `pwd`
- **THEN** the output is the project root

#### Scenario: No input

- **WHEN** the command is `read line; echo "got:$line"`
- **THEN** it finishes at once, printing "got:" with nothing after it

### Requirement: Time limit

A command still running after 2 minutes SHALL be stopped, together with every process it started, and the result SHALL be an error ending with "[timed out after 120 s]".

#### Scenario: Stalled command

- **WHEN** the command is `sleep 1000` and the time limit passes
- **THEN** the result is an error ending with the timeout line, and no `sleep` process is left running

### Requirement: Cancellation

When the call's signal aborts, `bash` SHALL stop the command and every process it started (SIGTERM to its process group, SIGKILL after 2 seconds), and SHALL return the output so far followed by "[cancelled]", as an error result.

#### Scenario: Cancelled with a child process

- **WHEN** the command is `sleep 1000 & wait`, and the signal aborts
- **THEN** the result ends with "[cancelled]", and neither `bash` nor `sleep` is left running

### Requirement: Output kept in memory is bounded

`bash` SHALL keep at most the first and the last 100,000 characters of a command's output, and SHALL say how many characters were left out between them.

#### Scenario: Huge output

- **WHEN** the command prints 1,000,000 characters
- **THEN** the result holds the first and last 100,000 characters and a note giving the number left out

### Requirement: Secrets are kept out of the environment

`bash` SHALL run with the user's environment minus `ANTHROPIC_API_KEY` and every variable whose name contains `API_KEY`, `TOKEN`, `SECRET` or `PASSWORD`.

#### Scenario: Key not visible

- **WHEN** torno runs with `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` set, and the command is `env`
- **THEN** neither variable's name nor value appears in the result

### Requirement: Invalid input is reported

`bash` SHALL answer input without a non-empty `command` string with an error result, without running anything.

#### Scenario: Empty command

- **WHEN** the model calls `bash` with `{ "command": "" }`
- **THEN** the result is an error mentioning `command`
