import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { Proc } from "../src/sandbox/docker.js";
import { fingerprint } from "../src/run/fingerprint.js";
import { pathsFor } from "../src/project.js";
import { configSchema } from "../src/config.js";
import { changedApprovals } from "../src/github.js";
import { runResult } from "../src/commands/run.js";
import { renderMarkdown } from "../src/run/report.js";
import { spawnProc } from "../src/sandbox/docker.js";
import type { RunReport } from "../src/run/results.js";

const noDocker: Proc = async (program, args) => {
  if (program === "git") return { code: 0, stdout: "abc\n", stderr: "", timedOut: false };
  throw new Error(`unexpected ${program} ${args.join(" ")}`);
};

async function cli(argv: string[], cwd: string, proc: Proc = noDocker, ask?: (question: string) => Promise<string>): Promise<{ code: number; out: string }> {
  let out = "";
  const deps = { cwd, env: { NO_COLOR: "1", XDG_CACHE_HOME: join(cwd, ".cache") }, proc, now: () => new Date("2026-10-20T12:00:00Z"), log: () => {}, ...(ask ? { ask } : {}) };
  const code = await runCli(argv, deps, { write: (text) => (out += text), isTTY: false });
  return { code, out };
}

/** A person at the terminal who answers every question with `answer`. */
function person(answer: string, questions: string[] = []): (question: string) => Promise<string> {
  return async (question) => {
    questions.push(question);
    return answer;
  };
}

