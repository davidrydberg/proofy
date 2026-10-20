import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { answer, parseQuery } from "../src/standin/dns.js";
import { Standin } from "../src/standin/handle.js";

function query(name: string, type: number): Buffer {
  const labels = name.split(".").flatMap((label) => [Buffer.from([label.length]), Buffer.from(label)]);
  const header = Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
}

describe("catch-all DNS", () => {
  it("answers every A query with the fake-service address and other types with no records", () => {
    const msg = query("API.Stripe.com", 1);
    const question = parseQuery(msg)!;
    expect(question).toMatchObject({ id: 0x1234, name: "api.stripe.com", type: 1 });
    const reply = answer(msg, question, "10.210.1.53");
    expect(reply.readUInt16BE(6)).toBe(1);
    expect([...reply.subarray(-4)]).toEqual([10, 210, 1, 53]);
    const aaaa = query("api.stripe.com", 28);
    expect(answer(aaaa, parseQuery(aaaa)!, "10.210.1.53").readUInt16BE(6)).toBe(0);
  });

  it("ignores malformed packets", () => {
    expect(parseQuery(Buffer.from([1, 2, 3]))).toBeUndefined();
    expect(parseQuery(Buffer.concat([Buffer.alloc(12), Buffer.from([40, 1, 2])]))).toBeUndefined();
  });
});

describe("fake-service container", () => {
  const dir = mkdtempSync(join(tmpdir(), "proofy-standins-"));
  writeFileSync(
    join(dir, "api.pay.test.mjs"),
    `export default (req, ctx) => {
      if (req.json?.amount > 0) { ctx.state.set("n", (ctx.state.get("n") ?? 0) + 1); return { status: 201, json: { id: "pay_" + ctx.state.get("n") } }; }
      return { status: 400, json: { error: "amount_invalid" } };
    };`,
  );
  writeFileSync(join(dir, "broken.test.mjs"), "export default () => { throw new Error('bug in fake'); };");
  const recorded: string[] = [];
  const standin = new Standin(
    { hosts: { "api.pay.test": "fake", "track.test": "record", "broken.test": "fake" }, assets: {}, standinsDir: dir, assetsDir: dir },
    (request) => recorded.push(`${request.host} ${request.handledAs} ${request.status}`),
  );
  const send = (host: string, body: unknown, headers: Record<string, string> = {}) =>
    standin.handle(host, "POST", "/v1/x?a=1", { "content-type": "application/json", ...headers }, Buffer.from(JSON.stringify(body)));

  it("answers from fakes with state per run, records with 200 and refuses unlisted hosts", async () => {
    expect(await send("api.pay.test", { amount: 5 })).toEqual({ status: 201, json: { id: "pay_1" } });
    expect(await send("api.pay.test", { amount: 7 })).toEqual({ status: 201, json: { id: "pay_2" } });
    expect((await send("api.pay.test", { amount: 0 })).status).toBe(400);
    expect(await send("track.test", {})).toEqual({ status: 200, json: {} });
    expect((await send("evil.test", {})).status).toBe(502);
    expect((await send("broken.test", {})).status).toBe(500);
    expect(recorded).toEqual(["api.pay.test fake 201", "api.pay.test fake 201", "api.pay.test fake 400", "track.test record 200", "evil.test refused 502", "broken.test error 500"]);
  });

  it("records method, path, query and body, and redacts secrets", async () => {
    await send("track.test", { a: 1 }, { authorization: "Bearer sk_live_x", "x-api-key": "k", "x-request-token": "t", accept: "json" });
    const last = standin.recordedFor("track.test").at(-1)!;
    expect(last).toMatchObject({ method: "POST", path: "/v1/x", query: { a: "1" }, body: '{"a":1}' });
    expect(last.headers).toMatchObject({ authorization: "(redacted)", "x-api-key": "(redacted)", "x-request-token": "(redacted)", accept: "json" });
  });

  it("after a reset runs the fakes as they are now, with every file they import, empty state and no earlier requests", () => {
    // In a Node process of its own, as in the container: module hooks and Node's module cache are process-wide.
    const fakes = mkdtempSync(join(tmpdir(), "proofy-reset-"));
    mkdirSync(join(fakes, "lib"));
    writeFileSync(join(fakes, "lib/price.mjs"), "export const price = 1;");
    writeFileSync(join(fakes, "lib/currency.json"), '{ "code": "EUR" }');
    writeFileSync(
      join(fakes, "api.pay.test.mjs"),
      `import { price } from "./lib/price.mjs";
      import currency from "./lib/currency.json" with { type: "json" };
      export default (req, ctx) => { ctx.state.set("n", (ctx.state.get("n") ?? 0) + 1); return { status: 200, json: { price, currency: currency.code, n: ctx.state.get("n") } }; };`,
    );
    const handle = join(mkdtempSync(join(tmpdir(), "proofy-handle-")), "handle.mjs");
    writeFileSync(handle, ts.transpileModule(readFileSync(new URL("../src/standin/handle.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
    const script = `
      import { writeFileSync } from "node:fs";
      import { freshImports, Standin } from ${JSON.stringify(handle)};
      const dir = ${JSON.stringify(fakes)};
      freshImports(dir);
      const standin = new Standin({ hosts: { "api.pay.test": "fake" }, assets: {}, standinsDir: dir, assetsDir: dir });
      const call = async () => (await standin.handle("api.pay.test", "GET", "/", {}, Buffer.alloc(0))).json;
      const seen = [await call()];
      writeFileSync(dir + "/lib/price.mjs", "export const price = 2;");
      writeFileSync(dir + "/lib/currency.json", '{ "code": "SEK" }');
      seen.push(await call(), standin.requests.length);
      standin.reset();
      seen.push(standin.requests.length, await call(), standin.recordedFor("api.pay.test").map((request) => request.seq));
      console.log(JSON.stringify(seen));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual([{ price: 1, currency: "EUR", n: 1 }, { price: 1, currency: "EUR", n: 2 }, 2, 0, { price: 2, currency: "SEK", n: 1 }, [1]]);
  });
});
