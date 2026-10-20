import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import type { Config } from "../config.js";
import { CliError } from "../errors.js";
import { ADMIN_PORT, MOUNT, RUNNER, STANDIN } from "./contract.js";
import { hostPaths, PROXY_VARIABLES, sandboxCompose, subnetFor, unsetUses, type Mode, type UnsetUse } from "./compose.js";
import { tail, type Proc } from "./docker.js";
import { composeSources } from "./sources.js";

export const PKG_DIR = fileURLToPath(new URL("../../", import.meta.url));

export interface SandboxOptions {
  /** Where the app's compose files resolve: the repository, or an exported pull request. */
  sourceDir: string;
  /** The repository's top folder sourceDir sits in: an image build may read host files only inside it. */
  repoDir: string;
  /** The e2e folder the tests and fakes come from. */
  e2eDir: string;
  /** Where the sandbox's own logs land: the run folder, or e2e/out for a dev sandbox. */
  logDir: string;
  config: Config;
  mode: Mode;
  /** Unique per sandbox; also the compose project name. */
  project: string;
  /** Shared by every run of this repository: the certificate authority. */
  cacheDir: string;
  log: (line: string) => void;
}

export interface Sandbox {
  project: string;
  composeFile: string;
  workDir: string;
  notes: string[];
  /** The image reference each sealed compose service runs, by service name. */
  imageRefs: Record<string, string>;
  /**
   * The fake-service container's admin token and Mailpit's password, new for every sandbox. App services never see it,
   * and it is kept only in the sandbox's own folder, outside the repository: sandboxToken reads it back.
   */
  token: string;
}

/** The image a service ran, as resolved on this machine. */
export interface ServiceImage {
  service: string;
  image: string;
  /** The local image ID, for pulled and built images alike. */
  id?: string;
  /** The registry digest of a pulled image. */
  digest?: string;
}

// What docker needs to reach the daemon, its own settings, the proxy and the image builder, plus every BUILDX_ variable.
// Compose interpolates ${VAR} in the app's compose files from its environment, so anything more would let the shell
// running proofy reach the app.
const DOCKER_ENV = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_BUILDKIT",
  "XDG_RUNTIME_DIR",
  ...PROXY_VARIABLES,
];

function dockerVariable(name: string): boolean {
  return DOCKER_ENV.includes(name) || name.startsWith("BUILDX_");
}

/** Runs every program with only the variables docker needs, so the app's settings come only from e2e/proofy.json and the compose files. */
export function sandboxProc(proc: Proc, env: NodeJS.ProcessEnv): Proc {
  const minimal = Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && dockerVariable(name)));
  return (program, args, options = {}) => proc(program, args, { ...options, env: minimal });
}

export function cacheDirFor(env: NodeJS.ProcessEnv, root: string): string {
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "proofy", createHash("sha256").update(root).digest("hex").slice(0, 12));
}

export function playwrightVersion(): string {
  const require = createRequire(import.meta.url);
  return (require("@playwright/test/package.json") as { version: string }).version;
}

export function runnerImage(): string {
  return `mcr.microsoft.com/playwright:v${playwrightVersion()}-noble`;
}

export function standinImage(): string {
  const pkg = createRequire(import.meta.url)(join(PKG_DIR, "package.json")) as { version: string };
  return `proofy-standin:${pkg.version}`;
}

/** Install phase, with internet: images and builds. Nothing of the app runs yet. */
export async function installImages(proc: Proc, options: SandboxOptions, sandbox: Sandbox): Promise<void> {
  const { log } = options;
  const standin = standinImage();
  if ((await proc("docker", ["image", "inspect", standin])).code !== 0) {
    log(`building ${standin}`);
    await must(proc("docker", ["build", "-q", "-t", standin, "-f", join(PKG_DIR, "docker", "standin.Dockerfile"), join(PKG_DIR, "docker")]), "Building the fake-service image failed");
  }
  const runner = runnerImage();
  if ((await proc("docker", ["image", "inspect", runner])).code !== 0) {
    log(`pulling ${runner} (once, about 1.5 GB)`);
    await must(proc("docker", ["pull", "-q", runner]), `Pulling ${runner} failed`);
  }
  log("building and pulling the app's images");
  await must(proc("docker", [...compose(sandbox), "build", "--quiet"]), "Building the app's images failed");
  await must(proc("docker", [...compose(sandbox), "pull", "--ignore-buildable", "--policy", "missing", "--quiet"]), "Pulling the app's images failed");
  await mkdir(options.cacheDir, { recursive: true });
  const ca = join(options.cacheDir, "ca");
  await mkdir(ca, { recursive: true });
  await must(
    proc("docker", ["run", "--rm", "--user", hostUser(), "-v", `${ca}:${MOUNT.ca}`, "-v", `${PKG_DIR}:${MOUNT.pkg}:ro`, standin, "node", `${MOUNT.pkg}/dist/standin/server.js`, "ca"]),
    "Creating the sandbox certificate authority failed",
  );
  await downloadAssets(options, sandbox);
}

