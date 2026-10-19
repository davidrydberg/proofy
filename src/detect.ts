import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

const INFRA = /(^|\/)(mysql|mariadb|postgres|postgis|redis|valkey|memcached|mongo|mailpit|mailhog|elasticsearch|opensearch|rabbitmq|minio|adminer|phpmyadmin|nginx-proxy|traefik)(:|$)/;
const SECRET = /(KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE|CREDENTIAL|DSN)/i;

export interface ComposeGuess {
  file: string;
  services: string[];
  app?: { service: string; port: number };
}

export interface EnvGuess {
  file: string;
  values: Record<string, string>;
  replaced: number;
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
      return { file, services: [] };
    }
    const services = isRecord(doc) && isRecord(doc.services) ? doc.services : {};
    const app = guessApp(services);
    return { file, services: Object.keys(services), ...(app ? { app } : {}) };
  }
  return undefined;
}

/** Reads .env.example so the sandbox gets the same setting names; secret-looking values become obvious fakes. */
export async function detectEnv(root: string): Promise<EnvGuess | undefined> {
  const file = ".env.example";
  let raw: string;
  try {
    raw = await readFile(join(root, file), "utf8");
  } catch {
    return undefined;
  }
  const values: Record<string, string> = {};
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
    }
  }
  return { file, values, replaced };
}

function guessApp(services: Record<string, unknown>): { service: string; port: number } | undefined {
  const candidates: Array<{ service: string; port: number; built: boolean }> = [];
  for (const [service, definition] of Object.entries(services)) {
    if (!isRecord(definition)) continue;
    const image = typeof definition.image === "string" ? definition.image : "";
    if (INFRA.test(image) || INFRA.test(service)) continue;
    const port = firstPort(definition.ports) ?? firstPort(definition.expose);
    if (port !== undefined) candidates.push({ service, port, built: definition.build !== undefined });
  }
  // A service built from the repository is the app more often than an image pulled from elsewhere.
  const pick = candidates.find((c) => c.built) ?? candidates[0];
  return pick ? { service: pick.service, port: pick.port } : undefined;
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
