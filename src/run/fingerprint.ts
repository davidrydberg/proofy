import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Paths } from "../project.js";

export interface Fingerprint {
  spec: string;
  test: string;
  /** Every fake and the hosts list together: a change to any fake can change any flow's result. */
  fakes: string;
  /** e2e/proofy.json without $schema: how the app starts, its settings, seed, commands, hosts, assets and limits. */
  config: string;
  /** The contents of the compose files the config lists. The app's own files, such as Dockerfiles, are the code under test. */
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
    test: await hashFile(join(paths.tests, `${flow}.spec.ts`)),
    fakes: await fakesHash(paths, config),
    config: configHash(config),
    compose: await composeHash(paths, config),
  };
}

export async function fakesHash(paths: Paths, config: Config): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(Object.entries(config.hosts).sort()));
  let files: string[] = [];
  try {
    files = (await readdir(paths.standins)).filter((file) => file.endsWith(".mjs")).sort();
  } catch {
    // No fakes yet.
  }
  for (const file of files) {
    hash.update(file);
    hash.update(await readFile(join(paths.standins, file)));
  }
  return short(hash.digest("hex"));
}

/** The parsed config, so formatting, key order and spelled-out defaults do not count as changes. */
function configHash(config: Config): string {
  const settings = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "$schema"));
  return short(createHash("sha256").update(JSON.stringify(sortKeys(settings))).digest("hex"));
}

async function composeHash(paths: Paths, config: Config): Promise<string> {
  const hash = createHash("sha256");
  for (const file of config.compose) {
    hash.update(`${file}\n`);
    hash.update(await hashFile(join(paths.root, file)));
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
