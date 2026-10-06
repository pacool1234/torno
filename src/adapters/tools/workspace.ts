import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Resolution = { ok: true; path: string } | { ok: false; reason: string };

const MAX_LINKS = 40;

export class Workspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(root: string): Promise<Workspace> {
    return new Workspace(await realpath(root));
  }

  async resolve(requested: string): Promise<Resolution> {
    let real: string;
    try {
      real = await realLocation(resolve(this.root, requested));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `Could not resolve "${requested}": ${detail}` };
    }

    if (!isInside(this.root, real)) {
      return { ok: false, reason: `"${requested}" is outside the project (${this.root}).` };
    }
    if (isSecretFile(real)) {
      return {
        ok: false,
        reason: `"${requested}" may contain secrets: .env files are off limits (.env.example is allowed).`,
      };
    }
    return { ok: true, path: real };
  }
}

async function realLocation(absolute: string): Promise<string> {
  let current = absolute;
  const missing: string[] = [];
  let linksFollowed = 0;

  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error: unknown) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    const target = await danglingLinkTarget(current);
    if (target !== undefined) {
      linksFollowed += 1;
      if (linksFollowed > MAX_LINKS) {
        throw new Error("too many symbolic links");
      }
      current = resolve(dirname(current), target);
      continue;
    }

    missing.unshift(basename(current));
    current = dirname(current);
  }
}

async function danglingLinkTarget(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    return stats.isSymbolicLink() ? await readlink(path) : undefined;
  } catch (error: unknown) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot.split(sep)[0] !== ".." && !isAbsolute(fromRoot);
}

function isSecretFile(path: string): boolean {
  const name = basename(path);
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}
