import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { spawnProc } from "../../src/sandbox/docker.js";

const FIXTURE = new URL("../fixtures/tiny-shop/", import.meta.url).pathname;

async function cli(argv: string[], cwd: string): Promise<{ code: number; out: string }> {
  let out = "";
  // The person at the terminal confirms an approval by typing the flow name.
  const ask = async () => argv[1] ?? "";
  const code = await runCli(argv, { cwd, env: { ...process.env, NO_COLOR: "1" }, proc: spawnProc, now: () => new Date(), log: () => {}, ask }, { write: (text) => (out += text), isTTY: false });
  return { code, out };
}

function shop(): string {
  const dir = mkdtempSync(join(tmpdir(), "proofy-docker-"));
  cpSync(FIXTURE, dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "fixture"]);
  return dir;
}

function leftovers(project: string): string {
  return execFileSync("docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "-q"]).toString().trim();
}

describe("sealed sandbox on Docker", () => {
  it("runs, proves, approves and checks flows end to end", async () => {
    const dir = shop();
    const first = await cli(["run", "buy-coffee", "sealed", "--json"], dir);
    const report = JSON.parse(first.out) as { verdict: string; flows: Array<{ name: string; status: string; requirements: Array<{ id: string; result: string }> }>; outside: Array<{ host: string; handledAs: string }>; id: string };
    expect(first.code).toBe(4);
    expect(report.verdict).toBe("untrusted");
    expect(report.flows.map((flow) => `${flow.name}:${flow.status}`)).toEqual(["buy-coffee:passed", "sealed:passed"]);
    expect(report.flows[0]!.requirements.map((r) => r.result)).toEqual(["pass", "pass", "pass", "pass", "not-covered"]);
    expect(report.outside).toContainEqual({ host: "cdn.unlisted.example.org", handledAs: "refused", count: 1 });
    expect(report.outside).toContainEqual({ host: "api.payments.test", handledAs: "fake", count: 1 });
    const requests = readFileSync(join(dir, "e2e/out", report.id, "requests.jsonl"), "utf8");
    expect(requests).toContain('"authorization":"(redacted)"');
    expect(requests).not.toContain("sk_sandbox");

    expect((await cli(["dev", "up"], dir)).code).toBe(0);
    try {
      for (let i = 0; i < 2; i++) expect((await cli(["dev", "test"], dir)).code).toBe(4);
      const status = await cli([], dir);
      expect(status.out).toContain("buy-coffee,ready");
      expect(status.out).toContain("sealed,ready");
    } finally {
      expect((await cli(["dev", "down"], dir)).code).toBe(0);
    }
    expect(leftovers("proofy-" + dir.split("/").at(-1)!.toLowerCase() + "-dev")).toBe("");

    expect((await cli(["approve", "buy-coffee"], dir)).code).toBe(0);
    expect((await cli(["approve", "sealed"], dir)).code).toBe(0);
    const all = await cli(["run", "--all"], dir);
    expect(all.out).toContain("verdict: pass");
    expect(all.code).toBe(0);

    // A changed fake makes every flow untrusted until the human approves again.
    writeFileSync(join(dir, "e2e/standins/api.payments.test.mjs"), `${readFileSync(join(dir, "e2e/standins/api.payments.test.mjs"), "utf8")}\n// changed\n`);
    expect((await cli([], dir)).out).toContain("buy-coffee,out-of-date");
    expect((await cli(["run", "--all"], dir)).code).toBe(4);
  });

  it("reports a broken sandbox as an environment failure, never as a failed requirement", async () => {
    const dir = shop();
    const config = JSON.parse(readFileSync(join(dir, "e2e/proofy.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "e2e/proofy.json"), JSON.stringify({ ...config, seed: { service: "shop", command: ["sh", "-c", "echo broken seed >&2; exit 7"] } }));
    const result = await cli(["run", "buy-coffee"], dir);
    expect(result.code).toBe(3);
    expect(result.out).toContain("verdict: environment");
    expect(result.out).toContain("seed command failed with exit code 7");
  });
});
