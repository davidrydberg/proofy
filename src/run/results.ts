import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { sameJson, showValue } from "../test/compare.js";
import type { Entry } from "../test/index.js";
import type { ServiceImage } from "../sandbox/sandbox.js";
import type { Fingerprint } from "./fingerprint.js";
import type { Requirement } from "./spec.js";

export type RequirementOutcome = "pass" | "fail" | "not-covered" | "not-reached" | "not-checked";

export interface RequirementResult {
  id: string;
  text: string;
  result: RequirementOutcome;
  did?: string;
  expected?: string;
  actual?: string;
  /** Who decided the shown claim: proofy, by comparing expected and actual, or the test, with its own ok. */
  decidedBy?: "proofy" | "test";
  evidence?: unknown;
  why?: string;
  fakes: string[];
}

export interface TestResult {
  title: string;
  status: string;
  durationMs: number;
  error?: string;
  trace?: string;
}

export interface FlowResult {
  name: string;
  approved: boolean;
  /** What changed since the flow was approved, when it was approved before. */
  changed?: string[];
  fingerprint: Fingerprint;
  status: "passed" | "failed";
  requirements: RequirementResult[];
  tests: TestResult[];
  shots: Array<{ test: string; file: string; label: string }>;
  /** Claims citing a requirement number the spec does not have. */
  unknownClaims: string[];
}

export interface OutsideCall {
  host: string;
  handledAs: string;
  count: number;
}

export interface RunReport {
  id: string;
  kind: "run" | "dev";
  startedAt: string;
  finishedAt: string;
  /** `approvalsChanged`: flows whose entry in e2e/proofy.lock.json the pull request adds, changes or removes. */
  source: { commit?: string; dirty?: boolean; pr?: number; approvalsChanged?: string[] };
  flows: FlowResult[];
  outside: OutsideCall[];
  /** Names the app looked up but never sent an HTTP request to, such as an SMTP host. */
  lookedUpOnly: string[];
  notes: string[];
  /** The image each service ran, when the install phase finished. */
  images?: ServiceImage[];
  environmentError?: string;
}

export interface PlannedFlow {
  name: string;
  approved: boolean;
  /** What changed since the flow was approved, when it was approved before. */
  changed?: string[];
  fingerprint: Fingerprint;
  requirements: Requirement[];
}

interface PwResult {
  status: string;
  duration: number;
  errors?: Array<{ message?: string }>;
  error?: { message?: string };
  attachments?: Array<{ name: string; path?: string }>;
}
interface PwSpec {
  title: string;
  file: string;
  tests: Array<{ results: PwResult[] }>;
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  suites?: PwSuite[];
  errors?: Array<{ message?: string }>;
}

