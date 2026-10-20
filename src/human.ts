import type { Verdict } from "./run/report.js";
import type { RequirementOutcome, RunReport } from "./run/results.js";
import { GLYPH, padVisible, painter, stripAnsi, truncate, type Painter, type Style } from "./style.js";

export type Hint = [command: string, description: string];

export interface Check {
  label: string;
  ok: boolean;
  value: string;
}

export interface HomeView {
  project: string;
  checks: Check[];
  flows: Array<{ name: string; state: string; reason?: string }>;
  orphans: string[];
  lastRun: string;
}

export interface InitView {
  root: string;
  found: string[];
  written: string[];
  skipped: string[];
}

export function renderHome(view: HomeView, hints: Hint[], style: Style): string {
  const p = painter(style);
  const ready = view.checks.every((check) => check.ok);
  const lines = [`${p.bold(view.project)}  ${ready ? p.green("set up") : p.yellow("setup incomplete")}`, "", p.bold("SETUP")];
  lines.push(...checkRows(view.checks, p, style));
  lines.push("", p.bold(`FLOWS (${view.flows.length})`));
  if (view.flows.length === 0) {
    lines.push(p.dim("  none yet"));
  }
  const width = Math.max(0, ...view.flows.map((flow) => flow.name.length));
  for (const flow of view.flows) {
    lines.push(`  ${padVisible(flow.name, width)}  ${stateText(flow.state, p)}${flow.reason ? p.dim(`  ${flow.reason}`) : ""}`);
  }
  for (const orphan of view.orphans) {
    lines.push(`  ${padVisible(orphan, width)}  ${p.red(`${GLYPH.fail} test without requirements`)}`);
  }
  lines.push("", `${p.bold("LAST RUN")}  ${view.lastRun}`);
  return [lines.join("\n"), nextSection(hints, p, style)].join("\n\n");
}

export function renderInit(view: InitView, hints: Hint[], style: Style): string {
  const p = painter(style);
  const lines = [p.bold(`proofy init  ${view.root}`)];
  if (view.found.length > 0) {
    lines.push("", p.bold("FOUND"), ...view.found.map((line) => `  ${truncate(line, style.width - 2)}`));
  }
  lines.push("", p.bold("WROTE"));
  lines.push(...(view.written.length > 0 ? view.written.map((file) => `  ${p.green(GLYPH.ok)} ${file}`) : [p.dim("  nothing, everything was there")]));
  if (view.skipped.length > 0) {
    lines.push("", p.bold("KEPT"), ...view.skipped.map((file) => p.dim(`  ${file} already exists`)));
  }
  return [lines.join("\n"), nextSection(hints, p, style)].join("\n\n");
}

const VERDICT_TEXT: Record<Verdict, string> = {
  pass: "PASS  every requirement of every approved flow held",
  fail: "FAIL  an approved flow has a requirement that did not hold",
  untrusted: "NOT TRUSTED  some flows are not approved, so this proves nothing yet",
  environment: "ENVIRONMENT FAILURE  the sandbox did not work; this says nothing about the app",
};

