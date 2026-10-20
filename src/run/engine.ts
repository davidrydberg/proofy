import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { CliError } from "../errors.js";
import type { Paths } from "../project.js";
import { MOUNT } from "../sandbox/contract.js";
import type { Proc } from "../sandbox/docker.js";
import { baseUrl } from "../sandbox/compose.js";
import { installImages, prepare, resolveImages, runTests, saveLogs, start, stop, type Sandbox, type SandboxOptions, type ServiceImage } from "../sandbox/sandbox.js";
import type { Approvals } from "./approvals.js";
import { changedParts, fingerprint, sameFingerprint } from "./fingerprint.js";
import { outDir, pruneRuns } from "./history.js";
import { renderMarkdown } from "./report.js";
import { collectResults, type PlannedFlow, type RunReport } from "./results.js";
import { parseRequirements } from "./spec.js";

export interface RunContext {
  proc: Proc;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  log: (line: string) => void;
  /** Where results and approvals live: always the working copy. */
  base: Paths;
  /** Where the app, tests and fakes come from: the working copy, or an exported pull request. */
  source: Paths;
  config: Config;
  approvals: Approvals;
  cacheDir: string;
  sourceInfo: RunReport["source"];
}

export async function planFlows(ctx: Pick<RunContext, "source" | "config" | "approvals">, names: string[]): Promise<PlannedFlow[]> {
  const planned: PlannedFlow[] = [];
  for (const name of names) {
    const print = await fingerprint(ctx.source, ctx.config, name);
    const specText = await readFile(join(ctx.source.specs, `${name}.md`), "utf8");
    const approval = ctx.approvals.flows[name];
    const approved = sameFingerprint(approval, print);
    planned.push({ name, approved, ...(approval && !approved ? { changed: changedParts(approval, print) } : {}), fingerprint: print, requirements: parseRequirements(specText) });
  }
  return planned;
}

export function newRunId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function sandboxOptions(ctx: RunContext, mode: "run" | "dev", project: string, logDir: string): SandboxOptions {
  return {
    sourceDir: ctx.source.root,
    e2eDir: ctx.source.e2e,
    logDir,
    config: ctx.config,
    mode,
    project,
    cacheDir: ctx.cacheDir,
    env: ctx.env,
    log: ctx.log,
  };
}

/** A whole sealed run: fresh sandbox, tests, results, teardown. Results are written even when the sandbox fails. */
export async function sealedRun(ctx: RunContext, planned: PlannedFlow[], options: { keep: boolean; project: string }): Promise<RunReport> {
  const id = await reserveRunId(ctx);
  const runDir = join(outDir(ctx.base), id);
  const startedAt = ctx.now().toISOString();
  const sandboxOpts = sandboxOptions(ctx, "run", options.project, runDir);
  let sandbox: Sandbox | undefined;
  let environmentError: string | undefined;
  let images: ServiceImage[] | undefined;
  const notes: string[] = [];
  try {
    sandbox = await prepare(ctx.proc, sandboxOpts);
    notes.push(...sandbox.notes);
    await installImages(ctx.proc, sandboxOpts, sandbox);
    images = await resolveImages(ctx.proc, sandbox);
    sandbox = await start(ctx.proc, sandboxOpts, sandbox);
    await testsInSandbox(ctx, sandbox, planned, []);
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "ENVIRONMENT_ERROR") throw error;
    environmentError = [error.message, ...error.suggestions].join("\n");
  } finally {
    if (sandbox) {
      await saveLogs(ctx.proc, sandbox, runDir);
      if (options.keep) {
        notes.push(`Sandbox kept running: docker compose -p ${sandbox.project} -f ${sandbox.composeFile} down -v`);
      } else {
        ctx.log("tearing down the sandbox");
        await stop(ctx.proc, sandbox);
      }
    }
  }
  return finishRun(ctx, { id, kind: "run", startedAt, runDir, planned, notes, ...(environmentError ? { environmentError } : {}), ...(sandbox ? { sandbox } : {}), ...(images ? { images } : {}) });
}