/** Reads what the runner and the fake-service container wrote to the run folder. */
export async function collectResults(outDir: string, planned: PlannedFlow[]): Promise<Pick<RunReport, "flows" | "outside" | "lookedUpOnly" | "environmentError">> {
  const pw = (await readJson(join(outDir, "playwright.json"))) as PwReport | undefined;
  const tests = new Map<string, TestResult[]>();
  for (const spec of specsOf(pw?.suites ?? [])) {
    const flow = basename(spec.file).replace(/\.spec\.[cm]?[jt]s$/, "");
    for (const test of spec.tests) {
      const result = test.results.at(-1);
      if (!result) continue;
      const messages = [...new Set([result.error?.message, ...(result.errors ?? []).map((error) => error.message)].filter((message): message is string => Boolean(message)))];
      const error = messages.join("\n\n");
      const trace = result.attachments?.find((attachment) => attachment.name === "trace")?.path;
      const list = tests.get(flow) ?? [];
      list.push({
        title: spec.title,
        status: result.status,
        durationMs: result.duration,
        ...(error ? { error: stripAnsi(error).slice(0, 2000) } : {}),
        ...(trace ? { trace: trace.replace(/^\/out\//, "") } : {}),
      });
      tests.set(flow, list);
    }
  }

  const flows: FlowResult[] = [];
  for (const plan of planned) {
    const entries = await readLines<Entry>(join(outDir, "flows", plan.name, "claims.jsonl"));
    const flowTests = tests.get(plan.name) ?? [];
    flows.push(flowResult(plan, entries, flowTests));
  }

  const requests = await readLines<{ host: string; handledAs: string }>(join(outDir, "requests.jsonl"));
  const counts = new Map<string, OutsideCall>();
  for (const request of requests) {
    const key = `${request.host} ${request.handledAs}`;
    const entry = counts.get(key) ?? { host: request.host, handledAs: request.handledAs, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  const contacted = new Set(requests.map((request) => request.host));
  const lookups = await readLines<{ name: string }>(join(outDir, "dns.jsonl"));
  const environmentError = pw?.errors?.map((error) => stripAnsi(error.message ?? "")).find(Boolean);
  return {
    flows,
    outside: [...counts.values()].sort((a, b) => a.host.localeCompare(b.host) || a.handledAs.localeCompare(b.handledAs)),
    lookedUpOnly: [...new Set(lookups.map((lookup) => lookup.name))].filter((name) => !contacted.has(name)).sort(),
    ...(environmentError ? { environmentError: environmentError.slice(0, 2000) } : {}),
  };
}

export function flowResult(plan: PlannedFlow, entries: Entry[], tests: TestResult[]): FlowResult {
  const known = new Set(plan.requirements.map((requirement) => requirement.id));
  const anyTestBroke = tests.length === 0 || tests.some((test) => test.status !== "passed" && !/Requirements not met/.test(test.error ?? ""));
  const requirements = plan.requirements.map((requirement): RequirementResult => {
    const claims = entries.filter((entry): entry is Extract<Entry, { type: "claim" }> => entry.type === "claim" && entry.spec === requirement.id);
    // A compared claim is compared again here from its recorded values, never taken from its ok.
    const failed = claims.find((entry) => !(entry.compared ? sameJson(entry.expected, entry.actual) : entry.ok));
    const shown = failed ?? claims[0];
    if (shown) {
      const fakes = [...new Set(claims.flatMap((entry) => entry.fakes))].sort();
      const compared = shown.compared === true;
      return {
        id: requirement.id,
        text: requirement.text,
        result: failed ? "fail" : "pass",
        did: shown.did,
        expected: showValue(shown.expected, compared),
        actual: showValue(shown.actual, compared),
        decidedBy: compared ? "proofy" : "test",
        ...(shown.evidence === undefined ? {} : { evidence: shown.evidence }),
        fakes,
      };
    }
    const skipped = entries.find((entry): entry is Extract<Entry, { type: "not-covered" }> => entry.type === "not-covered" && entry.spec === requirement.id);
    if (skipped) return { id: requirement.id, text: requirement.text, result: "not-covered", why: skipped.why, fakes: [] };
    return { id: requirement.id, text: requirement.text, result: anyTestBroke ? "not-reached" : "not-checked", fakes: [] };
  });
  const unknownClaims = [...new Set(entries.flatMap((entry) => (entry.type === "shot" || known.has(entry.spec) ? [] : [entry.spec])))];
  return {
    name: plan.name,
    approved: plan.approved,
    ...(plan.changed ? { changed: plan.changed } : {}),
    fingerprint: plan.fingerprint,
    status: requirements.some((requirement) => failing(requirement.result)) ? "failed" : "passed",
    requirements,
    tests,
    shots: entries.filter((entry): entry is Extract<Entry, { type: "shot" }> => entry.type === "shot").map(({ test, file, label }) => ({ test, file, label })),
    unknownClaims,
  };
}

/** A requirement that did not hold, or that no claim checked in this run: only not-covered is excused, by the test's own reason. */
export function failing(result: RequirementOutcome): boolean {
  return result === "fail" || result === "not-reached" || result === "not-checked";
}

/** The per-requirement results that must be identical across three runs before a flow can be approved. */
export function outcome(flow: FlowResult): string {
  return flow.requirements.map((requirement) => `${requirement.id}:${requirement.result}`).join(" ");
}

function* specsOf(suites: PwSuite[]): Generator<PwSpec> {
  for (const suite of suites) {
    yield* suite.specs ?? [];
    yield* specsOf(suite.suites ?? []);
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function readLines<T>(file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
