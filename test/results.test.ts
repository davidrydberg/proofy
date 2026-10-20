import { describe, expect, it } from "vitest";
import { runResult } from "../src/commands/run.js";
import { proven } from "../src/run/history.js";
import { renderMarkdown, verdict } from "../src/run/report.js";
import { flowResult, type FlowResult, type PlannedFlow, type RunReport } from "../src/run/results.js";
import { parseRequirements } from "../src/run/spec.js";
import { sameJson, showValue } from "../src/test/compare.js";
import type { Entry } from "../src/sandbox/contract.js";

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

  it("fails a flow when a requirement ends with no claim, even when every test passed", () => {
    const flow = flowResult(plan, [claim("R1", true), claim("R2", true), { type: "not-covered", test: "t", spec: "R4", why: "sealed" }], passed);
    expect(flow.requirements.map((r) => r.result)).toEqual(["pass", "pass", "not-checked", "not-covered"]);
    expect(flow.status).toBe("failed");
    const report: RunReport = { id: "x", kind: "run", startedAt: "", finishedAt: "", source: {}, flows: [flow], outside: [], lookedUpOnly: [], notes: [] };
    expect(verdict(report)).toBe("fail");
    const md = renderMarkdown(report, (path) => path);
    expect(md).toContain("FAIL: an approved flow has a requirement that did not hold or that no claim checked");
    expect(md).toContain("| R3 | FAIL (no claim checked it) |");
    const result = runResult(report, "/repo/e2e/out/x", "/repo");
    expect(result.exitCode).toBe(1);
    expect(result.data.failed).toEqual([{ flow: "checkout", req: "R3", expected: "", actual: "not-checked" }]);
    expect(result.pretty?.({ color: false, width: 120 })).toContain("\u2717 R3   Email sent.  (no claim checked it in this run)");
    expect(flowResult(plan, [claim("R1", true), claim("R2", true), claim("R3", true), { type: "not-covered", test: "t", spec: "R4", why: "sealed" }], passed).status).toBe("passed");
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

  it("decides a claim without ok by comparing expected and actual, again on the host", () => {
    const compared = (spec: string, expected: unknown, actual: unknown, ok: boolean): Entry => ({ type: "claim", test: "t", spec, did: "did", expected, actual, ok, compared: true, fakes: [] });
    const flow = flowResult(
      plan,
      [
        compared("R1", { status: "paid", total: 120, items: [{ sku: "A" }] }, { items: [{ sku: "A" }], total: 120, status: "paid" }, true),
        // The recorded ok says pass, but the values differ: the host's comparison wins.
        compared("R2", 3, "3", true),
        compared("R3", "processing", "processing ", false),
        claim("R4", true, { expected: "a pattern", actual: { n: 1 } }),
      ],
      [{ title: "t", status: "failed", durationMs: 10, error: "Requirements not met: R3" }],
    );
    expect(flow.requirements.map((r) => `${r.id}:${r.result}:${r.decidedBy}`)).toEqual(["R1:pass:proofy", "R2:fail:proofy", "R3:fail:proofy", "R4:pass:test"]);
    expect(flow.requirements[1]).toMatchObject({ expected: "3", actual: '"3"' });
    expect(flow.requirements[2]).toMatchObject({ expected: '"processing"', actual: '"processing "' });
    expect(flow.requirements[3]).toMatchObject({ expected: "a pattern", actual: '{"n":1}' });
    const md = renderMarkdown({ id: "x", kind: "run", startedAt: "", finishedAt: "", source: {}, flows: [flow], outside: [], lookedUpOnly: [], notes: [] }, (path) => path);
    expect(md).toContain('| R1 | pass, proofy compared | Order number shown. | did | {"status":"paid","total":120,"items":[{"sku":"A"}]} |');
    expect(md).toContain("| R4 | pass, test decided |");
  });

  it("compares claim values as JSON", () => {
    expect(sameJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameJson({ a: undefined }, {})).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson(1, "1")).toBe(false);
    expect(sameJson(null, undefined)).toBe(false);
    expect(showValue(undefined, true)).toBe("undefined");
    expect(showValue("words", false)).toBe("words");
  });

  it("gives a verdict that matches the exit code contract and renders the report", () => {
    const flow = flowResult(plan, [claim("R1", true), claim("R2", false), claim("R3", true), { type: "not-covered", test: "t", spec: "R4", why: "sealed" }], passed);
    const report: RunReport = { id: "20261020-120000", kind: "run", startedAt: "", finishedAt: "", source: { commit: "abcdef1234567890" }, flows: [flow], outside: [{ host: "evil.test", handledAs: "refused", count: 2 }], lookedUpOnly: ["smtp.mail.test"], notes: [] };
    expect(verdict(report)).toBe("fail");
    expect(verdict({ ...report, flows: [{ ...flow, approved: false }] })).toBe("untrusted");
    expect(verdict({ ...report, environmentError: "x" })).toBe("environment");
    expect(verdict({ ...report, flows: [] })).toBe("pass");
    const md = renderMarkdown(report, (path) => `https://x/${path}`);
    expect(md).toContain("| R2 | FAIL, test decided | Paid order stored. | did | e | a | none |");
    expect(md).toContain("test decided: the test passed its own result");
    expect(md).toContain("| R4 | not covered |");
    expect(md).toContain("Refused: evil.test.");
    expect(md).toContain("smtp.mail.test");
    expect(md).not.toContain("<summary>Images</summary>");
    const withImages = renderMarkdown({ ...report, images: [{ service: "web", image: "shop", id: "sha256:aaa" }, { service: "db", image: "mariadb:11", id: "sha256:bbb", digest: "mariadb@sha256:ccc" }] }, (path) => path);
    expect(withImages).toContain("| web | shop | sha256:aaa | none |");
    expect(withImages).toContain("| db | mariadb:11 | sha256:bbb | mariadb@sha256:ccc |");
  });
});