/** Writes the sealed compose file and everything the containers mount. */
export async function prepare(proc: Proc, options: SandboxOptions, attempt = 0): Promise<Sandbox> {
  const { config, sourceDir } = options;
  if (config.compose.length === 0) {
    throw new CliError("e2e/proofy.json lists no compose file", "CONFIG_INVALID", ['Ask your agent: "set up proofy" (Setup in e2e/AGENTS.md)']);
  }
  if (!config.app) {
    throw new CliError("e2e/proofy.json has no app: the browser does not know where to start", "CONFIG_INVALID", ['Ask your agent: "set up proofy"']);
  }
  const workDir = join(options.cacheDir, "sandboxes", options.project);
  await rm(workDir, { recursive: true, force: true });
  const dirs = {
    pkg: PKG_DIR.replace(/\/$/, ""),
    ca: join(options.cacheDir, "ca"),
    runSetup: join(workDir, "setup"),
    out: join(workDir, "out"),
    e2e: options.e2eDir,
    work: join(workDir, "runner"),
    nodeModules: join(workDir, "node_modules"),
  };
  for (const dir of [dirs.ca, dirs.runSetup, dirs.out, join(dirs.work, "exec"), join(dirs.nodeModules, "@davidrydberg"), join(dirs.nodeModules, "@playwright")]) {
    await mkdir(dir, { recursive: true });
  }
  // Test files import "@davidrydberg/proofy/test"; Node finds it through /node_modules in the runner container.
  await symlink(MOUNT.pkg, join(dirs.nodeModules, "@davidrydberg", "proofy"));
  await symlink(`${MOUNT.pkg}/node_modules/@playwright/test`, join(dirs.nodeModules, "@playwright", "test"));

  // An included compose file reads its own env file, whatever --env-file says.
  const { envFiles } = await composeSources(sourceDir, config.compose);
  if (envFiles.length > 0) {
    throw new CliError(`An included compose file would take settings from ${envFiles.join(", ")}`, "CONFIG_INVALID", [
      "Settings come only from e2e/proofy.json env and the compose files",
      "List the included compose file in e2e/proofy.json compose instead of including it",
    ]);
  }
  // An empty env file keeps compose from reading the repository's .env for interpolation. Relative paths in the
  // compose files resolve against the first file's folder, as they do when the app is started by hand.
  const emptyEnv = join(workDir, "empty.env");
  await writeFile(emptyEnv, "");
  const args = ["compose", ...config.compose.flatMap((file) => ["-f", join(sourceDir, file)]), "--env-file", emptyEnv];
  const normalized = await proc("docker", [...args, "config", "--format", "json", "--no-env-resolution"]);
  const unset = [...new Set([...normalized.stderr.matchAll(UNSET)].map((match) => match[1] ?? ""))];
  if (normalized.code !== 0) {
    throw new CliError(`docker compose could not read ${config.compose.join(", ")}`, "CONFIG_INVALID", [
      tail(normalized.stderr, 8),
      ...(unset.length > 0 ? [`${unset.join(", ")} ${unset.length === 1 ? "has" : "have"} no value: ${NO_SHELL}`] : []),
    ]);
  }
  const model = JSON.parse(normalized.stdout) as Record<string, unknown>;
  const raw = await proc("docker", [...args, "config", "--format", "json", "--no-interpolate"]);
  if (raw.code !== 0) throw new CliError(`docker compose could not read ${config.compose.join(", ")}`, "CONFIG_INVALID", [tail(raw.stderr, 8)]);
  refuseVariables(unsetUses(JSON.parse(raw.stdout) as Record<string, unknown>, model, config, unset, dockerVariable));
  // A symlinked host path is read where it points, so the seal compares real paths.
  const realPaths: Record<string, string> = {};
  for (const path of [options.repoDir, ...hostPaths(model, options.repoDir)]) {
    const real = await realPathOf(path);
    if (real !== undefined) realPaths[path] = real;
  }
  const { subnet, standinIp } = subnetFor(options.project, attempt);
  const token = randomBytes(16).toString("hex");
  const generated = sandboxCompose({ model, config, mode: options.mode, subnet, standinIp, standinImage: standinImage(), runnerImage: runnerImage(), repoDir: options.repoDir, realPaths, token, user: hostUser(), dirs });
  const composeFile = join(workDir, "compose.yml");
  await writeFile(composeFile, stringify(generated.compose));
  const assets = Object.fromEntries(config.assets.map((url) => [assetKey(url), assetFile(url)]));
  await writeFile(
    join(dirs.runSetup, "standin.json"),
    JSON.stringify({ hosts: config.hosts, assets, address: standinIp, standinsDir: `${MOUNT.e2e}/standins`, assetsDir: `${MOUNT.runSetup}/assets`, token, dev: options.mode === "dev" }),
  );
  // Compose names a built image without an image key <project>-<service>.
  const imageRefs = Object.fromEntries(
    Object.entries(generated.compose.services as Record<string, { image?: string }>).map(([name, service]) => [name, service.image ?? `${options.project}-${name}`]),
  );
  return { project: options.project, composeFile, workDir, notes: generated.notes, imageRefs, token };
}

