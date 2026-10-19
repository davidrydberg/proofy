import { join } from "node:path";
import { parseArgs } from "../args.js";
import type { Deps } from "../deps.js";
import { CliError } from "../errors.js";
import { outDir, readReport, runIds } from "../run/history.js";
import { loadProject } from "./context.js";
import { runResult } from "./run.js";
import type { CommandResult } from "./types.js";

export const REPORT_HELP = `usage: proofy report [run]
description: Shows a past run, the latest by default. The full report with evidence and screenshots is e2e/out/<run>/report.md
examples:
  proofy report
  proofy report 20261020-142233
`;

export async function reportCommand(args: string[], deps: Deps): Promise<CommandResult> {
  const { positionals } = parseArgs(args, { values: [], booleans: [] }, "report");
  const project = await loadProject(deps);
  const ids = await runIds(project.paths);
  const id = positionals[0] ?? ids.at(-1);
  if (!id) throw new CliError("No runs yet", "VALIDATION_ERROR", ["Run `proofy run <flow>` or `proofy dev test <flow>`"]);
  const report = await readReport(project.paths, id);
  if (!report) throw new CliError(`No run ${id}`, "VALIDATION_ERROR", [`Runs: ${ids.slice(-5).join(", ") || "none"}`]);
  const result = runResult(report, join(outDir(project.paths), id), project.root);
  // Showing a report is not running it: the verdict is in the output, the command itself succeeded.
  return { ...result, exitCode: 0 };
}
