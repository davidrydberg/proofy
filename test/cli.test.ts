import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { spawnProc } from "../src/sandbox/docker.js";

async function cli(argv: string[], cwd: string, tty = false): Promise<{ code: number; out: string }> {
  let out = "";
  const deps = { cwd, env: { NO_COLOR: "1" }, proc: spawnProc, now: () => new Date(), log: () => {} };
  const code = await runCli(argv, deps, { write: (text) => (out += text), isTTY: tty, columns: 100 });
  return { code, out };
}

function repo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "proofy-"));
  execFileSync("git", ["init", "-q", dir]);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

const COMPOSE = `services:
  web:
    build: .
    ports: ["8000:80"]
  db:
    image: mariadb:11
    ports: ["3306:3306"]
`;

describe("proofy cli", () => {
  it("prints help, command help and version", async () => {
    const dir = repo();
    expect((await cli(["--help"], dir)).out).toContain("usage: proofy [command]");
    expect((await cli(["--help"], dir, true)).out).toContain("EXIT CODES");
    expect((await cli(["init", "--help"], dir)).out).toContain("--no-agents-md");
    expect((await cli(["--version"], dir)).out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("rejects unknown commands, leading flags and bad flags with exit 2", async () => {
    const dir = repo();
    for (const argv of [["nope"], ["--wat"], ["init", "--wat"], ["init", "--json", "--toon"]]) {
      const result = await cli(argv, dir);
      expect(result.code).toBe(2);
      expect(result.out).toContain("code: VALIDATION_ERROR");
      expect(result.out).toContain("help[1]:");
    }
  });

  it("bare command prints one line and exits 0 before init", async () => {
    const { code, out } = await cli([], repo());
    expect(code).toBe(0);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("Run `proofy init`");
  });

  it("init fills the config from the compose file and .env.example", async () => {
    const dir = repo({ "docker-compose.yml": COMPOSE, ".env.example": "APP_NAME=Shop\nSTRIPE_SECRET=sk_test_123\n# comment\nAPP_URL=\"http://localhost\"\n" });
    const { code, out } = await cli(["init"], dir);
    expect(code).toBe(0);
    expect(out).toContain("app: likely web on port 80");
    expect(out).toContain("1 secret-looking values replaced");
    const config = JSON.parse(readFileSync(join(dir, "e2e/proofy.json"), "utf8"));
    expect(config.compose).toEqual(["docker-compose.yml"]);
    expect(config.app).toEqual({ service: "web", port: 80, path: "/" });
    expect(config.env.web).toEqual({ APP_NAME: "Shop", STRIPE_SECRET: "proofy-fake-stripe-secret", APP_URL: "http://localhost" });
    for (const file of ["e2e/AGENTS.md", "e2e/templates/spec.md", "e2e/templates/test.spec.ts", "e2e/templates/standin.mjs", "e2e/templates/compose.yml"]) {
      expect(readFileSync(join(dir, file), "utf8").length).toBeGreaterThan(0);
    }
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("e2e/out/");
    const pointer = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(pointer).toContain("read `e2e/AGENTS.md`");
    expect(pointer).toContain("is the go-ahead to edit files under `e2e/`");
    expect(out).toContain('"add a proofy test: ');
    expect(out).not.toContain("set up proofy");
  });

  it("init finds every page, per-folder settings, analytics to record and a backend next door", async () => {
    const parent = mkdtempSync(join(tmpdir(), "proofy-two-repos-"));
    const api = join(parent, "shop-api");
    mkdirSync(api);
    writeFileSync(join(api, "docker-compose.yml"), 'services:\n  nginx:\n    image: nginx:alpine\n    ports: ["8000:80"]\n');
    const dir = join(parent, "shop-client");
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir]);
    const files: Record<string, string> = {
      "docker-compose.yml": `services:
  app:
    build: ./app
    ports: ["8080:8080"]
    volumes: [".:/repo"]
  admin:
    build: { context: ./admin }
    ports: ["8081:8081"]
  db:
    image: mysql:8.4
    ports: ["3306:3306"]
`,
      "app/.env.local.example": "VITE_URL_API=http://localhost:8000/account\nVITE_POSTHOG_HOST=https://eu.i.posthog.com\nVITE_POSTHOG_KEY=phc_123\nVITE_SHIPPING=https://api.shipper.example.org/v2\n",
      "admin/.env.example": "VITE_URL_API=http://localhost:8000/admin\n",
      "app/src/main.ts": 'load("https://www.googletagmanager.com/gtm.js"); link("https://www.facebook.com/shop"); pay("https://js.stripe.com/v3");\n',
      "node_modules/x/index.js": 'fetch("https://sentry.io/api")\n',
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    const { code, out } = await cli(["init"], dir);
    expect(code).toBe(0);
    expect(out).toContain("app: likely app on port 8080");
    expect(out).toContain("also serving pages: admin on port 8081");
    expect(out).toContain("app mounts . at /repo, so it is set up for development");
    expect(out).toContain("VITE_URL_API in app/.env.local.example and VITE_URL_API in admin/.env.example point at localhost:8000, which nothing here serves");
    expect(out).toContain("such as ../shop-api (its nginx service publishes 8000)");
    expect(out).toContain("recorded: eu.i.posthog.com, www.googletagmanager.com");
    expect(out).toContain("api.shipper.example.org (VITE_SHIPPING in app/.env.local.example)");
    expect(out).toContain("js.stripe.com (app/src/main.ts)");
    expect(out).not.toContain("facebook.com");
    expect(out).not.toContain("sentry.io");
    const config = JSON.parse(readFileSync(join(dir, "e2e/proofy.json"), "utf8"));
    expect(config.app).toEqual({ service: "app", port: 8080, path: "/" });
    expect(config.hosts).toEqual({ "eu.i.posthog.com": "record", "www.googletagmanager.com": "record" });
    expect(config.env.app.VITE_POSTHOG_KEY).toBe("proofy-fake-vite-posthog-key");
    expect(config.env.admin).toEqual({ VITE_URL_API: "http://localhost:8000/admin" });
    expect((await cli([], dir)).out).not.toContain("invalid");
  });

  it("init never overwrites and adds the pointer only once", async () => {
    const dir = repo({ "AGENTS.md": "# My repo\n" });
    await cli(["init"], dir);
    writeFileSync(join(dir, "e2e/AGENTS.md"), "mine");
    const { code, out } = await cli(["init"], dir);
    expect(code).toBe(0);
    expect(out).toContain("kept[");
    expect(readFileSync(join(dir, "e2e/AGENTS.md"), "utf8")).toBe("mine");
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# My repo\n")).toBe(true);
    expect(agents.match(/e2e\/AGENTS\.md/g)).toHaveLength(1);
  });

  it("init leaves an earlier wording of the pointer alone", async () => {
    const old = "End-to-end tests: read `e2e/AGENTS.md` before writing or changing anything under `e2e/`.\n";
    const dir = repo({ "AGENTS.md": old });
    const { out } = await cli(["init"], dir);
    expect(out).toContain("already in AGENTS.md");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(old);
  });

  it("init points CLAUDE.md-only repos at the instructions, and --no-agents-md skips it", async () => {
    const claude = repo({ "CLAUDE.md": "rules\n" });
    await cli(["init"], claude);
    expect(readFileSync(join(claude, "CLAUDE.md"), "utf8")).toContain("e2e/AGENTS.md");

    const skip = repo({ "AGENTS.md": "rules\n" });
    await cli(["init", "--no-agents-md"], skip);
    expect(readFileSync(join(skip, "AGENTS.md"), "utf8")).toBe("rules\n");
  });

  it("bare command walks through onboarding in order", async () => {
    const dir = repo();
    await cli(["init"], dir);
    let out = (await cli([], dir)).out;
    expect(out).toContain("Setup is missing: compose, app. Tell your agent what to test");
    expect(out).toContain("It finishes setup first");
    expect(out).not.toContain("set up proofy");

    writeFileSync(join(dir, "compose.yml"), COMPOSE);
    writeFileSync(
      join(dir, "e2e/proofy.json"),
      JSON.stringify({ compose: ["compose.yml"], app: { service: "web", port: 80 }, seed: { service: "web", command: ["php", "artisan", "migrate"] } }),
    );
    writeFileSync(join(dir, "e2e/specs/guest-checkout.md"), "# Guest checkout\n");
    writeFileSync(join(dir, "e2e/specs/refund.md"), "# Refund\n");
    writeFileSync(join(dir, "e2e/tests/refund.spec.ts"), "");
    writeFileSync(join(dir, "e2e/tests/stray.spec.ts"), "");
    out = (await cli([], dir)).out;
    expect(out).not.toContain("Setup is missing");
    expect(out).toContain("flows[2]{flow,state,detail}:\n  guest-checkout,draft,\"\"\n  refund,unproven,0 of 3 runs with the current files");
    expect(out).toContain("write the tests for: guest-checkout");
    expect(out).toContain("Prove refund (0 of 3 runs with the current files)");
    expect(out).toContain("Tests without requirements: stray");
  });

  it("bare command reports an invalid config and still exits 0", async () => {
    const dir = repo();
    await cli(["init"], dir);
    writeFileSync(join(dir, "e2e/proofy.json"), JSON.stringify({ hosts: { "API.Stripe.com": "fake" }, colour: 1 }));
    const { code, out } = await cli([], dir);
    expect(code).toBe(0);
    expect(out).toContain("config: \"invalid: e2e/proofy.json:");
  });

  it("renders the human view and full JSON", async () => {
    const dir = repo({ "compose.yml": COMPOSE });
    await cli(["init"], dir);
    const human = (await cli([], dir, true)).out;
    expect(human).toContain("SETUP");
    expect(human).toContain("http://web:80/");
    expect(human).toContain("NEXT");
    const json = JSON.parse((await cli(["--json"], dir)).out) as { setup: Array<{ label: string; ok: boolean }> };
    expect(json.setup.map((check) => [check.label, check.ok])).toEqual([
      ["compose", true],
      ["app", true],
      ["seed", true],
      ["hosts", true],
    ]);
  });
});