/** The token of a sandbox prepared earlier, from its setup folder. Undefined for one prepared by a proofy without tokens. */
export async function sandboxToken(sandbox: Pick<Sandbox, "workDir">): Promise<string | undefined> {
  try {
    const { token } = JSON.parse(await readFile(join(sandbox.workDir, "setup", "standin.json"), "utf8")) as { token?: unknown };
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The real path of a host path, symlinks resolved. Docker creates a missing bind mount source, so a path that does not
 * exist yet resolves through the folders above it that do, and a symlink to a missing path through where it points.
 * Undefined for a symlink loop, which docker cannot mount either.
 */
async function realPathOf(path: string, hops = 0): Promise<string | undefined> {
  const real = await realpath(path).catch(() => undefined);
  if (real !== undefined || hops > 40) return real;
  const parent = dirname(path);
  if (parent === path) return undefined;
  const realParent = await realPathOf(parent, hops);
  if (realParent === undefined) return undefined;
  const here = join(realParent, basename(path));
  const target = await readlink(here).catch(() => undefined);
  return target === undefined ? here : realPathOf(resolve(realParent, target), hops + 1);
}

// Compose's warning for a ${VAR} it replaced with an empty value. Worded otherwise, it matches nothing and the value
// stays blank.
const UNSET = /The \\?"([A-Za-z_][A-Za-z0-9_]*)\\?" variable is not set/g;
const NO_SHELL = "proofy never reads the shell's environment or a .env file, settings come only from e2e/proofy.json env and the compose files";

/** Refuses a variable that would be silently empty, or come from the machine running proofy, where it reaches the app. */
function refuseVariables(uses: UnsetUse[]): void {
  if (uses.length === 0) return;
  const where = uses.map((use) => `\${${use.name}}${use.path.length > 0 ? ` in ${use.path.join(".")}` : ""}`);
  throw new CliError(`The compose files use variables that have no fixed value in the sandbox: ${where.join(", ")}`, "CONFIG_INVALID", [
    NO_SHELL,
    ...uses.map((use) =>
      use.path[0] === "services" && use.path[2] === "environment"
        ? `Set ${use.path[3]} for service ${use.path[1]} in e2e/proofy.json env`
        : dockerVariable(use.name)
          ? `Replace \${${use.name}} with a fixed value in the compose file: docker needs ${use.name}, so it comes from the machine running proofy, default or not`
          : `Give ${use.name} a default in the compose file, such as \${${use.name}:-value}`,
    ),
  ]);
}

/**
 * What every service's image resolves to after the install phase. Images are pulled only when missing, so a
 * floating tag can mean a different image on another day or machine; the report records which one ran.
 */
export async function resolveImages(proc: Proc, sandbox: Sandbox): Promise<ServiceImage[]> {
  const images: ServiceImage[] = [];
  for (const [service, image] of Object.entries(sandbox.imageRefs)) {
    const inspect = await proc("docker", ["image", "inspect", "--format", "{{json .}}", image]);
    let found: { Id?: string; RepoDigests?: string[] } = {};
    try {
      if (inspect.code === 0) found = JSON.parse(inspect.stdout) as typeof found;
    } catch {
      // Recorded without an ID: the report shows the image was not found.
    }
    const repo = image.replace(/@.*$/, "").replace(/:[^/:]*$/, "");
    const digests = found.RepoDigests ?? [];
    const digest = digests.find((entry) => entry.startsWith(`${repo}@`)) ?? digests[0];
    images.push({ service, image, ...(found.Id ? { id: found.Id } : {}), ...(digest ? { digest } : {}) });
  }
  return images;
}

/** Sealed phase: starts the app with no way out, waits for it, seeds the empty database. */
export async function start(proc: Proc, options: SandboxOptions, sandbox: Sandbox): Promise<Sandbox> {
  const { config, log } = options;
  await mkdir(options.logDir, { recursive: true });
  let current = sandbox;
  for (let attempt = 0; ; attempt++) {
    log("starting the sealed sandbox");
    const up = await proc("docker", [...compose(current), "up", "-d", "--wait", "--wait-timeout", String(Math.round(config.limits.startMinutes * 60))], {
      timeoutMs: config.limits.startMinutes * 60_000 + 30_000,
    });
    if (up.code === 0) break;
    if (/overlap/i.test(up.stderr) && attempt < 5) {
      await stop(proc, current);
      current = await prepare(proc, options, attempt + 1);
      continue;
    }
    throw new CliError(up.timedOut ? "The sandbox did not start in time" : "The sandbox did not start", "ENVIRONMENT_ERROR", [
      tail(up.stderr || up.stdout, 12),
      `Container logs: ${join(options.logDir, "sandbox.log")}`,
    ]);
  }
  if (config.seed) {
    log(`seeding: ${config.seed.command.join(" ")}`);
    const seed = await proc("docker", [...compose(current), "exec", "-T", config.seed.service, ...config.seed.command], { timeoutMs: config.limits.startMinutes * 60_000 });
    await writeFile(join(options.logDir, "seed.log"), `${seed.stdout}\n${seed.stderr}`);
    if (seed.code !== 0) {
      throw new CliError(`The seed command failed with exit code ${seed.code}`, "ENVIRONMENT_ERROR", [tail(seed.stderr || seed.stdout, 12), `Full output: ${join(options.logDir, "seed.log")}`]);
    }
  }
  return current;
}

/** Runs Playwright in the runner container, answering exec() requests from the tests meanwhile. */
export async function runTests(proc: Proc, options: SandboxOptions, sandbox: Sandbox, playwrightArgs: string[]): Promise<number> {
  const bridge = startExecBridge(proc, options, sandbox);
  try {
    const limit = options.config.limits.maxRunMinutes;
    const result = await proc(
      "docker",
      [...compose(sandbox), "run", "--rm", "-T", RUNNER, "node", `${MOUNT.pkg}/node_modules/@playwright/test/cli.js`, "test", "-c", `${MOUNT.work}/playwright.config.mjs`, ...playwrightArgs],
      limit === undefined ? {} : { timeoutMs: limit * 60_000 },
    );
    await writeFile(join(sandbox.workDir, "out", "playwright.log"), `${result.stdout}\n${result.stderr}`);
    if (result.timedOut) {
      throw new CliError(`The run took longer than maxRunMinutes (${limit})`, "ENVIRONMENT_ERROR", ["Raise limits.maxRunMinutes in e2e/proofy.json or run fewer flows"]);
    }
    return result.code;
  } finally {
    await bridge.stop();
  }
}

/** Gives the fake-service container a fresh start for a dev test: current fakes, empty state, no earlier calls. */
export async function resetFakes(proc: Proc, sandbox: Sandbox): Promise<void> {
  await must(
    proc("docker", [...compose(sandbox), "exec", "-T", STANDIN, "wget", "-q", "-O", "-", "--header", `Authorization: Bearer ${sandbox.token}`, "--post-data", "", `http://127.0.0.1:${ADMIN_PORT}/reset`]),
    "Resetting the fake-service container failed",
  );
}

export async function saveLogs(proc: Proc, sandbox: Pick<Sandbox, "project" | "composeFile">, dir: string): Promise<void> {
  const logs = await proc("docker", [...compose(sandbox), "logs", "--no-color", "--timestamps"]);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "sandbox.log"), logs.stdout + logs.stderr);
}