/** A flow approved after three identical runs, as the person at the terminal does it. */
async function approvedProject(): Promise<string> {
  const dir = project();
  for (const id of ["20261020-110000", "20261020-110100", "20261020-110200"]) await fakeRun(dir, id, ["pass", "pass"]);
  expect((await cli(["approve", "checkout"], dir, noDocker, person("checkout"))).code).toBe(0);
  return dir;
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "proofy-cmd-"));
  execFileSync("git", ["init", "-q", dir]);
  mkdirSync(join(dir, "e2e/specs"), { recursive: true });
  mkdirSync(join(dir, "e2e/tests"), { recursive: true });
  writeFileSync(join(dir, "e2e/proofy.json"), JSON.stringify({ compose: ["compose.yml"], app: { service: "web", port: 80 } }));
  writeFileSync(join(dir, "compose.yml"), "services:\n  web:\n    image: shop\n");
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
    const approved = await cli(["approve", "checkout"], dir, noDocker, person("checkout"));
    expect(approved.code).toBe(0);
    expect(approved.out).toContain("R2 fail on purpose as findings");
    const lock = JSON.parse(readFileSync(join(dir, "e2e/proofy.lock.json"), "utf8")) as { flows: Record<string, { runs: string[] }> };
    expect(lock.flows.checkout!.runs).toEqual(["20261020-110400", "20261020-110300", "20261020-110200"]);
    expect((await cli([], dir)).out).toContain("checkout,approved");

    writeFileSync(join(dir, "e2e/specs/checkout.md"), "R1. Order shown.\nR2. Mail sent to the buyer.\n");
    expect((await cli([], dir)).out).toContain("checkout,out-of-date,\"changed since approval: requirements; 0 of 3 runs with the current files\"");
    expect((await cli(["run", "--all"], dir)).code).toBe(4);
  });

  it("approve works only for a person at a terminal who types the flow name", async () => {
    const dir = project();
    for (const id of ["20261020-110000", "20261020-110100", "20261020-110200"]) await fakeRun(dir, id, ["pass", "pass"]);
    const lock = join(dir, "e2e/proofy.lock.json");

    const agent = await cli(["approve", "checkout"], dir);
    expect(agent.code).toBe(4);
    expect(agent.out).toContain("Only a person approves");
    expect(existsSync(lock)).toBe(false);

    const questions: string[] = [];
    const typo = await cli(["approve", "checkout"], dir, noDocker, person("chekout", questions));
    expect(typo.code).toBe(4);
    expect(typo.out).toContain("Not approved: the answer was not checkout");
    expect(questions[0]).toContain("R1 pass, R2 pass");
    expect(questions[0]).toContain("Type checkout to approve it");
    expect(existsSync(lock)).toBe(false);

    expect((await cli(["approve", "checkout"], dir, noDocker, person(" checkout\n"))).code).toBe(0);
    expect((await cli([], dir)).out).toContain("checkout,approved");
  });

  it("a change to e2e/proofy.json or a compose file makes the flow out of date and says what changed", async () => {
    const dir = await approvedProject();
    const config = join(dir, "e2e/proofy.json");
    const original = readFileSync(config, "utf8");

    // Formatting, key order, $schema and spelled-out defaults are not changes.
    writeFileSync(config, `${JSON.stringify({ $schema: "https://example.test/schema.json", app: { port: 80, service: "web", path: "/" }, compose: ["compose.yml"], exec: {}, limits: { parallel: 4 } }, null, 4)}\n`);
    expect((await cli([], dir)).out).toContain("checkout,approved");

    for (const change of [{ seed: { service: "web", command: ["seed"] } }, { exec: { order: { service: "web", command: ["cat"] } } }, { env: { web: { MODE: "x" } } }, { app: { service: "web", port: 81 } }, { hosts: { "api.pay.test": "record" } }]) {
      writeFileSync(config, JSON.stringify({ ...JSON.parse(original), ...change }));
      const home = (await cli([], dir)).out;
      expect(home).toContain("checkout,out-of-date,\"changed since approval: ");
      expect(home).toContain("e2e/proofy.json");
    }
    writeFileSync(config, original);
    expect((await cli([], dir)).out).toContain("checkout,approved");

    writeFileSync(join(dir, "compose.yml"), "services:\n  web:\n    image: other-shop\n");
    const home = await cli([], dir);
    expect(home.out).toContain("checkout,out-of-date,\"changed since approval: compose files;");
    expect(home.out).toContain("Changed since approval: checkout (compose files)");
    expect((await cli(["run", "--all"], dir)).code).toBe(4);
  });

  it("an approval covers what the named files depend on: test helpers, every file of the fakes, and included or extended compose files", async () => {
    const dir = project();
    writeFileSync(join(dir, "compose.yml"), "include:\n  - db/compose.yml\nservices:\n  web:\n    image: shop\n    extends:\n      file: base.yml\n      service: base\n");
    mkdirSync(join(dir, "db"));
    writeFileSync(join(dir, "db/compose.yml"), "services:\n  db:\n    image: mariadb:11\n");
    writeFileSync(join(dir, "base.yml"), "services:\n  base:\n    environment:\n      MODE: shop\n");
    mkdirSync(join(dir, "e2e/tests/helpers"), { recursive: true });
    writeFileSync(join(dir, "e2e/tests/helpers/buyer.ts"), "export const buyer = 'a';\n");
    writeFileSync(join(dir, "e2e/tests/refund.spec.ts"), "// another flow's test\n");
    mkdirSync(join(dir, "e2e/standins/lib"), { recursive: true });
    writeFileSync(join(dir, "e2e/standins/lib/prices.json"), "[1]\n");
    for (const id of ["20261020-110000", "20261020-110100", "20261020-110200"]) await fakeRun(dir, id, ["pass", "pass"]);
    expect((await cli(["approve", "checkout"], dir, noDocker, person("checkout"))).code).toBe(0);

    const changes: Array<[string, string, string]> = [
      ["e2e/tests/refund.spec.ts", "// changed\n", ""],
      ["e2e/tests/helpers/buyer.ts", "export const buyer = 'b';\n", "test"],
      ["e2e/standins/lib/prices.json", "[2]\n", "fakes"],
      ["db/compose.yml", "services:\n  db:\n    image: mariadb:12\n", "compose files"],
      ["base.yml", "services:\n  base:\n    environment:\n      MODE: other\n", "compose files"],
    ];
    for (const [file, content, part] of changes) {
      const original = readFileSync(join(dir, file), "utf8");
      writeFileSync(join(dir, file), content);
      expect((await cli([], dir)).out, file).toContain(part ? `checkout,out-of-date,"changed since approval: ${part};` : "checkout,approved");
      writeFileSync(join(dir, file), original);
    }
    expect((await cli([], dir)).out).toContain("checkout,approved");
  });

  it("OS and editor litter in the fakes and tests folders never makes an approval out of date", async () => {
    const dir = await approvedProject();
    mkdirSync(join(dir, "e2e/standins"), { recursive: true });
    for (const file of ["e2e/standins/.DS_Store", "e2e/standins/pay.mjs~", "e2e/tests/.checkout.spec.ts.swp", "e2e/tests/helper.ts.swo"]) {
      writeFileSync(join(dir, file), "litter\n");
    }
    expect((await cli([], dir)).out).toContain("checkout,approved");
    writeFileSync(join(dir, "e2e/standins/pay.mjs"), "export default {};\n");
    expect((await cli([], dir)).out).toContain('checkout,out-of-date,"changed since approval: fakes;');
  });

  it("hidden files and symlinks count, since a test or fake can import them", async () => {
    const cases: Array<[string, string, (dir: string) => void]> = [
      ["hidden helper", "test", (dir) => writeFileSync(join(dir, "e2e/tests/.helpers.ts"), "export const x = 1;\n")],
      ["hidden folder", "fakes", (dir) => {
        mkdirSync(join(dir, "e2e/standins/.shared"), { recursive: true });
        writeFileSync(join(dir, "e2e/standins/.shared/pay.mjs"), "export default {};\n");
      }],
      ["symlinked fake", "fakes", (dir) => {
        mkdirSync(join(dir, "e2e/standins"), { recursive: true });
        writeFileSync(join(dir, "outside.mjs"), "export default {};\n");
        symlinkSync(join(dir, "outside.mjs"), join(dir, "e2e/standins/linked.mjs"));
      }],
    ];
    for (const [name, part, change] of cases) {
      const dir = await approvedProject();
      change(dir);
      expect((await cli([], dir)).out, name).toContain(`checkout,out-of-date,"changed since approval: ${part};`);
    }
  });

  it("the bare command exits 0 when a file it fingerprints cannot be read", async () => {
    const dir = await approvedProject();
    writeFileSync(join(dir, "e2e/tests/locked.ts"), "x\n");
    chmodSync(join(dir, "e2e/tests/locked.ts"), 0o000);
    symlinkSync(join(dir, "missing.ts"), join(dir, "e2e/tests/dangling.ts"));
    const { code, out } = await cli([], dir);
    expect(code).toBe(0);
    expect(out).toContain("checkout,out-of-date");
  });

  it("a change behind a symlinked file or folder makes the approval out of date", async () => {
    for (const target of ["shared.ts", "lib/h.ts"]) {
      const dir = project();
      writeFileSync(join(dir, "shared.ts"), "export const x = 1;\n");
      mkdirSync(join(dir, "lib"));
      writeFileSync(join(dir, "lib/h.ts"), "export const y = 1;\n");
      symlinkSync(join(dir, "shared.ts"), join(dir, "e2e/tests/shared.ts"));
      symlinkSync(join(dir, "lib"), join(dir, "e2e/tests/lib"));
      for (const id of ["20261020-110000", "20261020-110100", "20261020-110200"]) await fakeRun(dir, id, ["pass", "pass"]);
      expect((await cli(["approve", "checkout"], dir, noDocker, person("checkout"))).code).toBe(0);
      expect((await cli([], dir)).out).toContain("checkout,approved");
      writeFileSync(join(dir, target), "export const changed = true;\n");
      expect((await cli([], dir)).out, target).toContain('checkout,out-of-date,"changed since approval: test;');
    }
  });

  it("an approval from proofy 0.1, without config and compose fingerprints, reads as out of date", async () => {
    const dir = await approvedProject();
    const lock = join(dir, "e2e/proofy.lock.json");
    const parsed = JSON.parse(readFileSync(lock, "utf8")) as { flows: Record<string, Record<string, unknown>> };
    const old = parsed.flows.checkout!;
    delete old.config;
    delete old.compose;
    writeFileSync(lock, JSON.stringify({ version: 1, flows: { checkout: old } }));
    const home = await cli([], dir);
    expect(home.code).toBe(0);
    expect(home.out).toContain("checkout,out-of-date,\"changed since approval: e2e/proofy.json, compose files\"");
    expect(home.out).toContain("Ready for the human to approve: `proofy approve checkout`");
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

describe("dev test", () => {
  it("resets the fake-service container before each test, and runs docker without the shell's variables", async () => {
    const dir = project();
    const work = join(dir, ".cache", "sandbox");
    mkdirSync(join(work, "runner"), { recursive: true });
    mkdirSync(join(work, "out"), { recursive: true });
    mkdirSync(join(dir, "e2e/out"), { recursive: true });
    mkdirSync(join(work, "setup"), { recursive: true });
    const state = { project: "proofy-shop-dev", composeFile: join(work, "compose.yml"), workDir: work, notes: [], imageRefs: {}, startedAt: "", urls: { mail: "http://127.0.0.1:50025" } };
    writeFileSync(join(dir, "e2e/out/dev.json"), JSON.stringify(state));
    // The token stays in the sandbox's own folder, which the fake-service container reads its setup from.
    writeFileSync(join(work, "setup", "standin.json"), JSON.stringify({ token: "t0k3n" }));
    const calls: Array<{ call: string; env?: NodeJS.ProcessEnv }> = [];
    const proc: Proc = async (program, args, options) => {
      calls.push({ call: `${program} ${args.join(" ")}`, ...(options?.env ? { env: options.env } : {}) });
      return { code: 0, stdout: args.includes("ps") ? "abc\n" : "", stderr: "", timedOut: false };
    };
    await cli(["dev", "test", "checkout"], dir, proc);
    const docker = calls.filter(({ call }) => call.startsWith("docker "));
    expect(docker.map(({ call }) => call.split(" ").slice(6, 9).join(" "))).toEqual(["ps --status running", "exec -T proofy-standin", "run --rm -T"]);
    expect(docker[1]!.call).toMatch(/wget .*--header Authorization: Bearer t0k3n --post-data {2}http:\/\/127\.0\.0\.1:8099\/reset$/);
    expect(docker.every(({ env }) => env !== undefined && env.NO_COLOR === undefined && env.XDG_CACHE_HOME === undefined)).toBe(true);

    // dev up prints Mailpit's address with its login; the state file in the repository holds no token.
    expect((await cli(["dev", "up"], dir, proc)).out).toContain("http://proofy:t0k3n@127.0.0.1:50025");
    expect(readFileSync(join(dir, "e2e/out/dev.json"), "utf8")).not.toContain("t0k3n");

    // A dev sandbox started before sandboxes had a token is restarted, not tested.
    writeFileSync(join(work, "setup", "standin.json"), JSON.stringify({ hosts: [] }));
    expect((await cli(["dev", "up"], dir, proc)).out).toContain("http://127.0.0.1:50025");
    const old = await cli(["dev", "test", "checkout"], dir, proc);
    expect(old.code).toBe(2);
    expect(old.out).toContain("The dev sandbox was started by an older proofy");
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
      if (program === "gh") return { code: 0, stdout: JSON.stringify({ number: 7, headRefOid: "f00d", baseRefName: "main", baseRefOid: "beef", url: "https://example.test/pr/7" }), stderr: "", timedOut: false };
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

describe("approvals changed in a pull request", () => {
  function git(dir: string, ...args: string[]): string {
    return execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args]).toString().trim();
  }
  function commitLock(dir: string, flows: Record<string, unknown> | undefined): string {
    const lock = join(dir, "apps/shop/e2e/proofy.lock.json");
    if (flows) writeFileSync(lock, JSON.stringify({ version: 1, flows }));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "change", "--allow-empty");
    return git(dir, "rev-parse", "HEAD");
  }

  it("lists flows whose approval the PR adds, changes or removes, compared with where it branched off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proofy-lock-"));
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    mkdirSync(join(dir, "apps/shop/e2e"), { recursive: true });
    const keep = { spec: "a", test: "b" };
    commitLock(dir, { checkout: keep, refund: { spec: "r" }, search: { spec: "s" } });
    git(dir, "checkout", "-qb", "pr");
    const head = commitLock(dir, { checkout: keep, refund: { spec: "forged" }, signup: { spec: "new" } });
    git(dir, "checkout", "-q", "main");
    // A later approval on the base branch is not the PR's change.
    const base = commitLock(dir, { checkout: keep, refund: { spec: "r" }, search: { spec: "s" }, wishlist: { spec: "w" } });

    const pr = { number: 7, sha: head, baseRef: "main", baseSha: base, url: "" };
    expect(await changedApprovals(spawnProc, dir, pr, "apps/shop/e2e/proofy.lock.json")).toEqual(["refund", "search", "signup"]);
    expect(await changedApprovals(spawnProc, dir, pr, "apps/other/e2e/proofy.lock.json")).toEqual([]);
  });

  it("shows them at the top of the report, in the TOON result and in the hints", () => {
    const report: RunReport = { id: "20261020-120000", kind: "run", startedAt: "", finishedAt: "", source: { commit: "f00d", pr: 7, approvalsChanged: ["refund"] }, flows: [], outside: [], lookedUpOnly: [], notes: [] };
    expect(renderMarkdown(report, (path) => path)).toContain("- approval changed in this PR: refund");
    const result = runResult(report, "/repo/e2e/out/20261020-120000", "/repo");
    expect(result.data.approvals_changed_in_pr).toEqual(["refund"]);
    expect(result.help[0]).toContain("Approval changed in this PR: refund");
  });
});
