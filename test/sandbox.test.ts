import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config.js";
import type { Proc } from "../src/sandbox/docker.js";
import { prepare, resolveImages, runTests, sandboxProc, type Sandbox, type SandboxOptions } from "../src/sandbox/sandbox.js";

function options(dir: string, config: Record<string, unknown>): SandboxOptions {
  return {
    sourceDir: dir,
    repoDir: dir,
    e2eDir: join(dir, "e2e"),
    logDir: join(dir, "out"),
    config: configSchema.parse({ compose: ["compose.yml"], app: { service: "web", port: 80 }, ...config }),
    mode: "run",
    project: "proofy-shop-run-1",
    cacheDir: join(dir, "cache"),
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

  it("runs docker with only what it needs to reach the daemon, never the shell's other variables", async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const proc: Proc = async (_program, _args, opts) => {
      seen.push(opts?.env);
      return ok();
    };
    const shell = { PATH: "/bin", HOME: "/home/me", DOCKER_HOST: "unix:///d.sock", STRIPE_KEY: "sk_live_x", COMPOSE_PROFILES: "all", SSH_AUTH_SOCK: "/agent" };
    await sandboxProc(proc, shell)("docker", ["compose", "config"], { timeoutMs: 5 });
    expect(seen).toEqual([{ PATH: "/bin", HOME: "/home/me", DOCKER_HOST: "unix:///d.sock" }]);
  });

  it("refuses a compose variable without a value where it reaches the app, and names where to set it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proofy-unset-"));
    const warning = (name: string) => `time="x" level=warning msg="The \\"${name}\\" variable is not set. Defaulting to a blank string."\n`;
    const model = { services: { web: { image: "shop", environment: { KEY: "", PORT: "80" } } } };
    const raw = { services: { web: { image: "shop", ports: ["${HOST_PORT}:80"], environment: { KEY: "${STRIPE_KEY}", PORT: "80" } } } };
    const proc: Proc = async (_program, args) =>
      args.includes("--no-interpolate") ? ok(JSON.stringify(raw)) : { code: 0, stdout: JSON.stringify(model), stderr: warning("STRIPE_KEY") + warning("HOST_PORT"), timedOut: false };
    await expect(prepare(proc, options(dir, {}))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "The compose files use variables that have no fixed value in the sandbox: ${STRIPE_KEY} in services.web.environment.KEY",
      suggestions: [expect.stringContaining("never reads the shell's environment"), "Set KEY for service web in e2e/proofy.json env"],
    });
    // Set in e2e/proofy.json env, the empty value never reaches the app; the dropped port mapping never did.
    await expect(prepare(proc, options(dir, { env: { web: { KEY: "sk_test" } } }))).resolves.toMatchObject({ project: "proofy-shop-run-1" });

    const broken: Proc = async () => ({ code: 1, stdout: "", stderr: `${warning("NAME")}services.web.container_name '' does not match pattern`, timedOut: false });
    await expect(prepare(broken, options(dir, {}))).rejects.toMatchObject({ suggestions: [expect.any(String), expect.stringMatching(/^NAME has no value: proofy never reads/)] });
  });

  it("refuses a variable docker needs where it reaches the app, even with a default, and leaves a warning worded otherwise blank", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proofy-machine-"));
    const model = { services: { web: { image: "shop", environment: { DATA: "/home/me/data", KEY: "" } } } };
    const raw = { services: { web: { image: "shop", environment: { DATA: "${HOME:-/root}/data", KEY: "${STRIPE_KEY}" } } } };
    const proc = (stderr: string): Proc => async (_program, args) => (args.includes("--no-interpolate") ? ok(JSON.stringify(raw)) : { code: 0, stdout: JSON.stringify(model), stderr, timedOut: false });
    await expect(prepare(proc(""), options(dir, {}))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "The compose files use variables that have no fixed value in the sandbox: ${HOME} in services.web.environment.DATA",
      suggestions: [expect.stringContaining("never reads the shell's environment"), "Set DATA for service web in e2e/proofy.json env"],
    });
    // A compose version that words the warning otherwise refuses nothing more: STRIPE_KEY stays blank.
    await expect(prepare(proc('level=warning msg="STRIPE_KEY is unset, using an empty string"'), options(dir, { env: { web: { DATA: "/data" } } }))).resolves.toMatchObject({ project: "proofy-shop-run-1" });
  });

  it("refuses an included compose file that would take settings from an env file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proofy-include-"));
    writeFileSync(join(dir, "compose.yml"), "include:\n  - db/compose.yml\nservices:\n  web:\n    image: shop\n");
    mkdirSync(join(dir, "db"));
    writeFileSync(join(dir, "db/compose.yml"), "services:\n  db:\n    image: mariadb\n");
    const proc: Proc = async () => ok(JSON.stringify({ services: { web: { image: "shop" }, db: { image: "mariadb" } } }));
    await expect(prepare(proc, options(dir, {}))).resolves.toMatchObject({ project: "proofy-shop-run-1" });
    writeFileSync(join(dir, "db/.env"), "DB_PASSWORD=real\n");
    await expect(prepare(proc, options(dir, {}))).rejects.toThrow("An included compose file would take settings from db/.env");
  });
});