/** Runs the planned flows in a sandbox that is already up: a sealed run's, or the dev sandbox. */
export async function testsInSandbox(ctx: RunContext, sandbox: Sandbox, planned: PlannedFlow[], extraArgs: string[]): Promise<void> {
  const out = join(sandbox.workDir, "out");
  for (const leftover of ["flows", "playwright", "playwright.json", "playwright.log"]) {
    await rm(join(out, leftover), { recursive: true, force: true });
  }
  await writeFile(join(sandbox.workDir, "runner", "playwright.config.mjs"), playwrightConfig(ctx.config, planned.map((flow) => flow.name)));
  ctx.log(`running ${planned.map((flow) => flow.name).join(", ")}`);
  await runTests(ctx.proc, sandboxOptions(ctx, "run", sandbox.project, out), sandbox, extraArgs);
}

export async function finishRun(
  ctx: RunContext,
  run: { id: string; kind: "run" | "dev"; startedAt: string; runDir: string; planned: PlannedFlow[]; notes: string[]; environmentError?: string; sandbox?: Sandbox; offsets?: Offsets; images?: ServiceImage[] },
): Promise<RunReport> {
  await mkdir(run.runDir, { recursive: true });
  if (run.sandbox) await harvest(run.sandbox, run.runDir, run.offsets);
  const collected = await collectResults(run.runDir, run.planned);
  const environmentError = run.environmentError ?? collected.environmentError;
  const report: RunReport = {
    id: run.id,
    kind: run.kind,
    startedAt: run.startedAt,
    finishedAt: ctx.now().toISOString(),
    source: ctx.sourceInfo,
    flows: environmentError ? collected.flows.map((flow) => ({ ...flow, status: "failed" })) : collected.flows,
    outside: collected.outside,
    lookedUpOnly: collected.lookedUpOnly,
    notes: run.notes,
    ...(run.images ? { images: run.images } : {}),
    ...(environmentError ? { environmentError } : {}),
  };
  await writeFile(join(run.runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(run.runDir, "report.md"), renderMarkdown(report, (path) => path));
  await pruneRuns(ctx.base);
  return report;
}

export interface Offsets {
  requests: number;
  dns: number;
}

/** How far the dev sandbox's request logs are, so one dev test only reports its own calls. */
export async function logOffsets(sandbox: Sandbox): Promise<Offsets> {
  return { requests: await lineCount(join(sandbox.workDir, "out", "requests.jsonl")), dns: await lineCount(join(sandbox.workDir, "out", "dns.jsonl")) };
}

async function harvest(sandbox: Sandbox, runDir: string, offsets: Offsets = { requests: 0, dns: 0 }): Promise<void> {
  const out = join(sandbox.workDir, "out");
  for (const entry of ["flows", "playwright", "playwright.json", "playwright.log"]) {
    try {
      await cp(join(out, entry), join(runDir, entry), { recursive: true });
    } catch {
      // Not every run produces every file, for example when the sandbox never started.
    }
  }
  for (const [file, skip] of [["requests.jsonl", offsets.requests], ["dns.jsonl", offsets.dns]] as const) {
    const lines = (await readText(join(out, file))).split("\n").filter(Boolean).slice(skip);
    if (lines.length > 0) await appendFile(join(runDir, file), `${lines.join("\n")}\n`);
  }
}

export async function reserveRunId(ctx: Pick<RunContext, "base" | "now">): Promise<string> {
  const base = newRunId(ctx.now());
  await mkdir(outDir(ctx.base), { recursive: true });
  for (let n = 0; ; n++) {
    const id = n === 0 ? base : `${base}-${n}`;
    try {
      await mkdir(join(outDir(ctx.base), id));
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function playwrightConfig(config: Config, flows: string[]): string {
  const settings = {
    testDir: `${MOUNT.e2e}/tests`,
    testMatch: flows.map((flow) => `**/${flow}.spec.ts`),
    outputDir: `${MOUNT.out}/playwright`,
    timeout: config.limits.testMinutes * 60_000,
    retries: 0,
    workers: config.limits.parallel,
    fullyParallel: true,
    globalSetup: `${MOUNT.pkg}/dist/test/global-setup.js`,
    reporter: [["json", { outputFile: `${MOUNT.out}/playwright.json` }], ["line"]],
    // A step that waits for something that never appears fails after 30 seconds with its locator, not after the whole test timeout.
    use: { baseURL: baseUrl(config), ignoreHTTPSErrors: true, trace: "retain-on-failure", screenshot: "off", video: "off", actionTimeout: 30_000, navigationTimeout: 60_000 },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  };
  return `// Generated by proofy for one run.\nexport default ${JSON.stringify(settings, null, 2)};\n`;
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function lineCount(file: string): Promise<number> {
  return (await readText(file)).split("\n").filter(Boolean).length;
}
