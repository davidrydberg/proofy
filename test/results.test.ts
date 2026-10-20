import { describe, expect, it } from "vitest";
import { proven } from "../src/run/history.js";
import { renderMarkdown, verdict } from "../src/run/report.js";
import { flowResult, type FlowResult, type PlannedFlow, type RunReport } from "../src/run/results.js";
import { parseRequirements } from "../src/run/spec.js";
import type { Entry } from "../src/test/index.js";

const plan: PlannedFlow = {
  name: "checkout",
  approved: true,
  fingerprint: { spec: "a", test: "b", fakes: "c", config: "d", compose: "e" },
  requirements: parseRequirements("# Checkout\n\nR1. Order number shown.\n- R2: Paid order stored.\n**R3**) Email sent.\nR4. Card page works.\nR1. duplicate ignored\n"),
};

const claim = (spec: string, ok: boolean, extra: Partial<Extract<Entry, { type: "claim" }>> = {}): Entry => ({ type: "claim", test: "t", spec, did: "did", expected: "e", actual: "a", ok, fakes: [], ...extra });
const passed = [{ title: "t", status: "passed", durationMs: 10 }];

describe("results", () => {
  it("parses numbered requirements in common Markdown shapes", () => {
    expect(plan.requirements.map((r) => r.id)).toEqual(["R1", "R2", "R3", "R4"]);
    expect(plan.requirements[1]!.text).toBe("Paid order stored.");
  });

  it("maps claims to requirement results", () => {
    const flow = flowResult(
      plan,
      [claim("R1", true), claim("R2", true, { fakes: ["api.pay.test"] }), claim("R2", false), { type: "not-covered", test: "t", spec: "R4", why: "sealed" }, claim("R9", true), { type: "shot", test: "t", file: "f.png", label: "l" }],
      [{ title: "t", status: "failed", durationMs: 10, error: "Requirements not met: R2" }],
    );
    expect(flow.requirements.map((r) => `${r.id}:${r.result}`)).toEqual(["R1:pass", "R2:fail", "R3:not-checked", "R4:not-covered"]);
    expect(flow.requirements[1]!.fakes).toEqual(["api.pay.test"]);
    expect(flow.unknownClaims).toEqual(["R9"]);
    expect(flow.shots).toEqual([{ test: "t", file: "f.png", label: "l" }]);
    expect(flow.status).toBe("failed");
  });

  it("marks unclaimed requirements as not reached when a test broke for another reason", () => {
    const flow = flowResult(plan, [claim("R1", true)], [{ title: "t", status: "timedOut", durationMs: 10, error: "Timeout" }]);
    expect(flow.requirements.map((r) => r.result)).toEqual(["pass", "not-reached", "not-reached", "not-reached"]);
    expect(flow.status).toBe("failed");
  });

  it("needs three identical, fully checked runs to prove a flow", () => {
    const make = (results: string[]): FlowResult => flowResult(plan, results.map((ok, i) => (ok === "covered" ? { type: "not-covered", test: "t", spec: `R${i + 1}`, why: "x" } : claim(`R${i + 1}`, ok === "pass"))), passed);
    const good = make(["pass", "pass", "fail", "covered"]);
    expect(proven([good, good])).toMatchObject({ ok: false, reason: "2 of 3 runs with the current files" });
    expect(proven([good, good, good])).toEqual({ ok: true, unstable: false });
    expect(proven([good, make(["pass", "pass", "pass", "covered"]), good])).toMatchObject({ ok: false, unstable: true });
    const unchecked = make(["pass", "pass", "pass"]);
    expect(proven([unchecked, unchecked, unchecked])).toMatchObject({ ok: false, reason: "no claim checks R4" });
  });

  it("gives a verdict that matches the exit code contract and renders the report", () => {
    const flow = flowResult(plan, [claim("R1", true), claim("R2", false), claim("R3", true), { type: "not-covered", test: "t", spec: "R4", why: "sealed" }], passed);
    const report: RunReport = { id: "20261020-120000", kind: "run", startedAt: "", finishedAt: "", source: { commit: "abcdef1234567890" }, flows: [flow], outside: [{ host: "evil.test", handledAs: "refused", count: 2 }], lookedUpOnly: ["smtp.mail.test"], notes: [] };
    expect(verdict(report)).toBe("fail");
    expect(verdict({ ...report, flows: [{ ...flow, approved: false }] })).toBe("untrusted");
    expect(verdict({ ...report, environmentError: "x" })).toBe("environment");
    expect(verdict({ ...report, flows: [] })).toBe("pass");
    const md = renderMarkdown(report, (path) => `https://x/${path}`);
    expect(md).toContain("| R2 | FAIL | Paid order stored. | did | e | a | none |");
    expect(md).toContain("| R4 | not covered |");
    expect(md).toContain("Refused: evil.test.");
    expect(md).toContain("smtp.mail.test");
  });
});
