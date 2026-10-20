import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "../args.js";
import type { Deps } from "../deps.js";
import { CliError } from "../errors.js";
import { exists, flowNames } from "../project.js";
import { finishRun, logOffsets, planFlows, reserveRunId, sandboxOptions, testsInSandbox, type RunContext } from "../run/engine.js";
import { outDir } from "../run/history.js";
import { MAIL_USER } from "../sandbox/contract.js";
import { compose, forwardedPorts, installImages, prepare, resetFakes, resolveImages, sandboxProc, sandboxToken, saveLogs, start, stop, type Sandbox, type ServiceImage } from "../sandbox/sandbox.js";
import { loadProject, projectName, workingTreeInfo, type Project } from "./context.js";
import { runResult } from "./run.js";
import type { CommandResult } from "./types.js";

export const DEV_HELP = `usage: proofy dev up|test|down
description: A sealed sandbox that stays up while tests are written. Every dev test counts toward the 3 identical runs approval needs
commands[3]:
  up  Start the sandbox and print where to open the app and Mailpit
  test [flow ...] [-- playwright args]  Run flows in it; with no flows, every flow that has a test
  down  Stop it and delete its data
examples:
  proofy dev up
  proofy dev test guest-checkout
  proofy dev test guest-checkout -- --grep "declined card"
  proofy dev down
`;

// Kept in e2e/out, which the app may mount, so it holds no token.
interface DevState extends Omit<Sandbox, "token"> {
  startedAt: string;
  urls: { app?: string; mail?: string };
  /** Missing in a state file written before proofy recorded images. */
  images?: ServiceImage[];
}

export async function devCommand(args: string[], deps: Deps): Promise<CommandResult> {
  const split = args.indexOf("--");
  const own = split === -1 ? args : args.slice(0, split);
  const extra = split === -1 ? [] : args.slice(split + 1);
  const [sub, ...rest] = own;
  const project = await loadProject(deps);
  switch (sub) {
    case "up":
      parseArgs(rest, { values: [], booleans: [] }, "dev");
      return devUp(deps, project);
    case "test":
      return devTest(deps, project, parseArgs(rest, { values: [], booleans: [] }, "dev").positionals, extra);
    case "down":
      parseArgs(rest, { values: [], booleans: [] }, "dev");
      return devDown(deps, project);
    default:
      throw new CliError(sub ? `Unknown dev command: ${sub}` : "dev needs up, test or down", "VALIDATION_ERROR", ["Run `proofy dev --help`"]);
  }
}

function stateFile(project: Project): string {
  return join(outDir(project.paths), "dev.json");
}

async function readState(project: Project): Promise<DevState | undefined> {
  try {
    return JSON.parse(await readFile(stateFile(project), "utf8")) as DevState;
  } catch {
    return undefined;
  }
}

