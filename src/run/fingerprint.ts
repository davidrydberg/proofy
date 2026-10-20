import { createHash } from "node:crypto";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config.js";
import type { Paths } from "../project.js";
import { composeSources } from "../sandbox/sources.js";

export interface Fingerprint {
  spec: string;
  /** The flow's test and every other file in tests/ it could import: everything there but other flows' tests. */
  test: string;
  /** Every file in standins/, at any depth, and the hosts list together: a change to any fake can change any flow's result. */
  fakes: string;
  /** e2e/proofy.json without $schema: how the app starts, its settings, seed, commands, hosts, assets and limits. */
  config: string;
  /**
   * The contents of the compose files the config lists and the files they include or extend. The app's own files, such
   * as Dockerfiles, are the code under test.
   */
  compose: string;
}

/** What each part is called when it changed since approval. */
const PARTS: Record<keyof Fingerprint, string> = {
  spec: "requirements",
  test: "test",
  fakes: "fakes",
  config: "e2e/proofy.json",
  compose: "compose files",
};

export async function fingerprint(paths: Paths, config: Config, flow: string): Promise<Fingerprint> {
  return {
    spec: await hashFile(join(paths.specs, `${flow}.md`)),
    test: await testHash(paths, flow),
    fakes: await fakesHash(paths, config),
    config: configHash(config),
    compose: await composeHash(paths, config),
  };
}

async function testHash(paths: Paths, flow: string): Promise<string> {
  const own = `${flow}.spec.ts`;
  const files = (await filesIn(paths.tests)).filter((file) => !file.endsWith(".spec.ts") || basename(file) === own);
  return hashFiles(paths.tests, files);
}

export async function fakesHash(paths: Paths, config: Config): Promise<string> {
  return hashFiles(paths.standins, await filesIn(paths.standins), JSON.stringify(Object.entries(config.hosts).sort()));
}

/** The parsed config, so formatting, key order and spelled-out defaults do not count as changes. */
function configHash(config: Config): string {
  const settings = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "$schema"));
  return short(createHash("sha256").update(JSON.stringify(sortKeys(settings))).digest("hex"));
}

async function composeHash(paths: Paths, config: Config): Promise<string> {
  const hash = createHash("sha256");
  for (const file of (await composeSources(paths.root, config.compose)).files) {
    hash.update(`${file}\n`);
    hash.update(await hashFile(resolve(paths.root, file)));
  }
  return short(hash.digest("hex"));
}

// OS metadata and editor backups. Anything else, hidden or not, can be imported by a test or a fake, so it counts.
const LITTER = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|(~|\.swp|\.swo)$/;

/** Every file and symlink in a folder and its subfolders, relative to it and sorted. None when the folder is missing. */
async function filesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
      .filter((file) => !LITTER.test(file.split(sep).join("/")))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Names and contents together, so renaming or moving a file is a change too. A symlink counts by its target, and a
 * symlinked folder by everything in it.
 */
async function hashFiles(dir: string, files: string[], extra = "", seen = new Set<string>()): Promise<string> {
  const hash = createHash("sha256");
  hash.update(extra);
  for (const file of files) {
    const path = join(dir, file);
    hash.update(`${file}\n`);
    const target = await readlink(path).catch(() => undefined);
    if (target !== undefined) hash.update(`-> ${target}\n`);
    const real = await realpath(path).catch(() => undefined);
    if (real !== undefined && (await stat(real).catch(() => undefined))?.isDirectory()) {
      if (seen.has(real)) continue;
      seen.add(real);
      hash.update(await hashFiles(real, await filesIn(real), "", seen));
    } else {
      hash.update(await readFile(path).catch(() => "unreadable"));
    }
  }
  return short(hash.digest("hex"));
}

/** A fingerprint recorded by proofy 0.1, without config and compose, never matches. */
export function sameFingerprint(a: Partial<Fingerprint> | undefined, b: Partial<Fingerprint> | undefined): boolean {
  return a !== undefined && b !== undefined && changedParts(a, b).length === 0;
}

/** The parts that differ, by name, such as "requirements" or "e2e/proofy.json". */
export function changedParts(approved: Partial<Fingerprint>, current: Partial<Fingerprint>): string[] {
  return (Object.keys(PARTS) as Array<keyof Fingerprint>).filter((part) => approved[part] === undefined || approved[part] !== current[part]).map((part) => PARTS[part]);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

async function hashFile(file: string): Promise<string> {
  try {
    return short(createHash("sha256").update(await readFile(file)).digest("hex"));
  } catch {
    return "missing";
  }
}

function short(hex: string): string {
  return hex.slice(0, 16);
}
