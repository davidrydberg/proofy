import { readFileSync } from "node:fs";
import { homeCommand } from "./commands/home.js";
import { APPROVE_HELP, approveCommand } from "./commands/approve.js";
import { DEV_HELP, devCommand } from "./commands/dev.js";
import { INIT_HELP, initCommand } from "./commands/init.js";
import { REPORT_HELP, reportCommand } from "./commands/report.js";
import { RUN_HELP, runCommand } from "./commands/run.js";
import type { CommandResult } from "./commands/types.js";
import type { Deps } from "./deps.js";
import { CliError, exitCodeFor } from "./errors.js";
import { renderErrorHuman } from "./human.js";
import { renderError, renderJson, renderResult } from "./output.js";
import { painter, resolveStyle, type Style } from "./style.js";

export const DESCRIPTION = "Sealed end-to-end tests that your coding agent writes and you approve";

export interface Io {
  write: (text: string) => void;
  isTTY: boolean;
  columns?: number | undefined;
}

type Format = "toon" | "json" | "pretty";

const FORMAT_FLAGS: Record<string, Format> = { "--toon": "toon", "--json": "json", "--pretty": "pretty" };

const TOP_HELP = `usage: proofy [command] [args] [flags]
description: ${DESCRIPTION}
commands[6]:
  (none)  Setup progress, flows and their states, last run, next step. Reads files only, safe for a session-start hook
  init [--no-agents-md]  Write e2e/ with agent instructions, templates and a config filled from what it finds
  run [flow ...] [--all] [--pr <n>] [--post] [--keep]  One sealed run with a report per requirement
  dev up|test|down  A sandbox that stays up while tests are written
  approve <flow>  For the human: trust a flow after 3 identical runs
  report [run]  Show a past run
flags[5]:
  --help  Show help, also after a command
  -v, --version  Print the version
  --toon  TOON output (default when not on a terminal)
  --pretty  Human view (default on a terminal)
  --json  Full data as JSON
exit_codes[5]:
  0  Done; in a run, every requirement of every approved flow held
  1  A requirement of an approved flow did not hold: a finding about the app
  2  Usage error, invalid config or not set up
  3  Environment failure: Docker, the sandbox, a time limit. Says nothing about the app
  4  Not trusted: the flows asked for are not approved or out of date
how_it_works:
  You describe flows in plain words. Your agent follows e2e/AGENTS.md to write requirements, tests and fakes.
  You approve them, and every run checks the app in a sealed Docker sandbox with no AI.
requires: Node 24+, Docker on macOS or Linux, git; gh for --pr and --post
examples:
  proofy init
  proofy
  proofy dev up
  proofy dev test guest-checkout
  proofy approve guest-checkout
  proofy run --all
`;

// One help text per command. The human view is derived from it, so the two never disagree.
function humanHelp(text: string, style: Style): string {
  const p = painter(style);
  const out: string[] = [];
  for (const line of text.trimEnd().split("\n")) {
    const header = /^([a-z_]+)(\[\d+\])?:\s*(.*)$/.exec(line);
    if (header) {
      const [, name = "", , rest = ""] = header;
      if (name === "usage") out.push(`${p.bold("USAGE")}\n  ${rest}`);
      else if (name === "description") out.unshift(`${p.bold("proofy")} - ${rest}`);
      else out.push(`\n${p.bold(name.replace(/_/g, " ").toUpperCase())}${rest ? `\n  ${rest}` : ""}`);
      continue;
    }
    const row = /^ {2}(\S.*?) {2,}(.*)$/.exec(line);
    out.push(row ? `  ${p.cyan(row[1] ?? "")}  ${row[2] ?? ""}` : line);
  }
  return out.join("\n");
}

const COMMANDS: Record<string, { run: (args: string[], deps: Deps) => Promise<CommandResult>; help: string }> = {
  init: { run: initCommand, help: INIT_HELP },
  run: { run: runCommand, help: RUN_HELP },
  dev: { run: devCommand, help: DEV_HELP },
  approve: { run: approveCommand, help: APPROVE_HELP },
  report: { run: reportCommand, help: REPORT_HELP },
};

export async function runCli(argv: string[], deps: Deps, io: Io): Promise<number> {
  const style = resolveStyle(deps.env, io.isTTY, io.columns);
  let format: Format = io.isTTY ? "pretty" : "toon";
  try {
    const formats = [...new Set(argv.filter((arg) => arg in FORMAT_FLAGS))];
    if (formats.length > 1) {
      throw new CliError("Use only one of --pretty, --toon and --json", "VALIDATION_ERROR", ["Run `proofy --help`"]);
    }
    const chosen = formats[0];
    if (chosen !== undefined) {
      format = FORMAT_FLAGS[chosen] ?? format;
    }
    const [command, ...args] = argv.filter((arg) => !(arg in FORMAT_FLAGS));
    const pretty = format === "pretty";

    if (command === undefined) {
      return emit(await homeCommand(deps), format, style, io);
    }
    if (command === "--help" || command === "-h" || command === "help") {
      io.write(pretty ? `${humanHelp(TOP_HELP, style)}\n` : TOP_HELP);
      return 0;
    }
    if (command === "--version" || command === "-v") {
      io.write(`${version()}\n`);
      return 0;
    }
    if (command.startsWith("-")) {
      throw new CliError(`Flags go after the command, got ${command}`, "VALIDATION_ERROR", ["Run `proofy --help`"]);
    }
    const entry = COMMANDS[command];
    if (!entry) {
      throw new CliError(`Unknown command: ${command}`, "VALIDATION_ERROR", ["Run `proofy --help` to see commands"]);
    }
    if (args.includes("--help") || args.includes("-h")) {
      io.write(pretty ? `${humanHelp(entry.help, style)}\n` : entry.help);
      return 0;
    }
    return emit(await entry.run(args, deps), format, style, io);
  } catch (error) {
    const known = error instanceof CliError;
    const message = error instanceof Error ? error.message : String(error);
    const code = known ? error.code : "UNEXPECTED";
    const suggestions = known ? error.suggestions : ["This is a bug in proofy. Run again with the same arguments and report the message"];
    io.write(`${format === "pretty" ? renderErrorHuman(message, code, suggestions, style) : renderError(message, code, suggestions)}\n`);
    return exitCodeFor(error);
  }
}

function emit(result: CommandResult | string, format: Format, style: Style, io: Io): number {
  if (typeof result === "string") {
    io.write(`${result}\n`);
  } else if (format === "json") {
    io.write(`${renderJson(result.json ?? result.data)}\n`);
  } else if (format === "pretty" && result.pretty) {
    io.write(`${result.pretty(style)}\n`);
  } else {
    io.write(`${renderResult(result)}\n`);
  }
  return typeof result === "string" ? 0 : (result.exitCode ?? 0);
}

export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