async function running(deps: Deps, state: DevState): Promise<boolean> {
  const result = await sandboxProc(deps.proc, deps.env)("docker", [...compose(state), "ps", "--status", "running", "-q"]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

function context(deps: Deps, project: Project, sourceInfo: RunContext["sourceInfo"]): RunContext {
  return {
    proc: deps.proc,
    env: deps.env,
    now: deps.now,
    log: deps.log,
    base: project.paths,
    source: project.paths,
    sourceTop: project.top,
    config: project.config,
    approvals: project.approvals,
    cacheDir: project.cacheDir,
    sourceInfo,
  };
}

async function devUp(deps: Deps, project: Project): Promise<CommandResult> {
  const existing = await readState(project);
  if (existing && (await running(deps, existing))) {
    return upResult(existing, await sandboxToken(existing), true);
  }
  const ctx = context(deps, project, {});
  const options = sandboxOptions(ctx, "dev", projectName(project.root, "dev"), outDir(project.paths));
  const docker = sandboxProc(deps.proc, deps.env);
  let sandbox = await prepare(docker, options);
  let images: ServiceImage[];
  try {
    await installImages(docker, options, sandbox);
    images = await resolveImages(docker, sandbox);
    sandbox = await start(docker, options, sandbox);
  } catch (error) {
    await saveLogs(docker, sandbox, outDir(project.paths));
    await stop(docker, sandbox);
    throw error;
  }
  const { token, ...kept } = sandbox;
  const state: DevState = { ...kept, startedAt: deps.now().toISOString(), urls: await forwardedPorts(docker, sandbox), images };
  await writeFile(stateFile(project), `${JSON.stringify(state, null, 2)}\n`);
  return upResult(state, token, false);
}

function upResult(state: DevState, token: string | undefined, already: boolean): CommandResult {
  // Mailpit asks for its login; in the address, the browser sends it.
  const mail = state.urls.mail && token ? state.urls.mail.replace("http://", `http://${MAIL_USER}:${token}@`) : (state.urls.mail ?? "not forwarded");
  const help = [
    "Run `proofy dev test <flow>` to run a flow in it; three identical runs make it ready to approve",
    "Run `proofy dev down` when done",
  ];
  const data: Record<string, unknown> = { sandbox: state.project, status: already ? "already running" : "started", app: state.urls.app ?? "not forwarded", mailpit: mail };
  if (state.notes.length > 0) data.notes = state.notes;
  return {
    data,
    help,
    pretty: () =>
      [
        `dev sandbox ${state.project} ${already ? "already running" : "started"}, sealed`,
        `  app      ${state.urls.app ?? "not forwarded"}  (links inside the app may use its in-sandbox name)`,
        `  mailpit  ${mail}`,
        ...state.notes.map((note) => `  note: ${note}`),
        "",
        "NEXT",
        "  proofy dev test <flow>  run a flow; three identical runs make it ready to approve",
        "  proofy dev down         stop it and delete its data",
      ].join("\n"),
  };
}

async function devTest(deps: Deps, project: Project, names: string[], extra: string[]): Promise<CommandResult> {
  const saved = await readState(project);
  if (!saved || !(await running(deps, saved))) {
    throw new CliError("The dev sandbox is not running", "VALIDATION_ERROR", ["Run `proofy dev up` first"]);
  }
  // A sandbox prepared before sandboxes had a token: its fake-service container and Mailpit do not ask for one.
  const token = await sandboxToken(saved);
  if (!token) {
    throw new CliError("The dev sandbox was started by an older proofy", "VALIDATION_ERROR", ["Run `proofy dev down`, then `proofy dev up`"]);
  }
  const state = { ...saved, token };
  const available = await flowNames(project.paths);
  const withTests: string[] = [];
  for (const name of available) if (await exists(join(project.paths.tests, `${name}.spec.ts`))) withTests.push(name);
  const chosen = names.length > 0 ? names : withTests;
  for (const name of chosen) {
    if (!withTests.includes(name)) {
      throw new CliError(available.includes(name) ? `${name} has no test yet` : `No flow named ${name}`, "VALIDATION_ERROR", [`Flows with tests: ${withTests.join(", ") || "none"}`]);
    }
  }
  if (chosen.length === 0) throw new CliError("No flow has a test yet", "VALIDATION_ERROR", ["Ask your agent to write one (step 4 in e2e/AGENTS.md)"]);
  const ctx = context(deps, project, await workingTreeInfo(deps, project.root));
  const planned = await planFlows(ctx, chosen);
  // Each dev test runs the fakes as they are now, with empty state, and reports only its own calls.
  await resetFakes(sandboxProc(deps.proc, deps.env), state);
  const id = await reserveRunId(ctx);
  const startedAt = deps.now().toISOString();
  const offsets = await logOffsets(state);
  let environmentError: string | undefined;
  try {
    await testsInSandbox(ctx, state, planned, extra);
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "ENVIRONMENT_ERROR") throw error;
    environmentError = [error.message, ...error.suggestions].join("\n");
  }
  const notes = extra.length > 0 ? [`Playwright arguments: ${extra.join(" ")}. A filtered run can leave requirements unchecked`] : [];
  const runDir = join(outDir(project.paths), id);
  const report = await finishRun(ctx, { id, kind: "dev", startedAt, runDir, planned, notes, sandbox: state, offsets, ...(state.images ? { images: state.images } : {}), ...(environmentError ? { environmentError } : {}) });
  return runResult(report, runDir, project.root);
}

async function devDown(deps: Deps, project: Project): Promise<CommandResult> {
  const state = await readState(project);
  if (!state) {
    return { data: { sandbox: "none running" }, help: ["Run `proofy dev up` to start one"] };
  }
  const docker = sandboxProc(deps.proc, deps.env);
  await saveLogs(docker, state, outDir(project.paths));
  await stop(docker, state);
  await rm(stateFile(project), { force: true });
  return { data: { sandbox: state.project, status: "stopped, data deleted" }, help: ["Run `proofy` to see each flow's state"] };
}
