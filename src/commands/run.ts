import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseArgs } from "../args.js";
import { loadConfig } from "../config.js";
import type { Deps } from "../deps.js";
import { CliError } from "../errors.js";
import { changedApprovals, exportPullRequest, postReport, pullRequest, type PullRequest } from "../github.js";
import { renderRun, type Hint } from "../human.js";
import { exists, flowNames, pathsFor, type Paths } from "../project.js";
import { approvalsFile } from "../run/approvals.js";
import { planFlows, sealedRun, type RunContext } from "../run/engine.js";
import { outDir } from "../run/history.js";
import { EXIT_FOR, verdict } from "../run/report.js";
import { failing, type RunReport } from "../run/results.js";
import { loadProject, projectName, workingTreeInfo } from "./context.js";
import type { CommandResult } from "./types.js";

export const RUN_HELP = `usage: proofy run [flow ...] [--all] [--pr <number>] [--post] [--keep]
description: One sealed run: a fresh sandbox with no way out, the tests, a report per requirement, teardown
flags[4]:
  --all  Every approved flow
  --pr <number>  Test a pull request's code, exported to a cache folder; the working copy is never touched
  --post  Post the report on the pull request (--pr, or the current branch's), screenshots on the proofy-reports branch
  --keep  Leave the sandbox running afterwards
exit_codes[4]:
  0  Every requirement of every approved flow held
  1  A requirement of an approved flow did not hold: a finding about the app
  3  Environment failure: the sandbox did not work
  4  Some flows that ran are not approved, so the result is not trusted
examples:
  proofy run guest-checkout
  proofy run --all
  proofy run --all --pr 42 --post
`;

export async function runCommand(args: string[], deps: Deps): Promise<CommandResult> {
  const flags = parseArgs(args, { values: ["pr"], booleans: ["all", "post", "keep"] }, "run");
  const prNumber = flags.values.has("pr") ? prArg(flags.values.get("pr") ?? "") : undefined;
  if (flags.positionals.length === 0 && !flags.booleans.has("all")) {
    throw new CliError("Name the flows to run, or use --all for every approved flow", "VALIDATION_ERROR", ["Run `proofy` to see flows and their states"]);
  }
  const project = await loadProject(deps);
  const { root, top, paths } = project;

  let source: Paths = paths;
  let sourceTop = top;
  let config = project.config;
  let pr: PullRequest | undefined;
  let sourceInfo: RunReport["source"];
  if (prNumber !== undefined) {
    pr = await pullRequest(deps.proc, root, prNumber);
    const dir = join(project.cacheDir, "pull-requests", String(pr.number));
    deps.log(`exporting pull request #${pr.number} (${pr.sha.slice(0, 12)})`);
    // The project can sit in a subfolder of the repository; the export holds the whole repository.
    await exportPullRequest(deps.proc, top, pr, dir);
    source = pathsFor(join(dir, relative(top, root)));
    sourceTop = dir;
    if (await exists(source.config)) config = await loadConfig(source.config, `e2e/proofy.json in PR #${pr.number}`);
    const approvalsChanged = await changedApprovals(deps.proc, top, pr, relative(top, approvalsFile(paths)).split(sep).join("/"));
    sourceInfo = { commit: pr.sha, pr: pr.number, ...(approvalsChanged.length > 0 ? { approvalsChanged } : {}) };
  } else {
    sourceInfo = await workingTreeInfo(deps, root);
  }

  const available = await flowNames(source);
  const ctx: RunContext = { proc: deps.proc, env: deps.env, now: deps.now, log: deps.log, base: paths, source, sourceTop, config, approvals: project.approvals, cacheDir: project.cacheDir, sourceInfo };
  const names = flags.positionals;
  for (const name of names) {
    if (!available.includes(name)) {
      throw new CliError(`No flow named ${name}: e2e/specs/${name}.md does not exist`, "VALIDATION_ERROR", [`Flows: ${available.join(", ") || "none yet"}`]);
    }
    if (!(await exists(join(source.tests, `${name}.spec.ts`)))) {
      throw new CliError(`${name} has requirements but no test yet`, "VALIDATION_ERROR", ["Ask your agent to write it (step 4 in e2e/AGENTS.md)"]);
    }
  }
  let planned = await planFlows(ctx, names);
  if (flags.booleans.has("all")) {
    const all = await planFlows(ctx, available.filter((name) => !names.includes(name)));
    const approved = all.filter((flow) => flow.approved);
    planned = [...planned, ...approved];
    if (planned.length === 0) {
      throw new CliError(
        pr ? `No flow in PR #${pr.number} matches its approval: none were approved, or the PR changed them` : "No flow is approved yet",
        "NOT_APPROVED",
        ["Run `proofy` to see each flow's state", "Run named flows to prove them: `proofy run <flow>`"],
      );
    }
  }

  const lock = await takeLock(paths);
  const ignore = () => deps.log("stopping: tearing down the sandbox first");
  process.on("SIGINT", ignore);
  let report: RunReport;
  try {
    report = await sealedRun(ctx, planned, { keep: flags.booleans.has("keep"), project: projectName(root, `run-${deps.now().getTime().toString(36)}`) });
  } finally {
    process.off("SIGINT", ignore);
    await rm(lock, { force: true });
  }

  const runDir = join(outDir(paths), report.id);
  let posted: string | undefined;
  if (flags.booleans.has("post")) {
    const target = pr ?? (await pullRequest(deps.proc, root));
    deps.log(`posting the report on pull request #${target.number}`);
    posted = await postReport(deps.proc, root, target, report, runDir, join(project.cacheDir, "post"));
  }
  return runResult(report, runDir, root, posted);
}

