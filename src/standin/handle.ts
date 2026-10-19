import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type HostMode = "fake" | "record";

export interface StandinRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  json: unknown;
}

export interface StandinResponse {
  status: number;
  json?: unknown;
  body?: string | Buffer;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  seq: number;
  at: string;
  host: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  handledAs: HostMode | "asset" | "refused" | "error";
  status: number;
  error?: string;
}

export interface StandinSetup {
  hosts: Record<string, HostMode>;
  /** "host/path" to a file downloaded during the install phase. */
  assets: Record<string, string>;
  standinsDir: string;
  assetsDir: string;
}

type Handler = (req: StandinRequest, ctx: { state: Map<string, unknown> }) => StandinResponse | Promise<StandinResponse>;

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$|secret|token|signature/i;
const MAX_BODY = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
};

export class Standin {
  readonly requests: RecordedRequest[] = [];
  private readonly handlers = new Map<string, Promise<Handler>>();
  private readonly states = new Map<string, Map<string, unknown>>();

  constructor(
    private readonly setup: StandinSetup,
    private readonly onRecord: (request: RecordedRequest) => void = () => {},
  ) {}

  async handle(host: string, method: string, url: string, headers: Record<string, string>, body: Buffer): Promise<StandinResponse> {
    const parsed = new URL(url, `http://${host}`);
    const path = parsed.pathname;
    const query = Object.fromEntries(parsed.searchParams);
    const text = body.toString("utf8");
    const record: Omit<RecordedRequest, "handledAs" | "status"> = {
      seq: this.requests.length + 1,
      at: new Date().toISOString(),
      host,
      method,
      path,
      query,
      headers: redact(headers),
      body: text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}... (${text.length} characters)` : text,
    };
    let response: StandinResponse;
    let handledAs: RecordedRequest["handledAs"];
    let error: string | undefined;
    const asset = this.setup.assets[`${host}${path}`];
    const mode = this.setup.hosts[host];
    try {
      if (asset !== undefined) {
        handledAs = "asset";
        response = { status: 200, body: await readFile(join(this.setup.assetsDir, asset)), headers: { "content-type": contentType(path) } };
      } else if (mode === "record") {
        handledAs = "record";
        response = { status: 200, json: {} };
      } else if (mode === "fake") {
        handledAs = "fake";
        const handler = await this.handler(host);
        response = await handler({ method, path, query, headers, body: text, json: parseJson(text) }, { state: this.state(host) });
        if (!response || typeof response.status !== "number") throw new Error(`the fake for ${host} returned no status`);
      } else {
        handledAs = "refused";
        response = refusal(host);
      }
    } catch (caught) {
      handledAs = "error";
      error = caught instanceof Error ? caught.message : String(caught);
      response = { status: 500, json: { error: { code: "proofy_fake_error", message: error } } };
    }
    const done: RecordedRequest = { ...record, handledAs, status: response.status, ...(error ? { error } : {}) };
    this.requests.push(done);
    this.onRecord(done);
    return response;
  }

  /** Recorded requests for one host, or all of them. */
  recordedFor(host: string | undefined): RecordedRequest[] {
    return host ? this.requests.filter((request) => request.host === host) : this.requests;
  }

  private handler(host: string): Promise<Handler> {
    let handler = this.handlers.get(host);
    if (!handler) {
      const file = join(this.setup.standinsDir, `${host}.mjs`);
      handler = import(pathToFileURL(file).href).then((module: { default?: unknown }) => {
        if (typeof module.default !== "function") throw new Error(`e2e/standins/${host}.mjs has no default export function`);
        return module.default as Handler;
      });
      this.handlers.set(host, handler);
    }
    return handler;
  }

  private state(host: string): Map<string, unknown> {
    let state = this.states.get(host);
    if (!state) {
      state = new Map();
      this.states.set(host, state);
    }
    return state;
  }
}

export function refusal(host: string): StandinResponse {
  return {
    status: 502,
    json: { error: { code: "proofy_refused", message: `${host} is not allowed in the sealed sandbox. List it in e2e/proofy.json hosts as fake or record` } },
  };
}

function redact(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, SECRET_HEADER.test(key) ? "(redacted)" : value]));
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}