export async function stop(proc: Proc, sandbox: Pick<Sandbox, "project" | "composeFile">): Promise<void> {
  await proc("docker", [...compose(sandbox), "down", "-v", "--remove-orphans", "--timeout", "5"], { timeoutMs: 120_000 });
}

export async function forwardedPorts(proc: Proc, sandbox: Sandbox): Promise<{ app?: string; mail?: string }> {
  const port = async (inner: string) => {
    const result = await proc("docker", [...compose(sandbox), "port", "proofy-forward", inner]);
    const match = /:(\d+)\s*$/.exec(result.stdout.trim());
    return match ? `http://127.0.0.1:${match[1]}` : undefined;
  };
  const app = await port("8080");
  const mail = await port("8025");
  return { ...(app ? { app } : {}), ...(mail ? { mail } : {}) };
}

export function hostUser(): string {
  return `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
}

export function compose(sandbox: Pick<Sandbox, "project" | "composeFile">): string[] {
  return ["compose", "-p", sandbox.project, "-f", sandbox.composeFile];
}

interface Bridge {
  stop: () => Promise<void>;
}

// Tests ask for exec() by writing a request file to a folder shared with the host, which runs the named command
// with docker compose exec. The runner container never gets access to Docker itself.
function startExecBridge(proc: Proc, options: SandboxOptions, sandbox: Sandbox): Bridge {
  const dir = join(sandbox.workDir, "runner", "exec");
  let running = true;
  const busy = new Set<string>();
  const answer = async (file: string): Promise<Record<string, unknown>> => {
    let raw: string;
    try {
      raw = await readFile(join(dir, file), "utf8");
    } finally {
      await rm(join(dir, file), { force: true });
    }
    const { name, args } = JSON.parse(raw) as { name?: unknown; args?: unknown };
    if (typeof name !== "string" || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      return { error: "exec() sent a request without a command name and string arguments" };
    }
    const named = options.config.exec[name];
    if (!named) {
      return { error: `exec("${name}") is not in e2e/proofy.json exec. Named commands: ${Object.keys(options.config.exec).join(", ") || "none"}` };
    }
    const result = await proc("docker", [...compose(sandbox), "exec", "-T", named.service, ...named.command, ...args], {
      timeoutMs: options.config.limits.testMinutes * 60_000,
    });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };
  // Never throws: a request that cannot be answered gets an error response, so the test fails with the reason
  // and the run goes on.
  const handle = async (file: string) => {
    const id = file.slice(0, -".req.json".length);
    let response: Record<string, unknown>;
    try {
      response = await answer(file);
    } catch (error) {
      response = { error: `The host could not answer exec(): ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      await writeFile(join(dir, `${id}.tmp`), JSON.stringify(response));
      await rename(join(dir, `${id}.tmp`), join(dir, `${id}.res.json`));
    } catch {
      // The test gives up waiting and says exec() got no answer.
    }
  };
  const loop = (async () => {
    while (running) {
      let files: string[] = [];
      try {
        files = await readdir(dir);
      } catch {
        // The folder appears with the first request.
      }
      for (const file of files) {
        if (!file.endsWith(".req.json") || busy.has(file)) continue;
        busy.add(file);
        void handle(file).finally(() => busy.delete(file));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

async function downloadAssets(options: SandboxOptions, sandbox: Sandbox): Promise<void> {
  if (options.config.assets.length === 0) return;
  const dir = join(sandbox.workDir, "setup", "assets");
  await mkdir(dir, { recursive: true });
  for (const url of options.config.assets) {
    options.log(`downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new CliError(`Downloading asset ${url} failed with HTTP ${response.status}`, "ENVIRONMENT_ERROR", ["Check the URL in e2e/proofy.json assets"]);
    await writeFile(join(dir, assetFile(url)), Buffer.from(await response.arrayBuffer()));
  }
}

function assetKey(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}${parsed.pathname}`;
}

function assetFile(url: string): string {
  return createHash("sha256").update(assetKey(url)).digest("hex").slice(0, 24);
}

async function must(result: Promise<{ code: number; stderr: string; stdout: string }>, message: string): Promise<void> {
  const done = await result;
  if (done.code !== 0) throw new CliError(message, "ENVIRONMENT_ERROR", [tail(done.stderr || done.stdout, 12)]);
}
