import { appendFileSync, readFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { createSecureContext } from "node:tls";
import { ADMIN_PORT, MOUNT } from "../sandbox/contract.js";
import { ensureCa, leafFor } from "./ca.js";
import { startDns } from "./dns.js";
import { adminResponse, freshImports, Standin, type StandinResponse, type StandinSetup } from "./handle.js";

// The fake-service container's entry point. Paths are the container's mounts, set up by the sandbox compose file.
const SETUP_FILE = `${MOUNT.runSetup}/standin.json`;
const CA_DIR = MOUNT.ca;
const OUT = MOUNT.out;

interface Setup extends StandinSetup {
  address: string;
  token: string;
  dev: boolean;
}

const command = process.argv[2];
if (command === "ca") {
  ensureCa(CA_DIR);
} else {
  serve();
}

function serve(): void {
  const setup = JSON.parse(readFileSync(SETUP_FILE, "utf8")) as Setup;
  ensureCa(CA_DIR);
  freshImports(setup.standinsDir);
  const standin = new Standin(setup, (request) => appendFileSync(`${OUT}/requests.jsonl`, `${JSON.stringify(request)}\n`));
  const seen = new Set<string>();
  startDns(setup.address, (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    appendFileSync(`${OUT}/dns.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), name })}\n`);
  });

  const listener = (secure: boolean) => async (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const body = await readBody(req);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : (value ?? "")]));
    send(res, await standin.handle(host, req.method ?? "GET", req.url ?? "/", { ...headers, "x-proofy-scheme": secure ? "https" : "http" }, body));
  };

  createHttp(listener(false)).listen(80);
  const contexts = new Map<string, ReturnType<typeof createSecureContext>>();
  createHttps(
    {
      ...leafFor(CA_DIR, "localhost"),
      SNICallback: (servername, done) => {
        try {
          let context = contexts.get(servername);
          if (!context) {
            context = createSecureContext(leafFor(CA_DIR, servername));
            contexts.set(servername, context);
          }
          done(null, context);
        } catch (error) {
          done(error as Error);
        }
      },
    },
    listener(true),
  ).listen(443);

  const admin = {
    token: setup.token,
    dev: setup.dev,
    requests: (host: string | undefined) => standin.recordedFor(host),
    // Called by the host before each dev test. Names looked up before it count again, so each test lists its own.
    reset: () => {
      standin.reset();
      seen.clear();
    },
  };
  createHttp((req, res) => send(res, adminResponse(admin, req.method ?? "GET", req.url ?? "/", req.headers.authorization))).listen(ADMIN_PORT);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, response: StandinResponse): void {
  const headers: Record<string, string> = { ...(response.headers ?? {}) };
  let body: string | Buffer = "";
  if (response.json !== undefined) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(response.json);
  } else if (response.body !== undefined) {
    body = response.body;
  }
  res.writeHead(response.status, headers);
  res.end(body);
}
