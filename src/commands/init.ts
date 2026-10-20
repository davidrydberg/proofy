import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../args.js";
import { SCHEMA_URL } from "../config.js";
import type { Deps } from "../deps.js";
import { renderInit, type Hint } from "../human.js";
import { COMPOSE_NAMES, detectCompose, detectEnv, type EnvGuess } from "../detect.js";
import { detectOutside } from "../outside.js";
import { exists, findRoot, pathsFor } from "../project.js";
import { ONBOARDING_ASK } from "./home.js";
import type { CommandResult } from "./types.js";

export const INIT_HELP = `usage: proofy init [--no-agents-md]
description: Writes e2e/ with agent instructions, templates and a config filled from what it finds: the app's services, example settings, analytics hosts to record, and a backend it cannot see. Never overwrites a file; run it again to see what it finds
flags[1]:
  --no-agents-md  Do not add the pointer line to the repository's AGENTS.md or CLAUDE.md
examples:
  proofy init
`;

const TEMPLATES = fileURLToPath(new URL("../../templates/", import.meta.url));
const POINTER =
  "End-to-end tests: read `e2e/AGENTS.md` before writing or changing anything under `e2e/`, and before changing a flow it covers. A request to add, change or set up a proofy test is the go-ahead to edit files under `e2e/`.";
// Any earlier wording of the pointer counts as present, so init never adds a second one.
const POINTER_MARK = "read `e2e/AGENTS.md`";
const IGNORE = "e2e/out/";

