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
}

export async function fingerprint(paths: Paths, config: Config, flow: string): Promise<Fingerprint> {
  return {
    spec: await hashFile(join(paths.specs, `${flow}.md`)),
    test: await hashFile(join(paths.tests, `${flow}.spec.ts`)),
    fakes: await fakesHash(paths, config),
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

export function sameFingerprint(a: Fingerprint | undefined, b: Fingerprint | undefined): boolean {
  return a !== undefined && b !== undefined && a.spec === b.spec && a.test === b.test && a.fakes === b.fakes;
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
