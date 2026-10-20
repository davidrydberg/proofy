import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { exists, type Paths } from "../project.js";
import type { Approvals } from "./approvals.js";
import { changedParts, fingerprint, sameFingerprint, type Fingerprint } from "./fingerprint.js";
import { outcome, type FlowResult, type RunReport } from "./results.js";

export const KEEP_RUNS = 20;
const RUN_ID = /^\d{8}-\d{6}(-\d+)?$/;

export type FlowState = "draft" | "unproven" | "unstable" | "ready" | "approved" | "out-of-date";

export interface FlowStatus {
  name: string;
  state: FlowState;
  /** Runs with the current files, newest first, up to three. */
  runs: string[];
  /** Why a flow with three runs is still not ready, such as a requirement no test checks. */
  reason?: string;
  /** What changed since an out-of-date flow was approved, such as "test" or "e2e/proofy.json". */
  changed?: string[];
  fingerprint: Fingerprint;
}

export function outDir(paths: Paths): string {
  return join(paths.e2e, "out");
}

export async function runIds(paths: Paths): Promise<string[]> {
  try {
    return (await readdir(outDir(paths))).filter((name) => RUN_ID.test(name)).sort();
  } catch {
    return [];
  }
}

export async function readReport(paths: Paths, id: string): Promise<RunReport | undefined> {
  try {
    return JSON.parse(await readFile(join(outDir(paths), id, "report.json"), "utf8")) as RunReport;
  } catch {
    return undefined;
  }
}

/** Newest first. */
export async function recentReports(paths: Paths): Promise<RunReport[]> {
  const ids = (await runIds(paths)).reverse();
  const reports = await Promise.all(ids.map((id) => readReport(paths, id)));
  return reports.filter((report): report is RunReport => report !== undefined);
}

export async function pruneRuns(paths: Paths): Promise<void> {
  const ids = await runIds(paths);
  for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_RUNS))) {
    await rm(join(outDir(paths), id), { recursive: true, force: true });
  }
}

export async function flowStatuses(paths: Paths, config: Config, names: string[], approvals: Approvals, reports: RunReport[]): Promise<FlowStatus[]> {
  const out: FlowStatus[] = [];
  for (const name of names) {
    const current = await fingerprint(paths, config, name);
    if (!(await exists(join(paths.tests, `${name}.spec.ts`)))) {
      out.push({ name, state: "draft", runs: [], fingerprint: current });
      continue;
    }
    const approval = approvals.flows[name];
    const matching: Array<{ id: string; flow: FlowResult }> = [];
    for (const report of reports) {
      if (report.environmentError) continue;
      const flow = report.flows.find((candidate) => candidate.name === name);
      if (flow && sameFingerprint(flow.fingerprint, current)) matching.push({ id: report.id, flow });
      if (matching.length === 3) break;
    }
    const runs = matching.map((match) => match.id);
    if (approval && sameFingerprint(approval, current)) {
      out.push({ name, state: "approved", runs, fingerprint: current });
      continue;
    }
    const proof = proven(matching.map((match) => match.flow));
    const state: FlowState = approval ? "out-of-date" : proof.ok ? "ready" : proof.unstable ? "unstable" : "unproven";
    out.push({ name, state, runs, fingerprint: current, ...(proof.reason ? { reason: proof.reason } : {}), ...(approval ? { changed: changedParts(approval, current) } : {}) });
  }
  return out;
}

/** Three runs with the current files and identical results per requirement, every requirement checked. */
export function proven(flows: FlowResult[]): { ok: boolean; unstable: boolean; reason?: string } {
  if (flows.length < 3) return { ok: false, unstable: false, reason: `${flows.length} of 3 runs with the current files` };
  const outcomes = new Set(flows.map(outcome));
  if (outcomes.size > 1) return { ok: false, unstable: true, reason: "the last 3 runs gave different results" };
  const latest = flows[0];
  const unchecked = latest?.requirements.filter((requirement) => requirement.result === "not-checked").map((requirement) => requirement.id) ?? [];
  if (unchecked.length > 0) return { ok: false, unstable: false, reason: `no claim checks ${unchecked.join(", ")}` };
  if (latest && latest.unknownClaims.length > 0) return { ok: false, unstable: false, reason: `claims cite ${latest.unknownClaims.join(", ")}, which the spec does not have` };
  if (latest && latest.requirements.length === 0) return { ok: false, unstable: false, reason: "the spec has no numbered requirements" };
  return { ok: true, unstable: false };
}