export async function initCommand(args: string[], deps: Deps): Promise<CommandResult> {
  const flags = parseArgs(args, { values: [], booleans: ["no-agents-md"] }, "init");
  const root = await initRoot(deps.cwd);
  const paths = pathsFor(root);
  const written: string[] = [];
  const skipped: string[] = [];
  const found: string[] = [];

  const compose = await detectCompose(root);
  const rootEnv = await detectEnv(root);
  // Each page-serving service gets the example settings from its own build folder or a folder named after it, the browser's first one falls back to the root's.
  const envFor: Record<string, EnvGuess> = {};
  for (const frontend of compose?.frontends ?? []) {
    let env: EnvGuess | undefined;
    for (const dir of [compose?.contexts[frontend.service], frontend.service]) {
      if (!env && dir && dir !== ".") env = await detectEnv(root, dir);
    }
    env ??= frontend === compose?.app ? rootEnv : undefined;
    if (env) envFor[frontend.service] = env;
  }
  const envs = [...new Map([rootEnv, ...Object.values(envFor)].filter((env): env is EnvGuess => env !== undefined).map((env) => [env.file, env])).values()];
  const outside = await detectOutside(root, compose, envs);

  if (compose) {
    found.push(`${compose.file}: services ${compose.services.join(", ") || "none"}`);
    found.push(compose.app ? `app: likely ${compose.app.service} on port ${compose.app.port}` : "app: no service with a port, your agent picks one");
    const others = compose.frontends.slice(1);
    if (others.length > 0) found.push(`also serving pages: ${others.map((f) => `${f.service} on port ${f.port}`).join(", ")}. A test opens them at http://<service>:<port>/`);
    for (const mount of compose.sourceMounts) {
      found.push(`${mount.service} mounts ${mount.source} at ${mount.target}, so it is set up for development. The sandbox has no internet once it runs: your agent writes a compose file under e2e/ that installs dependencies when the image is built`);
    }
  } else {
    found.push("no compose file: your agent drafts one during setup");
  }
  for (const env of envs) {
    const used = Object.entries(envFor).filter(([, e]) => e === env).map(([service]) => service);
    found.push(`${env.file}: ${Object.keys(env.values).length} settings${used.length > 0 ? ` for ${used.join(", ")}` : ""}, ${env.replaced} secret-looking values replaced with fakes`);
  }
  for (const port of new Set(outside.backends.map((backend) => backend.port))) {
    const same = outside.backends.filter((backend) => backend.port === port);
    const [first] = same;
    const settings = same.map((backend) => `${backend.key} in ${backend.file}`).join(" and ");
    const where = first?.sibling ? `, such as ${first.sibling.dir} (its ${first.sibling.service} service publishes ${port})` : "";
    found.push(`${settings} ${same.length > 1 ? "point" : "points"} at localhost:${port}, which nothing here serves: likely a backend in another repository${where}. The sandbox builds only from this repository, so the backend comes in as a prebuilt image or as a fake`);
  }
  if (outside.record.length > 0) found.push(`recorded: ${outside.record.join(", ")} (analytics and error reports: the app does not need their answer)`);
  if (outside.decide.length > 0) found.push(`outside hosts for your agent to fake or record: ${outside.decide.map((d) => `${d.host} (${d.from})`).join(", ")}`);

  const config: Record<string, unknown> = { $schema: SCHEMA_URL, compose: compose ? [compose.file] : [] };
  if (compose?.app) config.app = { service: compose.app.service, port: compose.app.port, path: "/" };
  if (Object.keys(envFor).length > 0) config.env = Object.fromEntries(Object.entries(envFor).map(([service, env]) => [service, env.values]));
  config.hosts = Object.fromEntries(outside.record.map((host) => [host, "record"]));

  const write = async (file: string, content: string | (() => Promise<void>)) => {
    const label = relative(root, file);
    if (await exists(file)) {
      skipped.push(label);
      return;
    }
    await mkdir(dirname(file), { recursive: true });
    if (typeof content === "string") await writeFile(file, content);
    else await content();
    written.push(label);
  };

  await write(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  for (const file of await listFiles(TEMPLATES)) {
    const source = join(TEMPLATES, file);
    await write(join(root, file), () => copyFile(source, join(root, file)));
  }
  for (const dir of [paths.specs, paths.tests, paths.standins]) {
    await mkdir(dir, { recursive: true });
  }

  if (await addLine(join(root, ".gitignore"), IGNORE)) written.push(".gitignore (e2e/out/)");
  let pointer = "skipped (--no-agents-md)";
  if (!flags.booleans.has("no-agents-md")) {
    const target = (await exists(join(root, "AGENTS.md"))) || !(await exists(join(root, "CLAUDE.md"))) ? "AGENTS.md" : "CLAUDE.md";
    pointer = (await addLine(join(root, target), POINTER, POINTER_MARK)) ? `added to ${target}` : `already in ${target}`;
    if (pointer.startsWith("added")) written.push(`${target} (pointer to e2e/AGENTS.md)`);
  }

  const hints: Hint[] = [
    [ONBOARDING_ASK, ""],
    ["proofy", "see setup progress and the next step at any time"],
  ];
  return {
    data: { root, found, written, kept: skipped, agents_md_pointer: pointer },
    help: hints.map(([command, description]) => (description ? `Run \`${command}\` to ${description}` : command)),
    pretty: (style) => renderInit({ root, found, written, skipped }, hints, style),
  };
}

/** An existing proofy project, else the folder you are in when it has a compose file (an app in a monorepo), else the repository root. */
async function initRoot(cwd: string): Promise<string> {
  const found = await findRoot(cwd);
  if (await exists(pathsFor(found).config)) return found;
  for (const name of COMPOSE_NAMES) {
    if (await exists(join(cwd, name))) return cwd;
  }
  return found;
}

/** Appends a line unless the file already has it, or a line containing `mark`. Returns whether it wrote. */
async function addLine(file: string, line: string, mark?: string): Promise<boolean> {
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch {
    // A missing file is created.
  }
  if (current.split(/\r?\n/).some((existing) => existing.trim() === line || (mark !== undefined && existing.includes(mark)))) return false;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${separator}${current === "" ? "" : "\n"}${line}\n`);
  return true;
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(dir, path)));
    else out.push(path);
  }
  return out.sort();
}
