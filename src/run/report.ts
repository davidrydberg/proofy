import type { FlowResult, RequirementOutcome, RunReport } from "./results.js";

const LABEL: Record<RequirementOutcome, string> = {
  pass: "pass",
  fail: "FAIL",
  "not-covered": "not covered",
  "not-reached": "FAIL (not reached)",
  "not-checked": "not checked",
};

export type Verdict = "pass" | "fail" | "untrusted" | "environment";

/** The run's one-word result, matching the exit code: environment 3, a failed approved flow 1, untrusted 4, pass 0. */
export function verdict(report: RunReport): Verdict {
  if (report.environmentError) return "environment";
  if (report.flows.some((flow) => flow.approved && flow.status === "failed")) return "fail";
  if (report.flows.some((flow) => !flow.approved)) return "untrusted";
  return "pass";
}

export const EXIT_FOR: Record<Verdict, number> = { pass: 0, fail: 1, environment: 3, untrusted: 4 };

const HEADLINE: Record<Verdict, string> = {
  pass: "PASS: every requirement of every approved flow held",
  fail: "FAIL: an approved flow has a requirement that did not hold",
  untrusted: "NOT TRUSTED: some flows are not approved, so their results prove nothing yet",
  environment: "ENVIRONMENT FAILURE: the sandbox did not work, so this run says nothing about the app",
};

/**
 * The report a person reads: per requirement what was asked, what happened and the evidence.
 * `image` turns a screenshot path relative to the run folder into a link, local or on GitHub.
 */
export function renderMarkdown(report: RunReport, image: (path: string) => string, options: { title?: string; maxShots?: number } = {}): string {
  const result = verdict(report);
  const lines = [`## ${options.title ?? "proofy"}: ${HEADLINE[result]}`, ""];
  const source = [report.source.pr ? `PR #${report.source.pr}` : undefined, report.source.commit ? `commit ${report.source.commit.slice(0, 12)}` : undefined, report.source.dirty ? "with uncommitted changes" : undefined].filter(Boolean);
  lines.push(`Run ${report.id} (${report.kind}), ${source.join(", ") || "working tree"}. Sealed: the app had no way out; every outside call went to a fake or was refused.`, "");
  if (report.source.approvalsChanged) {
    lines.push(
      "**Approvals changed in this PR.** Only a person runs `proofy approve`: check in review that each change to e2e/proofy.lock.json is theirs.",
      "",
      ...report.source.approvalsChanged.map((flow) => `- approval changed in this PR: ${flow}`),
      "",
    );
  }
  if (report.environmentError) {
    lines.push("```", report.environmentError, "```", "");
  }
  if (report.flows.length > 0) {
    lines.push("| Flow | Result | Approved |", "|---|---|---|");
    for (const flow of report.flows) {
      const counts = countResults(flow);
      lines.push(`| ${flow.name} | ${flow.status === "passed" ? "passed" : "FAILED"} (${counts}) | ${flow.approved ? "yes" : `no, result not trusted${flow.changed ? ` (changed since approval: ${flow.changed.join(", ")})` : ""}`} |`);
    }
    lines.push("");
  }
  for (const flow of report.flows) {
    lines.push(...flowSection(flow, image, options.maxShots));
  }
  lines.push(...outsideSection(report));
  if (report.notes.length > 0) {
    lines.push("### Notes", "", ...report.notes.map((note) => `- ${note}`), "");
  }
  return lines.join("\n");
}

function flowSection(flow: FlowResult, image: (path: string) => string, maxShots = Infinity): string[] {
  const lines = [`### ${flow.name}`, ""];
  lines.push("| Req | Result | Requirement | What the test did | Expected | Actual | Relied on fakes |", "|---|---|---|---|---|---|---|");
  for (const requirement of flow.requirements) {
    const did = requirement.result === "not-covered" ? `not covered: ${requirement.why ?? ""}` : (requirement.did ?? "");
    lines.push(
      `| ${requirement.id} | ${LABEL[requirement.result]} | ${cell(requirement.text)} | ${cell(did)} | ${cell(requirement.expected ?? "")} | ${cell(requirement.actual ?? "")} | ${cell(requirement.fakes.join(", ") || "none")} |`,
    );
  }
  lines.push("");
  const evidence = flow.requirements.filter((requirement) => requirement.evidence !== undefined);
  if (evidence.length > 0) {
    lines.push("<details><summary>Evidence</summary>", "");
    for (const requirement of evidence) {
      lines.push(`${requirement.id}:`, "", "```json", JSON.stringify(requirement.evidence, null, 2).slice(0, 4000), "```", "");
    }
    lines.push("</details>", "");
  }
  const broken = flow.tests.filter((test) => test.status !== "passed");
  for (const test of broken) {
    lines.push(`**${test.title}**: ${test.status}${test.trace ? ` (trace: \`${test.trace}\`, open with \`npx playwright show-trace\`)` : ""}`, "", "```", (test.error ?? "").slice(0, 1500), "```", "");
  }
  if (flow.unknownClaims.length > 0) {
    lines.push(`Claims cite ${flow.unknownClaims.join(", ")}, which the spec does not have.`, "");
  }
  if (flow.shots.length > 0) {
    lines.push("<details><summary>Screenshots</summary>", "");
    for (const shot of flow.shots.slice(0, maxShots)) {
      lines.push(`${shot.label}`, "", `<img src="${image(`flows/${flow.name}/${shot.file}`)}" width="360">`, "");
    }
    if (flow.shots.length > maxShots) lines.push(`and ${flow.shots.length - maxShots} more in the run folder`, "");
    lines.push("</details>", "");
  }
  return lines;
}

function outsideSection(report: RunReport): string[] {
  if (report.outside.length === 0 && report.lookedUpOnly.length === 0) return [];
  const lines = ["### Outside calls", ""];
  if (report.outside.length > 0) {
    lines.push("| Host | Handled as | Requests |", "|---|---|---|");
    for (const call of report.outside) lines.push(`| ${call.host} | ${call.handledAs} | ${call.count} |`);
    lines.push("");
  }
  const refused = report.outside.filter((call) => call.handledAs === "refused").map((call) => call.host);
  if (refused.length > 0) {
    lines.push(`Refused: ${refused.join(", ")}. If the app needs them, list them in e2e/proofy.json hosts.`, "");
  }
  if (report.lookedUpOnly.length > 0) {
    lines.push(`Looked up but never called over HTTP (another protocol, or the call gave up): ${report.lookedUpOnly.join(", ")}.`, "");
  }
  return lines;
}

export function countResults(flow: FlowResult): string {
  const counts = new Map<string, number>();
  for (const requirement of flow.requirements) counts.set(requirement.result, (counts.get(requirement.result) ?? 0) + 1);
  return [...counts].map(([result, count]) => `${count} ${result}`).join(", ") || "no requirements";
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 300);
}
