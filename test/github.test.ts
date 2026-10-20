import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commentBody, postReport, REPORTS_BRANCH } from "../src/github.js";
import type { FlowResult, RunReport } from "../src/run/results.js";
import { spawnProc, type Proc } from "../src/sandbox/docker.js";

const pr = { number: 7, sha: "f00d", baseRef: "main", baseSha: "beef", url: "https://example.test/pr/7" };

function flow(requirements: number, evidence: string): FlowResult {
  return {
    name: "checkout",
    approved: true,
    fingerprint: { spec: "a", test: "b", fakes: "c", config: "d", compose: "e" },
    status: "passed",
    requirements: Array.from({ length: requirements }, (_, i) => ({ id: `R${i + 1}`, text: "x".repeat(250), result: "pass" as const, did: "y".repeat(250), expected: "1", actual: "1", evidence, fakes: [] })),
    tests: [],
    shots: [{ test: "t", file: "shot.png", label: "after paying" }],
    unknownClaims: [],
  };
}

function report(id: string, flows: FlowResult[] = [flow(2, "e")]): RunReport {
  return { id, kind: "run", startedAt: "", finishedAt: "", source: {}, flows, outside: [], lookedUpOnly: [], notes: [] };
}

describe("posting on a pull request", () => {
  it("shortens a comment that would be too long for GitHub, evidence first, and says what it left out", () => {
    const image = (path: string) => `https://x/${path}`;
    const small = commentBody(report("r1"), image, "https://x/report.md", ["r1: pass"]);
    expect(small).toContain("<summary>Evidence</summary>");
    expect(small).not.toContain("Shortened");

    const evidence = commentBody(report("r1", [flow(20, "e".repeat(4000))]), image, "https://x/report.md", ["r1: pass"]);
    expect(evidence.length).toBeLessThanOrEqual(65_536);
    expect(evidence).not.toContain("<summary>Evidence</summary>");
    expect(evidence).toContain("_Shortened to fit a GitHub comment: evidence left out. The whole report: [report.md](https://x/report.md)._");
    expect(evidence).toContain("- r1: pass");

    const huge = commentBody(report("r1", [flow(2000, "e")]), image, "https://x/report.md", ["r1: pass"]);
    expect(huge.length).toBeLessThanOrEqual(65_536);
    expect(huge).toContain("the report is cut off");
    expect(huge).toContain("### Run history");
  });

  it("keeps every run's screenshots when two posts push to the reports branch at once", async () => {
    const remote = mkdtempSync(join(tmpdir(), "proofy-remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    const runDir = (id: string) => {
      const dir = mkdtempSync(join(tmpdir(), `proofy-${id}-`));
      mkdirSync(join(dir, "flows", "checkout"), { recursive: true });
      writeFileSync(join(dir, "flows", "checkout", "shot.png"), id);
      writeFileSync(join(dir, "report.md"), `# ${id}\n`);
      return dir;
    };
    let pushes = 0;
    let raced = false;
    // GitHub stands in as a local repository; the second post runs while the first is about to push.
    const proc: Proc = async (program, args, options) => {
      if (program === "gh") return { code: 0, stdout: args[0] === "repo" ? "owner/shop\n" : "[]", stderr: "", timedOut: false };
      if (args.includes("push")) pushes++;
      if (args.includes("push") && !raced) {
        raced = true;
        await postReport(proc, "/repo", pr, report("20261020-120000-second"), runDir("second"), mkdtempSync(join(tmpdir(), "proofy-post-")));
      }
      return spawnProc(program, args.map((arg) => (arg === "https://github.com/owner/shop.git" ? remote : arg)), options);
    };
    await postReport(proc, "/repo", pr, report("20261020-120000-first"), runDir("first"), mkdtempSync(join(tmpdir(), "proofy-post-")));
    const files = execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", REPORTS_BRANCH]).toString().split("\n");
    expect(files.filter((file) => file.endsWith("shot.png"))).toEqual([
      expect.stringMatching(/^runs\/20261020-120000-first-[0-9a-f]{6}\/flows\/checkout\/shot\.png$/),
      expect.stringMatching(/^runs\/20261020-120000-second-[0-9a-f]{6}\/flows\/checkout\/shot\.png$/),
    ]);
    expect(execFileSync("git", ["--git-dir", remote, "rev-list", "--count", REPORTS_BRANCH]).toString().trim()).toBe("1");
    // The first post's push lost the race and went again on top of the second's.
    expect(pushes).toBe(3);
  });
});
