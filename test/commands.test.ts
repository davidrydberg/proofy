import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { Proc } from "../src/sandbox/docker.js";
import { fingerprint } from "../src/run/fingerprint.js";
import { pathsFor } from "../src/project.js";
import { configSchema } from "../src/config.js";
import type { RunReport } from "../src/run/results.js";

const noDocker: Proc = async (program, args) => {
  if (program === "git") return { code: 0, stdout: "abc\n", stderr: "", timedOut: false };
  throw new Error(`unexpected ${program} ${args.join(" ")}`);
};

async function cli(argv: string[], cwd: string, proc: Proc = noDocker): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runCli(argv, { cwd, env: { NO_COLOR: "1", XDG_CACHE_HOME: join(cwd, ".cache") }, proc, now: () => new Date("2026-10-20T12:00:00Z"), log: () => {} }, { write: (text) => (out += text), isTTY: false });
  return { code, out };
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "proofy-cmd-"));
  execFileSync("git", ["init", "-q", dir]);
  mkdirSync(join(dir, "e2e/specs"), { recursive: true });
  mkdirSync(join(dir, "e2e/tests"), { recursive: true });
  writeFileSync(join(dir, "e2e/proofy.json"), JSON.stringify({ compose: ["compose.yml"], app: { service: "web", port: 80 } }));
  writeFileSync(join(dir, "e2e/specs/checkout.md"), "R1. Order shown.\nR2. Mail sent.\n");
  writeFileSync(join(dir, "e2e/tests/checkout.spec.ts"), "// test\n");
  writeFileSync(join(dir, "e2e/specs/refund.md"), "R1. Refunded.\n");
  return dir;
}

async function fakeRun(dir: string, id: string, results: string[]): Promise<void> {
  const paths = pathsFor(dir);
  const print = await fingerprint(paths, configSchema.parse(JSON.parse(readFileSync(paths.config, "utf8"))), "checkout");
  const report: RunReport = {
    id,
    kind: "dev",
    startedAt: "",
    finishedAt: "",
    source: {},
    flows: [{ name: "checkout", approved: false, fingerprint: print, status: "passed", requirements: results.map((result, i) => ({ id: `R${i + 1}`, text: "", result: result as "pass", fakes: [] })), tests: [], shots: [], unknownClaims: [] }],
    outside: [],
    lookedUpOnly: [],
    notes: [],
  };
  mkdirSync(join(dir, "e2e/out", id), { recursive: true });
  writeFileSync(join(dir, "e2e/out", id, "report.json"), JSON.stringify(report));
}

describe("commands without Docker", () => {
  it("run validates flows before touching Docker", async () => {
    const dir = project();
    expect((await cli(["run"], dir)).code).toBe(2);
    const unknown = await cli(["run", "nope"], dir);
    expect(unknown.code).toBe(2);
    expect(unknown.out).toContain("Flows: checkout, refund");
    expect((await cli(["run", "refund"], dir)).out).toContain("has requirements but no test yet");
    const none = await cli(["run", "--all"], dir);
    expect(none.code).toBe(4);
    expect(none.out).toContain("code: NOT_APPROVED");
    expect((await cli(["run", "--pr", "x"], dir)).code).toBe(2);
  });

  it("commands outside a set-up repo say so with exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proofy-bare-"));
    for (const argv of [["run", "x"], ["approve", "x"], ["dev", "up"], ["report"]]) {
      const result = await cli(argv, dir);
      expect(result.code).toBe(2);
      expect(result.out).toContain("code: NOT_SET_UP");
    }
  });

  it("approve needs three identical runs with the current files, then records fingerprints", async () => {
    const dir = project();
    const early = await cli(["approve", "checkout"], dir);
    expect(early.code).toBe(4);
    expect(early.out).toContain("0 of 3 runs");

    await fakeRun(dir, "20261020-110000", ["pass", "fail"]);
    await fakeRun(dir, "20261020-110100", ["pass", "pass"]);
    await fakeRun(dir, "20261020-110200", ["pass", "fail"]);
    expect((await cli(["approve", "checkout"], dir)).out).toContain("the last 3 runs gave different results");
    expect((await cli([], dir)).out).toContain("checkout,unstable");

    await fakeRun(dir, "20261020-110300", ["pass", "fail"]);
    await fakeRun(dir, "20261020-110400", ["pass", "fail"]);
    expect((await cli([], dir)).out).toContain("checkout,ready");
    const approved = await cli(["approve", "checkout"], dir);
    expect(approved.code).toBe(0);
    expect(approved.out).toContain("R2 fail on purpose as findings");
    const lock = JSON.parse(readFileSync(join(dir, "e2e/proofy.lock.json"), "utf8")) as { flows: Record<string, { runs: string[] }> };
    expect(lock.flows.checkout!.runs).toEqual(["20261020-110400", "20261020-110300", "20261020-110200"]);
    expect((await cli([], dir)).out).toContain("checkout,approved");

    writeFileSync(join(dir, "e2e/specs/checkout.md"), "R1. Order shown.\nR2. Mail sent to the buyer.\n");
    expect((await cli([], dir)).out).toContain("checkout,out-of-date");
    expect((await cli(["run", "--all"], dir)).code).toBe(4);
  });

  it("report shows a past run and exits 0 whatever its verdict", async () => {
    const dir = project();
    await fakeRun(dir, "20261020-110000", ["pass", "fail"]);
    const shown = await cli(["report"], dir);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("run: 20261020-110000");
    expect((await cli(["report", "nope"], dir)).code).toBe(2);
  });
});

describe("run --pr", () => {
  it("exports the whole repository and finds the project in its subfolder", async () => {
    const top = mkdtempSync(join(tmpdir(), "proofy-mono-"));
    execFileSync("git", ["init", "-q", top]);
    const app = join(top, "apps", "shop");
    mkdirSync(join(app, "e2e/specs"), { recursive: true });
    writeFileSync(join(app, "e2e/proofy.json"), JSON.stringify({ compose: ["compose.yml"] }));
    const calls: string[] = [];
    const proc: Proc = async (program, args) => {
      calls.push(`${program} ${args.join(" ")}`);
      if (program === "gh") return { code: 0, stdout: JSON.stringify({ number: 7, headRefOid: "f00d", url: "https://example.test/pr/7" }), stderr: "", timedOut: false };
      if (program === "tar") {
        const dir = args[args.indexOf("-C") + 1]!;
        mkdirSync(join(dir, "apps/shop/e2e/specs"), { recursive: true });
        writeFileSync(join(dir, "apps/shop/e2e/specs/checkout.md"), "R1. Works.\n");
      }
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const result = await cli(["run", "checkout", "--pr", "7"], app, proc);
    expect(result.out).toContain("checkout has requirements but no test yet");
    expect(calls.find((call) => call.includes(" archive "))).toContain(`git -C ${execFileSync("git", ["-C", top, "rev-parse", "--show-toplevel"]).toString().trim()} archive`);
  });
});
