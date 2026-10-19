import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test as base, type Page, type TestInfo } from "@playwright/test";
import { MAILPIT_API, MOUNT, STANDIN_ADMIN } from "../sandbox/contract.js";

export { expect } from "@playwright/test";

/** One line of e2e/out/<run>/flows/<flow>/claims.jsonl, read by the host to build the report. */
export type Entry =
  | { type: "claim"; test: string; spec: string; did: string; expected: string; actual: string; ok: boolean; evidence?: unknown; fakes: string[] }
  | { type: "not-covered"; test: string; spec: string; why: string }
  | { type: "shot"; test: string; file: string; label: string };

export interface Claim {
  /** The requirement number from the spec, such as "R2". */
  spec: string;
  /** What the test did to check it. */
  did: string;
  /** What should be true, in words. */
  expected: string;
  /** What was actually found, as read from the app, a fake or Mailpit. */
  actual: unknown;
  /** Whether the requirement held. Decide it from real values, never from text on the screen alone. */
  ok: boolean;
  /** Raw data behind the claim: a stored record, a request body. Shown in the report. */
  evidence?: unknown;
  /** Fakes this claim's evidence depends on. Hosts read with standin.requests() are added automatically. */
  fakes?: string[];
}

export interface Mail {
  id: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  text: string;
  html: string;
}

export interface RecordedRequest {
  host: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  handledAs: string;
  status: number;
}

interface Current {
  flow: string;
  title: string;
  page: Page;
  tag: string;
  shots: number;
  failed: string[];
  fakes: Set<string>;
}

let current: Current | undefined;

export const test = base.extend<{ proofy: void }>({
  proofy: [
    async ({ page }, use, testInfo: TestInfo) => {
      current = {
        flow: basename(testInfo.file).replace(/\.spec\.[cm]?[jt]s$/, ""),
        title: testInfo.title,
        page,
        tag: Math.random().toString(36).slice(2, 8),
        shots: 0,
        failed: [],
        fakes: new Set(),
      };
      const mine = current;
      await use();
      current = undefined;
      if (mine.failed.length > 0) {
        throw new Error(`Requirements not met: ${mine.failed.join(", ")}. See the report for expected and actual values`);
      }
    },
    { auto: true },
  ],
});

/** Records one requirement's result. A failed claim fails the test at its end, after every claim is recorded. */
export function claim(input: Claim): void {
  const state = active("claim");
  const fakes = [...new Set([...(input.fakes ?? []), ...state.fakes])].sort();
  write(state, {
    type: "claim",
    test: state.title,
    spec: input.spec,
    did: input.did,
    expected: input.expected,
    actual: typeof input.actual === "string" ? input.actual : JSON.stringify(input.actual),
    ok: input.ok,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    fakes,
  });
  if (!input.ok) state.failed.push(input.spec);
}

/** Marks a requirement the sandbox cannot show, with the reason. It appears in the report, never as a pass. */
export function notCovered(spec: string, why: string): void {
  const state = active("notCovered");
  write(state, { type: "not-covered", test: state.title, spec, why });
}

/** A numbered full-page screenshot for the report: shot('basket with one coffee'). */
export async function shot(label: string): Promise<void> {
  const state = active("shot");
  state.shots++;
  const file = `${slug(state.title)}-${String(state.shots).padStart(2, "0")}-${slug(label)}.png`;
  await state.page.screenshot({ path: join(flowDir(state), file), fullPage: true });
  write(state, { type: "shot", test: state.title, file, label });
}

/** A value unique to this test, the same on every call: use it in names, emails and phone numbers. */
export function tag(): string {
  return active("tag").tag;
}

