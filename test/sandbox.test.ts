import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import type { Proc } from "../src/sandbox/docker.js";
import { prepare, resolveImages, runTests, type Sandbox, type SandboxOptions } from "../src/sandbox/sandbox.js";

function options(dir: string, config: Record<string, unknown>): SandboxOptions {
  return {
    sourceDir: dir,
    e2eDir: join(dir, "e2e"),
    logDir: join(dir, "out"),
    config: configSchema.parse({ compose: ["compose.yml"], app: { service: "web", port: 80 }, ...config }),
    mode: "run",
    project: "proofy-shop-run-1",
    cacheDir: join(dir, "cache"),
    env: {},
    log: () => {},
  };
}

function sandbox(dir: string): Sandbox {
  mkdirSync(join(dir, "runner", "exec"), { recursive: true });
  mkdirSync(join(dir, "out"), { recursive: true });
  return { project: "proofy-shop-run-1", composeFile: join(dir, "compose.yml"), workDir: dir, notes: [], imageRefs: {} };
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });

describe("sandbox", () => {
  it("answers every exec request, a broken one with an error, and never crashes the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proofy-bridge-"));
    const exec = join(dir, "runner", "exec");
    const requests: Record<string, string> = {
      half: '{"name":"ord',
      shape: JSON.stringify({ name: 1 }),
      unknown: JSON.stringify({ name: "nope", args: [] }),
      order: JSON.stringify({ name: "order", args: ["7"] }),
      broken: JSON.stringify({ name: "broken", args: [] }),
    };
    const responses: Record<string, Record<string, unknown>> = {};
    const proc: Proc = async (_program, args) => {
      if (args.includes("run")) {
        for (const [id, body] of Object.entries(requests)) writeFileSync(join(exec, `${id}.req.json`), body);
        const deadline = Date.now() + 5_000;
        while (Object.keys(requests).some((id) => !existsSync(join(exec, `${id}.res.json`))) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        for (const id of Object.keys(requests)) responses[id] = JSON.parse(readFileSync(join(exec, `${id}.res.json`), "utf8")) as Record<string, unknown>;
        return ok();
      }
      if (args.includes("broken")) throw new Error("docker went away");
      return ok(`order ${args.at(-1)}`);
    };
    const run = options(dir, { exec: { order: { service: "web", command: ["show"] }, broken: { service: "web", command: ["broken"] } } });
    expect(await runTests(proc, run, sandbox(dir), [])).toBe(0);
    expect(responses.half!.error).toMatch(/could not answer exec\(\)/);
    expect(responses.shape!.error).toMatch(/without a command name/);
    expect(responses.unknown!.error).toMatch(/exec\("nope"\) is not in e2e\/proofy.json exec/);
    expect(responses.order).toEqual({ code: 0, stdout: "order 7", stderr: "" });
    expect(responses.broken!.error).toMatch(/docker went away/);
  });

  it("names the image every sealed service runs, and resolves each to its ID and registry digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proofy-images-"));
    const model = { services: { web: { build: { context: dir } }, db: { image: "mariadb:11" } } };
    const proc: Proc = async (_program, args) => (args.includes("config") ? ok(JSON.stringify(model)) : ok());
    const prepared = await prepare(proc, options(dir, {}));
    expect(prepared.imageRefs).toMatchObject({ web: "proofy-shop-run-1-web", db: "mariadb:11", mailpit: expect.stringMatching(/^axllent\/mailpit:/) });
    expect(Object.keys(prepared.imageRefs)).toEqual(["web", "db", "proofy-standin", "mailpit", "proofy-runner"]);

    const inspected: Record<string, unknown> = {
      "proofy-shop-run-1-web": { Id: "sha256:aaa", RepoDigests: [] },
      "mariadb:11": { Id: "sha256:bbb", RepoDigests: ["mirror.test/mariadb@sha256:other", "mariadb@sha256:ccc"] },
    };
    const inspect: Proc = async (_program, args) => {
      const found = inspected[args.at(-1)!];
      return found ? ok(JSON.stringify(found)) : { code: 1, stdout: "", stderr: "No such image", timedOut: false };
    };
    const images = await resolveImages(inspect, { ...prepared, imageRefs: { web: "proofy-shop-run-1-web", db: "mariadb:11", gone: "gone:1" } });
    expect(images).toEqual([
      { service: "web", image: "proofy-shop-run-1-web", id: "sha256:aaa" },
      { service: "db", image: "mariadb:11", id: "sha256:bbb", digest: "mariadb@sha256:ccc" },
      { service: "gone", image: "gone:1" },
    ]);
  });
});
