import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Paths {
  root: string;
  e2e: string;
  config: string;
  specs: string;
  tests: string;
  standins: string;
}

/** The git repository's top folder, if there is one. */
export async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 2000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The project proofy works on: the nearest folder from cwd upwards, within the repository, that has
 * e2e/proofy.json. Otherwise the repository root, or cwd outside git. Apps in a subfolder of a monorepo work too.
 */
export async function findRoot(cwd: string): Promise<string> {
  const top = await gitRoot(cwd);
  let dir = resolve(cwd);
  for (;;) {
    if (await exists(join(dir, "e2e", "proofy.json"))) return dir;
    const parent = dirname(dir);
    if (dir === top || parent === dir) break;
    dir = parent;
  }
  return top ?? cwd;
}

export function pathsFor(root: string): Paths {
  const e2e = join(root, "e2e");
  return {
    root,
    e2e,
    config: join(e2e, "proofy.json"),
    specs: join(e2e, "specs"),
    tests: join(e2e, "tests"),
    standins: join(e2e, "standins"),
  };
}

/** Flow names: one per requirements file in e2e/specs. */
export async function flowNames(paths: Paths): Promise<string[]> {
  return (await stems(paths.specs, ".md")).sort();
}

/** Tests without a requirements file: they cannot be traced to anything the user asked for. */
export async function orphanTests(paths: Paths): Promise<string[]> {
  const specs = new Set(await stems(paths.specs, ".md"));
  return (await stems(paths.tests, ".spec.ts")).filter((name) => !specs.has(name)).sort();
}

async function stems(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => basename(entry.name, suffix));
  } catch {
    return [];
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