/** Runs a command named in e2e/proofy.json exec, in its service, with extra arguments. Returns stdout. */
export async function exec(name: string, args: string[] = []): Promise<string> {
  active("exec");
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(MOUNT.exec, { recursive: true });
  writeFileSync(join(MOUNT.exec, `${id}.req.json`), JSON.stringify({ name, args }));
  const response = join(MOUNT.exec, `${id}.res.json`);
  const deadline = Date.now() + 120_000;
  while (!existsSync(response)) {
    if (Date.now() > deadline) throw new Error(`exec("${name}") got no answer within 2 minutes`);
    await sleep(100);
  }
  const result = JSON.parse(readFileSync(response, "utf8")) as { code: number; stdout: string; stderr: string; error?: string };
  rmSync(response, { force: true });
  if (result.error) throw new Error(result.error);
  if (result.code !== 0) throw new Error(`exec("${name}") exited with ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}

export interface MailOptions {
  /** Wait until at least this many messages arrived. Default 1; 0 reads without waiting. */
  atLeast?: number;
  /** Give up waiting after this long. Default 15 seconds. */
  timeoutMs?: number;
  /** After that, keep reading until nothing new arrived for this long, to catch a late extra message. Default 0. */
  settleMs?: number;
}

export const mail = {
  /**
   * Mail delivered to one address, oldest first. Waits until at least `atLeast` messages arrived or the time ran out.
   * Use atLeast: 0 to read without waiting, for example to check that nothing was sent.
   */
  for(address: string, options: MailOptions = {}): Promise<Mail[]> {
    active("mail.for");
    return searchMail(`to:"${address}"`, options);
  },
  /**
   * Mail matching a Mailpit search, oldest first, such as an order number or `subject:"Your order"`.
   * Every test shares the mailbox, so search for something only this test's data contains.
   */
  search(query: string, options: MailOptions = {}): Promise<Mail[]> {
    active("mail.search");
    return searchMail(query, options);
  },
};

async function searchMail(query: string, options: MailOptions): Promise<Mail[]> {
  const atLeast = options.atLeast ?? 1;
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const ids = async () => {
    const search = (await getJson(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(query)}`)) as { messages?: Array<{ ID: string }> };
    return (search.messages ?? []).map((message) => message.ID);
  };
  let found = await ids();
  while (found.length < atLeast && Date.now() < deadline) {
    await sleep(500);
    found = await ids();
  }
  if (options.settleMs) {
    let stableSince = Date.now();
    while (Date.now() - stableSince < options.settleMs) {
      await sleep(Math.min(500, options.settleMs));
      const again = await ids();
      if (again.length !== found.length) {
        found = again;
        stableSince = Date.now();
      }
    }
  }
  const messages = await Promise.all(found.map((id) => getJson(`${MAILPIT_API}/api/v1/message/${id}`)));
  return messages.map(toMail).reverse();
}

export const standin = {
  /**
   * Requests the app sent to an outside host, oldest first, waiting until at least `atLeast` arrived.
   * Reading a host marks the test's later claims as depending on its fake.
   */
  async requests(host: string, options: { atLeast?: number; timeoutMs?: number } = {}): Promise<RecordedRequest[]> {
    const state = active("standin.requests");
    state.fakes.add(host);
    const atLeast = options.atLeast ?? 0;
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    for (;;) {
      const requests = (await getJson(`${STANDIN_ADMIN}/requests?host=${encodeURIComponent(host)}`)) as RecordedRequest[];
      if (requests.length >= atLeast || Date.now() > deadline) return requests;
      await sleep(250);
    }
  },
};

function active(name: string): Current {
  if (!current) throw new Error(`${name}() must be called inside a test that imports test from "@davidrydberg/proofy/test"`);
  return current;
}

function flowDir(state: Current): string {
  const dir = join(MOUNT.out, "flows", state.flow);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(state: Current, entry: Entry): void {
  appendFileSync(join(flowDir(state), "claims.jsonl"), `${JSON.stringify(entry)}\n`);
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

function toMail(raw: unknown): Mail {
  type Address = { Address: string };
  const message = raw as { ID: string; Subject: string; From?: Address; To?: Address[]; Cc?: Address[]; Bcc?: Address[]; Text: string; HTML: string };
  return {
    id: message.ID,
    subject: message.Subject,
    from: message.From?.Address ?? "",
    to: (message.To ?? []).map((to) => to.Address),
    cc: (message.Cc ?? []).map((cc) => cc.Address),
    bcc: (message.Bcc ?? []).map((bcc) => bcc.Address),
    text: message.Text,
    html: message.HTML,
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "step";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
