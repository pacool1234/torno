# Tasks

Each group is test-first and sized for one review. The AI stops after each group for the human's review.

## 1. Path confinement and secret files

- [x] 1.1 Write tests for resolving a path inside the root (parent escape, symlink out, prefix look-alike, absolute path inside, new file in a new directory, new file under a symlink out, `.env` and `.env.local` refused, `.env.example` allowed, symlink to `.env`), using real temporary directories; verify they fail
- [x] 1.2 Implement the workspace (`src/adapters/tools/workspace.ts`: root resolved once, `resolveInside`, the secret-file rule); verify the tests pass

## 2. read_file and the read log

- [x] 2.1 Write tests: text returned unchanged and recorded, missing file, directory, file over 1 MB, binary file, invalid input, confinement and secret refusals reported as error results; verify they fail
- [x] 2.2 Implement the read log (path → SHA-256) and `read_file`; verify the tests pass

## 3. write_file and edit_file

- [x] 3.1 Write tests: create with parent directories, replace after a read, replace without a read, file changed since read, two edits in a row, unique match, zero and several matches, dollar signs, invalid input, refusals; verify they fail
- [x] 3.2 Implement both tools; verify the tests pass
- [x] 3.3 Write tests for `summarizeCall` (bash, edit, write create/replace, malformed input as JSON), then implement it

## 4. bash

- [x] 4.1 Write tests: success and exit codes, working directory, stdin closed, stdout and stderr combined, time limit (short limit injected for the test), cancellation stopping a child process, bounded output, secrets removed from the environment, invalid input; verify they fail
- [x] 4.2 Implement `bash`; verify the tests pass

## 5. REPL rendering and approval

- [ ] 5.1 Write tests for rendering each agent event and each turn ending, and for the approval question (default no, y/yes in any case, summary shown); verify they fail
- [ ] 5.2 Implement them; verify the tests pass

## 6. The session and the wiring

- [ ] 6.1 Write tests driving the REPL with in-memory streams and a scripted provider: two turns keep the conversation, empty lines ignored, `exit` and end of input, Ctrl-C while streaming, at the approval question, and at the prompt; verify they fail
- [ ] 6.2 Implement the session loop, then `src/main.ts` with the system prompt (and a test for the bad-configuration exit); verify the tests pass
- [ ] 6.3 Run torno by hand against Ollama and Claude Haiku on a small scratch repo: a read, an approved edit, a denied command, Ctrl-C mid-stream; report what happened

## 7. Close the change

- [ ] 7.1 Run the full `REVIEW.md` review of the change and resolve its findings
- [ ] 7.2 Verify all scripts pass locally and CI is green on GitHub
- [ ] 7.3 Run `pnpm exec openspec validate tools-and-repl --strict`, archive the change, and format the archived specs
