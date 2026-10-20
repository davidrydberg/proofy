import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "../args.js";
import type { Deps } from "../deps.js";
import { CliError } from "../errors.js";
import { exists, flowNames } from "../project.js";
import { writeApprovals } from "../run/approvals.js";
import { flowStatuses, outDir, readReport, recentReports } from "../run/history.js";
import type { FlowResult } from "../run/results.js";
import { specSection } from "../run/spec.js";
import { GLYPH, painter, resolveStyle } from "../style.js";
import { loadProject } from "./context.js";
import type { CommandResult } from "./types.js";

export const APPROVE_HELP = `usage: proofy approve <flow>
description: For the human, never the agent. Shows the requirements with their results, what the agent assumed and what is not covered, then asks you to type the flow name. After 3 runs with identical results, records fingerprints of the flow's requirements, test and the other files in e2e/tests, every file in e2e/standins, e2e/proofy.json and the compose files with what they include or extend. Works only in an interactive terminal and asks you to type the flow name
examples:
  proofy approve guest-checkout
`;

export async function approveCommand(args: string[], deps: Deps): Promise<CommandResult> {
  const { positionals } = parseArgs(args, { values: [], booleans: [] }, "approve");
  const [name] = positionals;
  if (!name || positionals.length > 1) throw new CliError("Name one flow to approve", "VALIDATION_ERROR", ["Example: proofy approve guest-checkout"]);
  const project = await loadProject(deps);
  const { paths, config, approvals } = project;
  if (!(await flowNames(paths)).includes(name)) throw new CliError(`No flow named ${name}`, "VALIDATION_ERROR", ["Run `proofy` to see flows"]);
  if (!(await exists(join(paths.tests, `${name}.spec.ts`)))) throw new CliError(`${name} has requirements but no test yet`, "VALIDATION_ERROR", ["Ask your agent to write it (step 4 in e2e/AGENTS.md)"]);

  const [status] = await flowStatuses(paths, config, [name], approvals, await recentReports(paths));
  if (!status) throw new CliError(`No flow named ${name}`, "VALIDATION_ERROR");
  if (status.state === "approved") {
    return { data: { flow: name, state: "already approved" }, help: [`Run \`proofy run ${name}\` to check it`] };
  }
  if (!status.approvable) {
    throw new CliError(`${name} cannot be approved yet: ${status.reason ?? status.state}`, "NOT_APPROVED", [
      "Approval needs 3 runs with the current files and identical results per requirement",
      `Run \`proofy run ${name}\` or \`proofy dev test ${name}\` until then`,
    ]);
  }
  const latest = status.runs[0] ? await readReport(paths, status.runs[0]) : undefined;
  const flow = latest?.flows.find((candidate) => candidate.name === name);
  const failing = flow?.requirements.filter((requirement) => requirement.result === "fail" || requirement.result === "not-reached").map((requirement) => requirement.id) ?? [];
  if (!deps.ask) {
    throw new CliError(`Only a person approves: \`proofy approve ${name}\` needs an interactive terminal`, "NOT_APPROVED", [
      "Agents never approve: tell the human the flow is ready",
      `The human runs \`proofy approve ${name}\` in their own terminal and types the flow name to confirm`,
    ]);
  }
  const spec = await readFile(join(paths.specs, `${name}.md`), "utf8");
  const assumed = specSection(spec, "Assumed");
  const report = status.runs[0] ? relative(paths.root, join(outDir(paths), status.runs[0], "report.md")) : undefined;
  const typed = await deps.ask(review(name, flow, assumed, specSection(spec, "Not covered"), report, deps.env));
  if (typed.trim() === "") {
    throw new CliError(`Not approved: ${name} stays as it is`, "NOT_APPROVED", [`Tell your agent what to change in one sentence, then run \`proofy approve ${name}\` once it has proven the flow again`]);
  }
  if (typed.trim() !== name) {
    throw new CliError(`Not approved: the answer was not ${name}`, "NOT_APPROVED", [`Run \`proofy approve ${name}\` again and type ${name} to approve it`]);
  }
  approvals.flows[name] = { ...status.fingerprint, approvedAt: deps.now().toISOString(), runs: status.runs, requirements: flow?.requirements.length ?? 0 };
  await writeApprovals(paths, approvals);
  const help = [`Commit e2e/proofy.lock.json with the flow's files`, `Run \`proofy run --all\` to check every approved flow`];
  if (failing.length > 0) help.unshift(`${failing.join(", ")} fail on purpose as findings: runs stay red until the app is fixed`);
  return {
    data: { flow: name, state: "approved", assumed, requirements: flow?.requirements.map((requirement) => `${requirement.id} ${requirement.result}`) ?? [], based_on_runs: status.runs },
    help,
  };
}

/** Everything the person approves, on one screen: results per requirement, the agent's assumptions, the gaps and where the evidence is. */
function review(name: string, flow: FlowResult | undefined, assumed: string[], notCovered: string[], report: string | undefined, env: NodeJS.ProcessEnv): string {
  const p = painter(resolveStyle(env, true, undefined));
  const mark = { pass: p.green(GLYPH.ok), fail: p.red(GLYPH.fail), "not-reached": p.red(GLYPH.fail) } as Record<string, string>;
  const lines = [p.bold(`Review ${name} before you approve it`), "", "Requirements, the same in each of the last 3 runs:"];
  for (const requirement of flow?.requirements ?? []) {
    const outcome = requirement.result === "pass" ? "" : p.dim(` (${requirement.result}${requirement.why ? `: ${requirement.why}` : ""})`);
    lines.push(`  ${mark[requirement.result] ?? p.yellow(GLYPH.warn)} ${requirement.id} ${requirement.text}${outcome}`);
    if (requirement.result === "fail" && requirement.expected !== undefined) {
      lines.push(p.dim(`      expected ${requirement.expected}, got ${requirement.actual ?? "nothing"}: a finding, the run stays red until the app is fixed`));
    }
  }
  if (!flow || flow.requirements.length === 0) lines.push("  none");
  lines.push("", assumed.length > 0 ? p.yellow("Assumed by the agent, not said by you:") : "Assumed by the agent: nothing");
  for (const item of assumed) lines.push(`  ${p.yellow(GLYPH.warn)} ${item}`);
  if (notCovered.length > 0) {
    lines.push("", "Not covered:");
    for (const item of notCovered) lines.push(`  ${GLYPH.dot} ${item}`);
  }
  if (report) lines.push("", `Evidence and screenshots: ${report}`);
  lines.push(
    "",
    `Approving trusts the requirements, test and fakes, e2e/proofy.json and the compose files as they are now.`,
    `Anything wrong? Press Enter, tell your agent in one sentence, and approve once it has proven the flow again.`,
    `Type ${name} to approve it: `,
  );
  return lines.join("\n");
}