export function renderRun(report: RunReport, result: Verdict, reportPath: string, hints: Hint[], style: Style, posted?: string): string {
  const p = painter(style);
  const color = result === "pass" ? p.green : result === "untrusted" ? p.yellow : p.red;
  const lines = [`${color(p.bold(VERDICT_TEXT[result]))}`, p.dim(`run ${report.id}  ${reportPath}`)];
  for (const flow of report.source.approvalsChanged ?? []) {
    lines.push(p.yellow(`approval changed in this PR: ${flow}`));
  }
  if (report.environmentError) {
    lines.push("", ...report.environmentError.split("\n").slice(0, 8).map((line) => `  ${p.red(truncate(line, style.width - 2))}`));
  }
  for (const flow of report.flows) {
    const trust = flow.approved ? "" : p.yellow(`  not approved${flow.changed ? `, changed since approval: ${flow.changed.join(", ")}` : ""}`);
    lines.push("", `${p.bold(flow.name)}  ${flow.status === "passed" ? p.green("passed") : p.red("failed")}${trust}`);
    for (const requirement of flow.requirements) {
      const detail =
        requirement.result === "pass"
          ? requirement.text
          : requirement.result === "not-covered"
            ? `${requirement.text}  ${p.dim(`(not covered: ${requirement.why ?? ""})`)}`
            : requirement.result === "not-checked"
              ? `${requirement.text}  ${p.yellow("(no claim checks it)")}`
              : requirement.result === "not-reached"
                ? `${requirement.text}  ${p.red("(not reached: the test stopped before checking it)")}`
                : `${requirement.text}  ${p.red(`expected ${requirement.expected ?? "?"}, got ${requirement.actual ?? "?"}`)}`;
      lines.push(`  ${outcomeMark(requirement.result, p)} ${padVisible(requirement.id, 4)} ${truncateVisible(detail, style.width - 9)}`);
    }
  }
  const broken = report.flows.flatMap((flow) => flow.tests.filter((test) => test.status !== "passed" && test.error && !/Requirements not met/.test(test.error)).map((test) => ({ flow: flow.name, test })));
  if (broken.length > 0) {
    lines.push("", p.bold("TEST ERRORS"));
    for (const { flow, test } of broken) {
      const first = (test.error ?? "").split("\n").filter((line) => line.trim()).slice(0, 3);
      lines.push(`  ${p.bold(flow)}: ${test.title} (${test.status})`, ...first.map((line) => `    ${p.red(truncate(line.trim(), style.width - 4))}`));
    }
  }
  const refused = report.outside.filter((call) => call.handledAs === "refused").map((call) => call.host);
  if (report.outside.length > 0) {
    const handled = report.outside.filter((call) => call.handledAs !== "refused").map((call) => `${call.host} ${call.handledAs} x${call.count}`);
    lines.push("", p.bold("OUTSIDE CALLS"));
    if (handled.length > 0) lines.push(`  ${truncate(handled.join(", "), style.width - 2)}`);
    if (refused.length > 0) lines.push(`  ${p.yellow(truncate(`refused: ${refused.join(", ")}`, style.width - 2))}`);
  }
  if (posted) lines.push("", `posted on ${posted}`);
  return [lines.join("\n"), nextSection(hints, p, style)].join("\n\n");
}

function outcomeMark(result: RequirementOutcome, p: Painter): string {
  switch (result) {
    case "pass":
      return p.green(GLYPH.ok);
    case "not-covered":
      return p.dim("-");
    case "not-checked":
      return p.yellow(GLYPH.warn);
    default:
      return p.red(GLYPH.fail);
  }
}

// Keeps colors when the line fits and drops them when it has to be cut.
function truncateVisible(text: string, max: number): string {
  const plain = stripAnsi(text);
  return plain.length > max ? truncate(plain, max) : text;
}

export function renderErrorHuman(message: string, code: string, suggestions: string[], style: Style): string {
  const p = painter(style);
  const lines = [`${p.red(`${GLYPH.fail} ${message}`)} ${p.dim(`(${code})`)}`];
  for (const suggestion of suggestions) {
    lines.push(`  ${suggestion}`);
  }
  return lines.join("\n");
}

function checkRows(checks: Check[], p: Painter, style: Style): string[] {
  const width = Math.max(...checks.map((check) => check.label.length));
  return checks.map((check) => {
    const mark = check.ok ? p.green(GLYPH.ok) : p.yellow(GLYPH.warn);
    const value = truncate(check.value, Math.max(10, style.width - width - 7));
    return `  ${mark} ${padVisible(check.label, width)}  ${check.ok ? value : p.yellow(value)}`;
  });
}

function stateText(state: string, p: Painter): string {
  switch (state) {
    case "approved":
      return p.green(`${GLYPH.ok} approved`);
    case "ready":
      return p.cyan("ready, waiting for the human to approve");
    case "draft":
      return p.yellow("draft, no test yet");
    case "unproven":
      return p.yellow("unproven");
    case "unstable":
      return p.red("unstable, runs differ");
    case "out-of-date":
      return p.yellow("out of date, changed since approval");
    default:
      return state;
  }
}

function nextSection(hints: Hint[], p: Painter, style: Style): string {
  const width = Math.max(0, ...hints.filter(([, description]) => description).map(([command]) => command.length));
  return [
    p.bold("NEXT"),
    ...hints.map(([command, description]) =>
      description
        ? `  ${padVisible(p.cyan(command), width)}  ${p.dim(truncate(description, Math.max(10, style.width - width - 4)))}`
        : wrap(command, style.width, "  ", "    "),
    ),
  ].join("\n");
}

// Onboarding sentences are the instructions; they wrap instead of being cut off.
function wrap(text: string, width: number, first: string, rest: string): string {
  const lines: string[] = [];
  let line = first;
  for (const word of text.split(" ")) {
    const indent = lines.length === 0 ? first : rest;
    if (line.length > indent.length && line.length + 1 + word.length > width) {
      lines.push(line);
      line = rest + word;
    } else {
      line = line.length > indent.length ? `${line} ${word}` : line + word;
    }
  }
  lines.push(line);
  return lines.join("\n");
}
