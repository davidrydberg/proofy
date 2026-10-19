import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../args.js";
import { SCHEMA_URL } from "../config.js";
import type { Deps } from "../deps.js";
import { renderInit, type Hint } from "../human.js";
import { COMPOSE_NAMES, detectCompose, detectEnv } from "../detect.js";
import { exists, findRoot, pathsFor } from "../project.js";
import type { CommandResult } from "./types.js";

export const INIT_HELP = `usage: proofy init [--no-agents-md]
description: Writes e2e/ with agent instructions, templates and a config filled from what it finds. Never overwrites a file
flags[1]:
  --no-agents-md  Do not add the pointer line to the repository's AGENTS.md or CLAUDE.md
examples:
  proofy init
`;

const TEMPLATES = fileURLToPath(new URL("../../templates/", import.meta.url));
const POINTER = "End-to-end tests: read `e2e/AGENTS.md` before writing or changing anything under `e2e/`, and before changing a flow it covers.";
const IGNORE = "e2e/out/";

export async function initCommand(args: string[], deps: Deps): Promise<CommandResult> {
  const flags = parseArgs(args, { values: [], booleans: ["no-agents-md"] }, "init");
  const root = await initRoot(deps.cwd);
  const paths = pathsFor(root);
  const written: string[] = [];
  const skipped: string[] = [];
  const found: string[] = [];

  const compose = await detectCompose(root);
  const env = await detectEnv(root);
  if (compose) {
    found.push(`${compose.file}: services ${compose.services.join(", ") || "none"}`);
    found.push(compose.app ? `app: likely ${compose.app.service} on port ${compose.app.port}` : "app: no service with a port, your agent picks one");
  } else {
    found.push("no compose file: your agent drafts one during setup");
  }
  if (env) {
    found.push(`${env.file}: ${Object.keys(env.values).length} settings, ${env.replaced} secret-looking values replaced with fakes`);
  }

  const config: Record<string, unknown> = { $schema: SCHEMA_URL, compose: compose ? [compose.file] : [] };
  if (compose?.app) {
    config.app = { service: compose.app.service, port: compose.app.port, path: "/" };
    if (env) config.env = { [compose.app.service]: env.values };
  }
  config.hosts = {};

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
    pointer = (await addLine(join(root, target), POINTER)) ? `added to ${target}` : `already in ${target}`;
    if (pointer.startsWith("added")) written.push(`${target} (pointer to e2e/AGENTS.md)`);
  }

  const hints: Hint[] = [
    ['Next, ask your agent: "set up proofy". It reads e2e/AGENTS.md, checks the app starts in Docker and fills in the rest of e2e/proofy.json', ""],
    ['Then tell it what to test, in plain words: "add a proofy test: a guest can buy a product"', ""],
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

/** Appends a line unless the file already has it. Returns whether it wrote. */
async function addLine(file: string, line: string): Promise<boolean> {
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch {
    // A missing file is created.
  }
  if (current.split(/\r?\n/).some((existing) => existing.trim() === line)) return false;
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
