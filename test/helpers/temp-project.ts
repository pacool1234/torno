// A throwaway project directory for the file tools' tests: a real folder in
// the system's temp directory, with a sibling "outside" folder for escape
// tests, removed after each test.

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ReadLog } from "../../src/adapters/tools/read-log.ts";
import { Workspace } from "../../src/adapters/tools/workspace.ts";

export type TempProject = {
  base: string;
  root: string;
  workspace: Workspace;
  log: ReadLog;
  // Paths are relative to the root.
  write: (path: string, content: string) => Promise<void>;
  read: (path: string) => Promise<string>;
  remove: () => Promise<void>;
};

export async function tempProject(): Promise<TempProject> {
  // realpath: the temp directory may itself sit behind a symlink.
  const base = await realpath(await mkdtemp(join(tmpdir(), "torno-tools-")));
  const root = join(base, "proj");
  await mkdir(root);
  await mkdir(join(base, "outside"));
  return {
    base,
    root,
    workspace: await Workspace.open(root),
    log: new ReadLog(),
    write: async (path, content) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    },
    read: (path) => readFile(join(root, path), "utf8"),
    remove: () => rm(base, { recursive: true, force: true }),
  };
}
