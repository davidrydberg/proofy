import { basename, join } from "node:path";
import { loadConfig, type Config } from "../config.js";
import type { Deps } from "../deps.js";
import { CliError } from "../errors.js";
import { renderHome, type Check, type Hint } from "../human.js";
import type { Data } from "../output.js";
import { exists, findRoot, flowNames, orphanTests, pathsFor } from "../project.js";
import { readApprovals } from "../run/approvals.js";
import { flowStatuses, recentReports, type FlowStatus } from "../run/history.js";
import { verdict } from "../run/report.js";
import type { CommandResult } from "./types.js";

const SETUP_ASK = 'Ask your agent: "set up proofy". It follows the Setup section of e2e/AGENTS.md';

// Runs from session-start hooks: reads files only, never starts Docker, never exits non-zero.
export async function homeCommand(deps: Deps): Promise<CommandResult | string> {
  try {
    return await home(deps);
  } catch (error) {
    return `proofy: could not read this project: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function home(deps: Deps): Promise<CommandResult | string> {
  const root = await findRoot(deps.cwd);
  const paths = pathsFor(root);
  const project = basename(root);
  if (!(await exists(paths.config))) {
    return `proofy: not set up in ${project}. Run \`proofy init\` to add end-to-end tests your agent writes and you approve`;
  }

  let config: Config;
  try {
    config = await loadConfig(paths.config, "e2e/proofy.json");
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return { data: { project, config: `invalid: ${error.message}` }, help: error.suggestions, pretty: () => `proofy: ${project}: ${error.message}` };
  }

  const checks = await setupChecks(config, root);
  const reports = await recentReports(paths);
  let flows: FlowStatus[];
  try {
    flows = await flowStatuses(paths, config, await flowNames(paths), await readApprovals(paths), reports);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return { data: { project, approvals: `invalid: ${error.message}` }, help: error.suggestions };
  }
  const orphans = await orphanTests(paths);
  const steps = nextSteps(checks, flows, orphans);
  const last = reports[0];
  const lastRun = last ? `${last.id} ${last.kind}: ${verdict(last)}` : "none";

  const data: Data = { project, setup: checks.map((check) => ({ item: check.label, ok: check.ok ? "yes" : "no", value: check.value })) };
  data.flows = flows.length > 0 ? flows.map((flow) => ({ flow: flow.name, state: flow.state, detail: detail(flow) })) : "none";
  if (orphans.length > 0) data.tests_without_requirements = orphans;
  data.last_run = lastRun;
  return {
    data,
    help: steps.map(([command, description]) => (description ? `Run \`${command}\` ${description}` : command)),
    json: { project, setup: checks, flows: flows.map(({ name, state, runs, reason, changed }) => ({ name, state, runs, ...(reason ? { reason } : {}), ...(changed ? { changed } : {}) })), testsWithoutRequirements: orphans, lastRun: last?.id ?? null },
    pretty: (style) => renderHome({ project, checks, flows: flows.map((flow) => ({ name: flow.name, state: flow.state, reason: detail(flow) })), orphans, lastRun }, steps, style),
  };
}

/** Why a flow is in its state: what changed since approval, then what its runs still lack. */
function detail(flow: FlowStatus): string {
  return [flow.changed ? `changed since approval: ${flow.changed.join(", ")}` : undefined, flow.reason].filter(Boolean).join("; ");
}

async function setupChecks(config: Config, root: string): Promise<Check[]> {
  const missingCompose = [];
  for (const file of config.compose) {
    if (!(await exists(join(root, file)))) missingCompose.push(file);
  }
  const fakes = Object.values(config.hosts).filter((mode) => mode === "fake").length;
  const recorded = Object.values(config.hosts).length - fakes;
  return [
    {
      label: "compose",
      ok: config.compose.length > 0 && missingCompose.length === 0,
      value: config.compose.length === 0 ? "no compose file yet" : missingCompose.length > 0 ? `missing ${missingCompose.join(", ")}` : config.compose.join(", "),
    },
    {
      label: "app",
      ok: config.app !== undefined,
      value: config.app ? `http://${config.app.service}:${config.app.port}${config.app.path}` : "which service and port the browser opens",
    },
    {
      label: "seed",
      ok: true,
      value: config.seed ? `${config.seed.service}: ${config.seed.command.join(" ")}` : "none, fine if the app starts with the data it needs",
    },
    {
      label: "hosts",
      ok: true,
      value: Object.keys(config.hosts).length === 0 ? "none listed, every outside call is refused" : `${fakes} fake, ${recorded} recorded`,
    },
  ];
}

// The order is the onboarding: finish setup, then describe flows, then write tests, then prove them.
function nextSteps(checks: Check[], flows: FlowStatus[], orphans: string[]): Hint[] {
  const steps: Hint[] = [];
  const named = (state: FlowStatus["state"]) => flows.filter((flow) => flow.state === state).map((flow) => flow.name);
  const missing = checks.filter((check) => !check.ok).map((check) => check.label);
  if (missing.length > 0) {
    steps.push([`Setup is missing: ${missing.join(", ")}. ${SETUP_ASK}`, ""]);
  }
  if (flows.length === 0) {
    steps.push(['Tell your agent what to test, in plain words: "add a proofy test: a guest can buy a product and gets a confirmation email"', ""]);
  }
  if (named("draft").length > 0) {
    steps.push([`Ask your agent to write the tests for: ${named("draft").join(", ")} (step 4 in e2e/AGENTS.md)`, ""]);
  }
  for (const state of ["unproven", "unstable"] as const) {
    const list = flows.filter((flow) => flow.state === state);
    if (list.length > 0) {
      const what = state === "unstable" ? "Fix the flaky tests in" : "Prove";
      steps.push([`${what} ${list.map((flow) => `${flow.name} (${flow.reason ?? state})`).join(", ")}: \`proofy dev test <flow>\` until 3 runs match (step 5 in e2e/AGENTS.md)`, ""]);
    }
  }
  const ready = flows.filter((flow) => flow.approvable).map((flow) => flow.name);
  if (ready.length > 0) {
    steps.push([`Ready for the human to approve: ${ready.map((name) => `\`proofy approve ${name}\``).join(", ")}. Agents never approve`, ""]);
  }
  const stale = flows.filter((flow) => flow.state === "out-of-date" && !ready.includes(flow.name));
  if (stale.length > 0) {
    steps.push([`Changed since approval: ${stale.map((flow) => `${flow.name} (${flow.changed?.join(", ") ?? "changed"})`).join(", ")}. Prove them again with 3 matching runs, then the human approves again`, ""]);
  }
  if (orphans.length > 0) {
    steps.push([`Tests without requirements: ${orphans.join(", ")}. Write e2e/specs/<flow>.md for each, or delete the test`, ""]);
  }
  if (named("approved").length > 0) {
    steps.push(["proofy run --all", "to check every approved flow in a fresh sealed sandbox"]);
  }
  steps.push(["proofy --help", "for every command"]);
  return steps;
}
