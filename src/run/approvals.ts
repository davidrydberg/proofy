import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.js";
import type { Paths } from "../project.js";
import type { Fingerprint } from "./fingerprint.js";

export interface Approval extends Fingerprint {
  approvedAt: string;
  /** The runs whose identical results the approval rests on. */
  runs: string[];
  requirements: number;
}

export interface Approvals {
  version: 1;
  flows: Record<string, Approval>;
}

export function approvalsFile(paths: Paths): string {
  return join(paths.e2e, "proofy.lock.json");
}

export async function readApprovals(paths: Paths): Promise<Approvals> {
  let raw: string;
  try {
    raw = await readFile(approvalsFile(paths), "utf8");
  } catch {
    return { version: 1, flows: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Approvals;
    return { version: 1, flows: parsed.flows ?? {} };
  } catch {
    throw new CliError("e2e/proofy.lock.json is not valid JSON", "CONFIG_INVALID", ["Restore it from git; it records approvals"]);
  }
}

export async function writeApprovals(paths: Paths, approvals: Approvals): Promise<void> {
  const flows = Object.fromEntries(Object.entries(approvals.flows).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(approvalsFile(paths), `${JSON.stringify({ version: 1, flows }, null, 2)}\n`);
}
