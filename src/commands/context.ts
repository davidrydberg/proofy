import { loadConfig, type Config } from "../config.js";
import type { Deps } from "../deps.js";
import { CliError } from "../errors.js";
import { exists, findRoot, pathsFor, type Paths } from "../project.js";
import { readApprovals, type Approvals } from "../run/approvals.js";
import type { RunReport } from "../run/results.js";
import { cacheDirFor } from "../sandbox/sandbox.js";

export interface Project {
  root: string;
  paths: Paths;
  config: Config;
  approvals: Approvals;
  cacheDir: string;
}

export async function loadProject(deps: Deps): Promise<Project> {
  const root = await findRoot(deps.cwd);
  const paths = pathsFor(root);
  if (!(await exists(paths.config))) {
    throw new CliError("proofy is not set up in this repository", "NOT_SET_UP", ["Run `proofy init`"]);
  }
  const config = await loadConfig(paths.config, "e2e/proofy.json");
  return { root, paths, config, approvals: await readApprovals(paths), cacheDir: cacheDirFor(deps.env, root) };
}

export async function workingTreeInfo(deps: Deps, root: string): Promise<RunReport["source"]> {
  const head = await deps.proc("git", ["-C", root, "rev-parse", "HEAD"]);
  const status = await deps.proc("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"]);
  return {
    ...(head.code === 0 ? { commit: head.stdout.trim() } : {}),
    ...(status.code === 0 ? { dirty: status.stdout.trim().length > 0 } : {}),
  };
}

/** Project name for docker compose: lowercase letters, digits and dashes. */
export function projectName(root: string, suffix: string): string {
  const base = root.split("/").filter(Boolean).at(-1) ?? "app";
  return `proofy-${base}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 60);
}
