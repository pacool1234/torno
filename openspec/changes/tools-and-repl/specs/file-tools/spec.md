## Purpose

The tools that read, create and edit files in the project: `read_file`, `write_file` and `edit_file`. They implement the `Tool` port, keep every path inside the project root (ADR-0005 level 2), refuse secret files, and only change a file the model has read in its current form.

## ADDED Requirements

### Requirement: Paths stay inside the project root

Every file tool SHALL resolve the requested path against the project root, following `..` and symbolic links (for a path that doesn't exist yet, through its nearest existing ancestor), and SHALL refuse with an error result any path whose resolved location is outside the root. The tool SHALL then operate on the resolved path.

#### Scenario: Parent escape

- **WHEN** the model reads `../outside.txt`
- **THEN** the result is an error saying the path is outside the project, and nothing is read

#### Scenario: Symlink pointing out

- **WHEN** `link.txt` inside the project is a symlink to a file outside it, and the model reads `link.txt`
- **THEN** the result is an error saying the path is outside the project

#### Scenario: Prefix look-alike

- **WHEN** the project root is `/tmp/x/proj`, and the model reads `/tmp/x/proj-evil/a.txt`
- **THEN** the result is an error saying the path is outside the project

#### Scenario: New file in a new directory

- **WHEN** the model writes `src/new/a.ts`, and `src/new` doesn't exist
- **THEN** the directory is created inside the project and the file is written

#### Scenario: New file under a symlinked directory pointing out

- **WHEN** `out` is a symlink to a directory outside the project, and the model writes `out/a.ts`
- **THEN** the result is an error saying the path is outside the project, and nothing is written

#### Scenario: Dangling symlink pointing out

- **WHEN** `notes.txt` is a symlink to a file outside the project that doesn't exist yet, and the model writes `notes.txt`
- **THEN** the result is an error saying the path is outside the project, and nothing is created outside it

### Requirement: Secret files are refused

File tools SHALL refuse, for reading and writing, any path whose resolved file name is `.env` or starts with `.env.`, except `.env.example`, with an error result saying the file may contain secrets.

#### Scenario: Reading .env

- **WHEN** the model reads `.env`
- **THEN** the result is an error saying the file may contain secrets, and its content is not returned

#### Scenario: Symlink to .env

- **WHEN** `notes.txt` is a symlink to `.env`, and the model reads `notes.txt`
- **THEN** the result is the same refusal

#### Scenario: The example file

- **WHEN** the model reads `.env.example`
- **THEN** its content is returned

### Requirement: Reading a file

`read_file` SHALL return the text of a file inside the project, unchanged, and SHALL record it in the session's read log. It SHALL refuse files over 1 MB and files with a NUL byte in their first 8 KB, with an error result saying why. It SHALL NOT need approval.

#### Scenario: Text file

- **WHEN** the model reads `a.ts` containing "export const a = 1;\n"
- **THEN** the result is exactly that text, not an error

#### Scenario: Missing file

- **WHEN** the model reads a file that doesn't exist
- **THEN** the result is an error saying the file doesn't exist

#### Scenario: Binary file

- **WHEN** the model reads a file whose first bytes include a NUL byte
- **THEN** the result is an error saying the file looks binary

### Requirement: Changes need a current read

`edit_file`, and `write_file` on an existing file, SHALL refuse unless the session's read log has an entry for the file and the file's current content hash matches it. After a successful change, the entry SHALL be updated to the new content. `write_file` creating a new file SHALL NOT need an entry, and SHALL record one.

#### Scenario: Edit without reading

- **WHEN** the model edits `a.ts` without having read it in this session
- **THEN** the result is an error asking it to read the file first, and the file is unchanged

#### Scenario: File changed since read

- **WHEN** the model reads `a.ts`, the user then changes `a.ts`, and the model edits it
- **THEN** the result is an error saying the file changed since it was read, and the user's change is kept

#### Scenario: Two edits in a row

- **WHEN** the model reads `a.ts`, edits it, then edits it again without reading
- **THEN** both edits succeed

### Requirement: Editing by unique match

`edit_file` SHALL replace exactly one occurrence of `old_text` with `new_text`. If `old_text` occurs zero times, or more than once, it SHALL fail with an error result (for several, saying how many and asking for more context), and the file SHALL be unchanged. The replacement text SHALL be inserted literally.

#### Scenario: Unique match

- **WHEN** `a.ts` contains "let x = 1;" once, and the model replaces it with "let x = 2;"
- **THEN** the file contains "let x = 2;" and the rest is unchanged

#### Scenario: Several matches

- **WHEN** "x" occurs 3 times in `a.ts`, and the model replaces "x"
- **THEN** the result is an error mentioning 3 occurrences, and the file is unchanged

#### Scenario: Dollar signs in the replacement

- **WHEN** the new text is "cost = $& + $1"
- **THEN** the file contains exactly "cost = $& + $1"

### Requirement: Writing a file

`write_file` SHALL write the given content to a file inside the project, creating missing parent directories, and SHALL report whether it created or replaced the file and how many lines it has. `write_file` and `edit_file` SHALL need approval.

#### Scenario: Create

- **WHEN** the model writes "a\nb\n" to a new file `b.txt`
- **THEN** the file holds exactly "a\nb\n", and the result says it was created with 2 lines

### Requirement: Invalid input is reported

Each file tool SHALL validate its input, and SHALL answer invalid input with an error result naming the problem, without touching the file system.

#### Scenario: Missing path

- **WHEN** the model calls `read_file` with `{}`
- **THEN** the result is an error mentioning `path`
