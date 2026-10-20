import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { parse } from "yaml";

export const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const ENV_EXAMPLES = [".env.example", ".env.sample", ".env.dist", ".env.template", ".env.local.example"];

const INFRA = /(^|\/)(mysql|mariadb|postgres|postgis|redis|valkey|memcached|mongo|mailpit|mailhog|elasticsearch|opensearch|rabbitmq|minio|adminer|phpmyadmin|nginx-proxy|traefik)(:|$)/;
const SECRET = /(KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE|CREDENTIAL|DSN)/i;

export interface Frontend {
  service: string;
  port: number;
}

export interface ComposeGuess {
  file: string;
  services: string[];
  /** The first of `frontends`: where the browser starts. */
  app?: Frontend;
  /** Every service with a port that is not a database, cache or mail catcher, those built from the repository first. */
  frontends: Frontend[];
  /** The service publishing each host port, such as 8000 for `8000:80`. */
  published: Record<number, string>;
  /** Build context per service built from the repository, relative to it. */
  contexts: Record<string, string>;
  /** Services that mount the source from the host: set up for development, with dependencies installed when they start. */
  sourceMounts: Array<{ service: string; source: string; target: string }>;
}

export interface EnvGuess {
  file: string;
  values: Record<string, string>;
  replaced: number;
  /** Settings whose example value is a URL, secret-looking ones left out. */
  urls: Array<{ key: string; url: URL }>;
}

export async function detectCompose(root: string): Promise<ComposeGuess | undefined> {
  for (const file of COMPOSE_NAMES) {
    let raw: string;
    try {
      raw = await readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    let doc: unknown;
    try {
      doc = parse(raw);
    } catch {
      return { file, services: [], frontends: [], published: {}, contexts: {}, sourceMounts: [] };
    }
    const services = isRecord(doc) && isRecord(doc.services) ? doc.services : {};
    const frontends = guessFrontends(services);
    const published: Record<number, string> = {};
    const contexts: Record<string, string> = {};
    const sourceMounts: ComposeGuess["sourceMounts"] = [];
    for (const [service, definition] of Object.entries(services)) {
      if (!isRecord(definition)) continue;
      for (const port of publishedPorts(definition.ports)) published[port] ??= service;
      const context = buildContext(definition.build);
      if (context !== undefined) contexts[service] = context;
      sourceMounts.push(...repoMounts(definition.volumes, context).map((mount) => ({ service, ...mount })));
    }
    return { file, services: Object.keys(services), ...(frontends[0] ? { app: frontends[0] } : {}), frontends, published, contexts, sourceMounts };
  }
  return undefined;
}

/** Reads an example env file, such as .env.example, in `dir` so the sandbox gets the same setting names; secret-looking values become obvious fakes. */
export async function detectEnv(root: string, dir = "."): Promise<EnvGuess | undefined> {
  let file = "";
  let raw: string | undefined;
  for (const name of ENV_EXAMPLES) {
    file = normalize(join(dir, name));
    raw = await readFile(join(root, file), "utf8").catch(() => undefined);
    if (raw !== undefined) break;
  }
  if (raw === undefined) return undefined;
  const values: Record<string, string> = {};
  const urls: EnvGuess["urls"] = [];
  let replaced = 0;
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key = "", rawValue = ""] = match;
    if (SECRET.test(key)) {
      values[key] = `proofy-fake-${key.toLowerCase().replace(/_/g, "-")}`;
      replaced++;
    } else {
      values[key] = unquote(rawValue.replace(/\s+#.*$/, "").trim());
      const url = URL.canParse(values[key]) ? new URL(values[key]) : undefined;
      if (url && /^https?:$/.test(url.protocol)) urls.push({ key, url });
    }
  }
  return { file, values, replaced, urls };
}

function guessFrontends(services: Record<string, unknown>): Frontend[] {
  const candidates: Array<{ service: string; port: number; built: boolean }> = [];
  for (const [service, definition] of Object.entries(services)) {
    if (!isRecord(definition)) continue;
    const image = typeof definition.image === "string" ? definition.image : "";
    if (INFRA.test(image) || INFRA.test(service)) continue;
    const port = firstPort(definition.ports) ?? firstPort(definition.expose);
    if (port !== undefined) candidates.push({ service, port, built: definition.build !== undefined });
  }
  // A service built from the repository is the app more often than an image pulled from elsewhere.
  return [...candidates.filter((c) => c.built), ...candidates.filter((c) => !c.built)].map(({ service, port }) => ({ service, port }));
}

function buildContext(build: unknown): string | undefined {
  if (typeof build === "string") return normalize(build);
  if (isRecord(build)) return typeof build.context === "string" ? normalize(build.context) : ".";
  return undefined;
}

/** Bind mounts of the repository, such as `.:/app`, or of the service's own build context. */
function repoMounts(volumes: unknown, context: string | undefined): Array<{ source: string; target: string }> {
  if (!Array.isArray(volumes)) return [];
  const out: Array<{ source: string; target: string }> = [];
  for (const entry of volumes) {
    const [source, target] = typeof entry === "string" ? entry.split(":") : isRecord(entry) ? [entry.source, entry.target] : [];
    if (typeof source === "string" && typeof target === "string" && (normalize(source) === "." || normalize(source) === context)) {
      out.push({ source, target });
    }
  }
  return out;
}

/** Host ports: `8000:80` and `127.0.0.1:8000:80` publish 8000, a bare `8080` publishes 8080. */
function publishedPorts(ports: unknown): number[] {
  if (!Array.isArray(ports)) return [];
  const out: number[] = [];
  for (const entry of ports) {
    const host = isRecord(entry) ? entry.published : typeof entry === "string" ? (entry.split("/")[0] ?? "").split(":").at(-2) ?? entry.split("/")[0] : entry;
    const port = Number(String(host ?? "").split("-")[0]);
    if (Number.isInteger(port) && port > 0) out.push(port);
  }
  return out;
}

// The browser reaches the app inside the sandbox network, so the container side of a mapping is what counts.
function firstPort(ports: unknown): number | undefined {
  if (!Array.isArray(ports)) return undefined;
  for (const entry of ports) {
    if (isRecord(entry) && typeof entry.target === "number") return entry.target;
    if (typeof entry === "number") return entry;
    if (typeof entry === "string") {
      const container = entry.split("/")[0]?.split(":").at(-1) ?? "";
      const port = Number(container.split("-")[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
  }
  return undefined;
}

function unquote(value: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted ? (quoted[2] ?? "") : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
