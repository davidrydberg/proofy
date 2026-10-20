import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./errors.js";
import { renderMarkdown, verdict, type ReportOptions } from "./run/report.js";
import type { RunReport } from "./run/results.js";
import { tail, type Proc } from "./sandbox/docker.js";

export const REPORTS_BRANCH = "proofy-reports";
const MARKER = "<!-- proofy -->";
const KEEP = 20;
const HISTORY = 10;

export interface PullRequest {
  number: number;
  sha: string;
  /** The branch it merges into, and that branch's commit when it was read. */
  baseRef: string;
  baseSha: string;
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
  const args = ["pr", "view", ...(number === undefined ? [] : [String(number)]), "--json", "number,headRefOid,baseRefName,baseRefOid,url"];
  let out: string;
  try {
    out = await gh(proc, args, root);
  } catch (error) {
    if (number === undefined && error instanceof CliError) {
      throw new CliError("The current branch has no pull request to post on", "VALIDATION_ERROR", ["Open one first, or name it with --pr <number>"]);
    }
    throw error;
  }
  const parsed = JSON.parse(out) as { number: number; headRefOid: string; baseRefName: string; baseRefOid: string; url: string };
  return { number: parsed.number, sha: parsed.headRefOid, baseRef: parsed.baseRefName, baseSha: parsed.baseRefOid, url: parsed.url };
}

/**
 * The pull request's files in a folder of their own. The working copy is never touched. `root` is the repository's top folder.
 * The base branch is fetched too, for `changedApprovals`.
 */
export async function exportPullRequest(proc: Proc, root: string, pr: PullRequest, dir: string): Promise<void> {
  const fetch = await proc("git", ["-C", root, "fetch", "--quiet", "origin", `refs/pull/${pr.number}/head`, `refs/heads/${pr.baseRef}`], { timeoutMs: 300_000 });
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
 * Flows whose entry in the approvals file differs between where the pull request branched off and its head: approvals it adds,
 * changes or removes, so a reviewer sees each one. `lockFile` is relative to the repository's top folder.
 */
export async function changedApprovals(proc: Proc, root: string, pr: PullRequest, lockFile: string): Promise<string[]> {
  const base = await proc("git", ["-C", root, "merge-base", pr.baseSha, pr.sha]);
  if (base.code !== 0) throw new CliError(`Finding where pull request #${pr.number} branched off failed`, "ENVIRONMENT_ERROR", [tail(base.stderr, 5)]);
  const before = await approvalsAt(proc, root, base.stdout.trim(), lockFile);
  const after = await approvalsAt(proc, root, pr.sha, lockFile);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((flow) => JSON.stringify(before[flow]) !== JSON.stringify(after[flow])).sort();
}

async function approvalsAt(proc: Proc, root: string, commit: string, lockFile: string): Promise<Record<string, unknown>> {
  const shown = await proc("git", ["-C", root, "show", `${commit}:${lockFile}`]);
  // No approvals file at that commit. One that is not valid JSON counts as no approvals, so every approval it replaced shows as changed.
  if (shown.code !== 0) return {};
  try {
    return (JSON.parse(shown.stdout) as { flows?: Record<string, unknown> }).flows ?? {};
  } catch {
    return {};
  }
}

/**
 * Pushes the run's screenshots to the reports branch, replaced on every push so the repository never grows,
 * then writes or updates the one proofy comment on the pull request.
 */
export async function postReport(proc: Proc, root: string, pr: PullRequest, report: RunReport, runDir: string, workDir: string): Promise<string> {
  const slug = (await gh(proc, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], root)).trim();
  // A folder of its own per post, so two runs started in the same second never share one.
  const folder = `${report.id}-${randomBytes(3).toString("hex")}`;
  const base = `https://github.com/${slug}/blob/${REPORTS_BRANCH}/runs/${folder}`;
  const comments = JSON.parse(await gh(proc, ["api", `repos/${slug}/issues/${pr.number}/comments`, "--paginate", "--slurp"], root)) as Array<Array<{ id: number; body: string }>>;
  const existing = comments.flat().find((comment) => comment.body.startsWith(MARKER));
  const history = [historyLine(report), ...(existing ? previousHistory(existing.body) : [])].slice(0, HISTORY);
  // Sized before anything is pushed.
  const body = commentBody(report, (path) => `${base}/${path}?raw=true`, `${base}/report.md`, history);
  await publishShots(proc, slug, report, folder, runDir, workDir);
  const payload = join(workDir, "comment.json");
  await writeFile(payload, JSON.stringify({ body }));
  if (existing) {
    await gh(proc, ["api", "-X", "PATCH", `repos/${slug}/issues/comments/${existing.id}`, "--input", payload], root);
  } else {
    await gh(proc, ["api", "-X", "POST", `repos/${slug}/issues/${pr.number}/comments`, "--input", payload], root);
  }
  return pr.url;
}

