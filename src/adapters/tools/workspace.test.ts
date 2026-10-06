import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "./workspace.ts";

let base: string;
let root: string;
let workspace: Workspace;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "torno-ws-")));
  root = join(base, "proj");
  await mkdir(root);
  await mkdir(join(base, "proj-evil"));
  await mkdir(join(base, "outside"));
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  await writeFile(join(base, "outside", "secret.txt"), "top secret\n");
  await writeFile(join(base, "proj-evil", "a.txt"), "evil\n");
  workspace = await Workspace.open(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const OUTSIDE = /outside the project/;
const SECRETS = /may contain secrets/;

async function expectInside(requested: string, expected: string) {
  expect(await workspace.resolve(requested)).toEqual({ ok: true, path: expected });
}

async function expectRefused(requested: string, reason: RegExp) {
  const resolution = await workspace.resolve(requested);
  expect(resolution.ok).toBe(false);
  if (!resolution.ok) {
    expect(resolution.reason).toMatch(reason);
  }
}

describe("Workspace: paths inside the root", () => {
  it("resolves a relative path to the real absolute path", async () => {
    await expectInside("a.ts", join(root, "a.ts"));
  });

  it("accepts an absolute path inside the root", async () => {
    await expectInside(join(root, "a.ts"), join(root, "a.ts"));
  });

  it("follows a symlink that stays inside, to its target", async () => {
    await symlink(join(root, "a.ts"), join(root, "alias.ts"));

    await expectInside("alias.ts", join(root, "a.ts"));
  });

  it("resolves a new file in directories that don't exist yet", async () => {
    await expectInside("src/new/a.ts", join(root, "src", "new", "a.ts"));
  });

  it("accepts a file whose name starts with two dots", async () => {
    await expectInside("..notes", join(root, "..notes"));
  });

  it("works when the root itself was given through a symlink", async () => {
    await symlink(root, join(base, "proj-link"));
    const viaLink = await Workspace.open(join(base, "proj-link"));

    expect(viaLink.root).toBe(root);
    expect(await viaLink.resolve("a.ts")).toEqual({ ok: true, path: join(root, "a.ts") });
  });
});

describe("Workspace: paths outside the root", () => {
  it("refuses ../ escapes", async () => {
    await expectRefused("../outside/secret.txt", OUTSIDE);
  });

  it("refuses an escape hidden in the middle of a path", async () => {
    await expectRefused("src/../../outside/secret.txt", OUTSIDE);
  });

  it("refuses an absolute path elsewhere", async () => {
    await expectRefused("/etc/passwd", OUTSIDE);
  });

  it("refuses a symlink inside the project that points outside", async () => {
    await symlink(join(base, "outside", "secret.txt"), join(root, "link.txt"));

    await expectRefused("link.txt", OUTSIDE);
  });

  it("refuses a sibling whose name starts with the root's name", async () => {
    await expectRefused(join(base, "proj-evil", "a.txt"), OUTSIDE);
  });

  it("refuses a new file under a symlinked directory that points outside", async () => {
    await symlink(join(base, "outside"), join(root, "out"));

    await expectRefused("out/new.txt", OUTSIDE);
  });

  it("refuses a dangling symlink whose target would be outside", async () => {
    await symlink(join(base, "outside", "not-yet.txt"), join(root, "notes.txt"));

    await expectRefused("notes.txt", OUTSIDE);
  });

  it("refuses a path through a dangling symlinked directory pointing outside", async () => {
    await symlink(join(base, "outside", "new-dir"), join(root, "later"));

    await expectRefused("later/a.txt", OUTSIDE);
  });

  it("accepts a dangling symlink whose target would be inside", async () => {
    await symlink(join(root, "future.ts"), join(root, "soon.ts"));

    await expectInside("soon.ts", join(root, "future.ts"));
  });

  it("refuses a symlink loop", async () => {
    await symlink(join(root, "loop-b"), join(root, "loop-a"));
    await symlink(join(root, "loop-a"), join(root, "loop-b"));

    const resolution = await workspace.resolve("loop-a");

    expect(resolution.ok).toBe(false);
  });
});

describe("Workspace: secret files", () => {
  it.each([".env", ".env.local", ".env.production", "config/.env"])("refuses %s", async (name) => {
    await expectRefused(name, SECRETS);
  });

  it("accepts .env.example", async () => {
    await expectInside(".env.example", join(root, ".env.example"));
  });

  it("accepts names that only contain .env", async () => {
    await expectInside("my.env", join(root, "my.env"));
    await expectInside(".envrc", join(root, ".envrc"));
  });

  it("refuses a symlink whose target is .env", async () => {
    await writeFile(join(root, ".env"), "ANTHROPIC_API_KEY=x\n");
    await symlink(join(root, ".env"), join(root, "notes.txt"));

    await expectRefused("notes.txt", SECRETS);
  });
});