export function runResult(report: RunReport, runDir: string, root: string, posted?: string): CommandResult {
  const result = verdict(report);
  const relative = runDir.startsWith(root) ? runDir.slice(root.length + 1) : runDir;
  const failed = report.flows.flatMap((flow) =>
    flow.requirements
      .filter((requirement) => failing(requirement.result))
      .map((requirement) => ({ flow: flow.name, req: requirement.id, expected: requirement.expected ?? "", actual: requirement.actual ?? requirement.result })),
  );
  const hints: Hint[] = [];
  if (result === "environment") hints.push([`Read ${relative}/sandbox.log and fix the sandbox setup; this run says nothing about the app`, ""]);
  if (failed.length > 0) hints.push([`Read ${relative}/report.md: decide per red requirement whether the app, the test, a fake or the requirement is wrong (e2e/AGENTS.md)`, ""]);
  const approvalsChanged = report.source.approvalsChanged ?? [];
  if (approvalsChanged.length > 0) hints.push([`Approval changed in this PR: ${approvalsChanged.join(", ")}. Only a person approves: check in review that each change to e2e/proofy.lock.json is theirs`, ""]);
  const untrusted = report.flows.filter((flow) => !flow.approved).map((flow) => (flow.changed ? `${flow.name} (changed since approval: ${flow.changed.join(", ")})` : flow.name));
  if (untrusted.length > 0 && result !== "environment") hints.push([`Not approved: ${untrusted.join(", ")}. Run \`proofy\` to see whether they are ready for the human to approve`, ""]);
  hints.push([`proofy report ${report.id}`, "show this run again"]);
  const data: Record<string, unknown> = {
    run: report.id,
    verdict: result,
    report: `${relative}/report.md`,
    flows: report.flows.map((flow) => ({ flow: flow.name, approved: flow.approved ? "yes" : "no", status: flow.status, failed: flow.requirements.filter((r) => failing(r.result)).length })),
  };
  if (approvalsChanged.length > 0) data.approvals_changed_in_pr = approvalsChanged;
  if (report.environmentError) data.environment_error = report.environmentError.split("\n")[0];
  if (failed.length > 0) data.failed = failed;
  const refused = report.outside.filter((call) => call.handledAs === "refused");
  if (refused.length > 0) data.refused_hosts = refused.map((call) => call.host);
  if (report.notes.length > 0) data.notes = report.notes;
  if (posted) data.posted = posted;
  return {
    data,
    help: hints.map(([command, description]) => (description ? `Run \`${command}\` to ${description}` : command)),
    json: { ...report, verdict: result, reportFile: `${relative}/report.md`, ...(posted ? { posted } : {}) },
    pretty: (style) => renderRun(report, result, relative, hints, style, posted),
    exitCode: EXIT_FOR[result],
  };
}

async function takeLock(paths: Paths): Promise<string> {
  const file = join(outDir(paths), ".run.lock");
  await mkdir(outDir(paths), { recursive: true });
  try {
    await writeFile(file, String(process.pid), { flag: "wx" });
  } catch {
    const pid = Number(await readFile(file, "utf8").catch(() => "0"));
    if (pid > 0 && alive(pid)) {
      throw new CliError(`Another proofy run is in progress (process ${pid})`, "ENVIRONMENT_ERROR", ["Wait for it to finish; only one run at a time"]);
    }
    await writeFile(file, String(process.pid));
  }
  return file;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function prArg(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new CliError("--pr needs a pull request number", "VALIDATION_ERROR", ["Example: proofy run --all --pr 42"]);
  return number;
}
