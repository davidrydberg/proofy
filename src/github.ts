import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./errors.js";
import { renderMarkdown, verdict } from "./run/report.js";
import type { RunReport } from "./run/results.js";
import { tail, type Proc } from "./sandbox/docker.js";

export const REPORTS_BRANCH = "proofy-reports";
const MARKER = "<!-- proofy -->";
const KEEP = 20;
const HISTORY = 10;

export interface PullRequest {
  number: number;
  sha: string;
  url: string;
}

async function gh(proc: Proc, args: string[], cwd: string): Promise<string> {
  const result = await proc("gh", args, { cwd, timeoutMs: 60_000 });
  if (result.code !== 0) {
    const auth = /auth login|not logged/i.test(result.stderr);
    throw new CliError(`gh ${args.slice(0, 2).join(" ")} failed: ${tail(result.stderr, 3)}`, "ENVIRONMENT_ERROR", [
      auth ? "Run `gh auth login`" : "Check that this repository is on GitHub and gh can reach it",
    ]);
  }
  return result.stdout;
}

export async function pullRequest(proc: Proc, root: string, number?: number): Promise<PullRequest> {
  const args = ["pr", "view", ...(number === undefined ? [] : [String(number)]), "--json", "number,headRefOid,url"];
  let out: string;
  try {
    out = await gh(proc, args, root);
  } catch (error) {
    if (number === undefined && error instanceof CliError) {
      throw new CliError("The current branch has no pull request to post on", "VALIDATION_ERROR", ["Open one first, or name it with --pr <number>"]);
    }
    throw error;
  }
  const parsed = JSON.parse(out) as { number: number; headRefOid: string; url: string };
  return { number: parsed.number, sha: parsed.headRefOid, url: parsed.url };
}

/** The pull request's files in a folder of their own. The working copy is never touched. `root` is the repository's top folder. */
export async function exportPullRequest(proc: Proc, root: string, pr: PullRequest, dir: string): Promise<void> {
  const fetch = await proc("git", ["-C", root, "fetch", "--quiet", "origin", `refs/pull/${pr.number}/head`], { timeoutMs: 300_000 });
  if (fetch.code !== 0) {
    throw new CliError(`Fetching pull request #${pr.number} failed`, "ENVIRONMENT_ERROR", [tail(fetch.stderr, 5)]);
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const archive = join(dir, "..", `pr-${pr.number}.tar`);
  const packed = await proc("git", ["-C", root, "archive", "--format=tar", "-o", archive, pr.sha]);
  if (packed.code !== 0) throw new CliError(`Exporting ${pr.sha.slice(0, 12)} failed`, "ENVIRONMENT_ERROR", [tail(packed.stderr, 5)]);
  const unpacked = await proc("tar", ["-xf", archive, "-C", dir]);
  await rm(archive, { force: true });
  if (unpacked.code !== 0) throw new CliError("Unpacking the pull request failed", "ENVIRONMENT_ERROR", [tail(unpacked.stderr, 5)]);
}

/**
 * Pushes the run's screenshots to the reports branch, replaced on every push so the repository never grows,
 * then writes or updates the one proofy comment on the pull request.
 */
export async function postReport(proc: Proc, root: string, pr: PullRequest, report: RunReport, runDir: string, workDir: string): Promise<string> {
  const slug = (await gh(proc, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], root)).trim();
  await publishShots(proc, slug, report, runDir, workDir);
  const imageBase = `https://github.com/${slug}/blob/${REPORTS_BRANCH}/runs/${report.id}`;
  const comments = JSON.parse(await gh(proc, ["api", `repos/${slug}/issues/${pr.number}/comments`, "--paginate", "--slurp"], root)) as Array<Array<{ id: number; body: string }>>;
  const existing = comments.flat().find((comment) => comment.body.startsWith(MARKER));
  const history = [historyLine(report), ...(existing ? previousHistory(existing.body) : [])].slice(0, HISTORY);
  const body = [MARKER, renderMarkdown(report, (path) => `${imageBase}/${path}?raw=true`, { maxShots: 6 }), "### Run history", "", ...history.map((line) => `- ${line}`), ""].join("\n");
  const payload = join(workDir, "comment.json");
  await writeFile(payload, JSON.stringify({ body }));
  if (existing) {
    await gh(proc, ["api", "-X", "PATCH", `repos/${slug}/issues/comments/${existing.id}`, "--input", payload], root);
  } else {
    await gh(proc, ["api", "-X", "POST", `repos/${slug}/issues/${pr.number}/comments`, "--input", payload], root);
  }
  return pr.url;
}

async function publishShots(proc: Proc, slug: string, report: RunReport, runDir: string, workDir: string): Promise<void> {
  const dir = join(workDir, "reports-branch");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const git = (args: string[]) =>
    proc("git", ["-C", dir, "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "-c", "user.name=proofy", "-c", "user.email=proofy@users.noreply.github.com", ...args], {
      timeoutMs: 300_000,
    });
  await git(["init", "--quiet"]);
  await git(["remote", "add", "origin", `https://github.com/${slug}.git`]);
  if ((await git(["fetch", "--quiet", "--depth", "1", "origin", REPORTS_BRANCH])).code === 0) {
    await git(["checkout", "--quiet", "FETCH_HEAD"]);
  }
  const target = join(dir, "runs", report.id);
  await mkdir(target, { recursive: true });
  for (const flow of report.flows) {
    try {
      await cp(join(runDir, "flows", flow.name), join(target, "flows", flow.name), { recursive: true, filter: (source) => !source.endsWith(".jsonl") });
    } catch {
      // A flow that never reached a screenshot.
    }
  }
  await cp(join(runDir, "report.md"), join(target, "report.md"));
  const runs = (await readdir(join(dir, "runs"))).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - KEEP))) {
    await rm(join(dir, "runs", old), { recursive: true, force: true });
  }
  await writeFile(join(dir, "README.md"), `Screenshots for proofy reports. Replaced on every run and keeps the last ${KEEP} runs.\n`);
  await git(["checkout", "--quiet", "--orphan", `proofy-${report.id}`]);
  await git(["add", "-A"]);
  const commit = await git(["commit", "--quiet", "-m", `proofy run ${report.id}`]);
  if (commit.code !== 0) throw new CliError("Committing screenshots failed", "ENVIRONMENT_ERROR", [tail(commit.stderr, 5)]);
  const push = await git(["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${REPORTS_BRANCH}`]);
  if (push.code !== 0) throw new CliError(`Pushing screenshots to ${REPORTS_BRANCH} failed`, "ENVIRONMENT_ERROR", [tail(push.stderr, 5), "Check that gh is logged in with push access"]);
}

function historyLine(report: RunReport): string {
  const counts = report.flows.map((flow) => `${flow.name} ${flow.status}`).join(", ");
  return `${report.id}: ${verdict(report)}${report.source.commit ? ` on ${report.source.commit.slice(0, 7)}` : ""}${counts ? ` (${counts})` : ""}`;
}

function previousHistory(body: string): string[] {
  const section = body.split("### Run history")[1] ?? "";
  return section
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}