// Ever shorter versions of the report, tried in order until the comment fits.
const SHORTER: Array<[ReportOptions, string]> = [
  [{}, ""],
  [{ evidence: false }, "evidence left out"],
  [{ evidence: false, cellMax: 80 }, "evidence left out, table cells cut to 80 characters"],
  [{ evidence: false, cellMax: 30, maxShots: 0 }, "evidence and screenshots left out, table cells cut to 30 characters"],
];

/** The comment, shortened when the whole report would not fit in a GitHub comment, saying what was left out. */
export function commentBody(report: RunReport, image: (path: string) => string, full: string, history: string[]): string {
  const historySection = ["### Run history", "", ...history.map((line) => `- ${line}`), ""].join("\n");
  const note = (cut: string) => `_Shortened to fit a GitHub comment: ${cut}. The whole report: [report.md](${full})._\n`;
  let lines: string[] = [];
  for (const [options, cut] of SHORTER) {
    const markdown = renderMarkdown(report, image, { maxShots: 6, ...options });
    const body = [MARKER, markdown, ...(cut ? [note(cut)] : []), historySection].join("\n");
    if (body.length <= COMMENT_LIMIT) return body;
    lines = markdown.split("\n");
  }
  // Even the shortest version is too long: cut it off at a line, closing what the cut leaves open.
  const cutOff = () => {
    const fences = lines.filter((line) => line.startsWith("```")).length % 2 === 1 ? ["```"] : [];
    const open = lines.filter((line) => line.startsWith("<details>")).length - lines.filter((line) => line === "</details>").length;
    return [MARKER, ...lines, ...fences, ...Array<string>(Math.max(0, open)).fill("</details>"), "", note("the report is cut off"), historySection].join("\n");
  };
  let length = cutOff().length;
  while (length > COMMENT_LIMIT && lines.length > 0) length -= (lines.pop() ?? "").length + 1;
  let body = cutOff();
  while (body.length > COMMENT_LIMIT && lines.length > 0) {
    lines.pop();
    body = cutOff();
  }
  return body;
}

// GitHub refuses a comment longer than this.
const COMMENT_LIMIT = 65_536;
// Each try fetches the branch again and adds this run to what is there now.
const PUSH_TRIES = 5;

/**
 * Adds the run to the reports branch. The branch is one commit without history, so it never grows; the push replaces
 * it only if nobody else pushed since it was fetched, and a post that lost that race starts over from the new branch.
 */
async function publishShots(proc: Proc, slug: string, report: RunReport, folder: string, runDir: string, workDir: string): Promise<void> {
  const dir = join(workDir, "reports-branch");
  const git = (args: string[]) =>
    proc("git", ["-C", dir, "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "-c", "user.name=proofy", "-c", "user.email=proofy@users.noreply.github.com", ...args], {
      timeoutMs: 300_000,
    });
  for (let attempt = 1; ; attempt++) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await git(["init", "--quiet"]);
    await git(["remote", "add", "origin", `https://github.com/${slug}.git`]);
    const fetched = await git(["fetch", "--quiet", "--depth", "1", "origin", REPORTS_BRANCH]);
    // The commit the push expects to replace; empty when the branch does not exist yet.
    let lease = "";
    if (fetched.code === 0) {
      lease = (await git(["rev-parse", "FETCH_HEAD"])).stdout.trim();
      await git(["checkout", "--quiet", "FETCH_HEAD"]);
    } else if (!/couldn't find remote ref/i.test(fetched.stderr)) {
      throw new CliError(`Fetching ${REPORTS_BRANCH} failed`, "ENVIRONMENT_ERROR", [tail(fetched.stderr, 5)]);
    }
    const target = join(dir, "runs", folder);
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
    await git(["checkout", "--quiet", "--orphan", `proofy-${folder}`]);
    await git(["add", "-A"]);
    const commit = await git(["commit", "--quiet", "-m", `proofy run ${report.id}`]);
    if (commit.code !== 0) throw new CliError("Committing screenshots failed", "ENVIRONMENT_ERROR", [tail(commit.stderr, 5)]);
    const push = await git(["push", "--quiet", `--force-with-lease=refs/heads/${REPORTS_BRANCH}:${lease}`, "origin", `HEAD:refs/heads/${REPORTS_BRANCH}`]);
    if (push.code === 0) return;
    if (!/stale info/i.test(push.stderr) || attempt === PUSH_TRIES) {
      throw new CliError(`Pushing screenshots to ${REPORTS_BRANCH} failed`, "ENVIRONMENT_ERROR", [tail(push.stderr, 5), "Check that gh is logged in with push access"]);
    }
  }
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
