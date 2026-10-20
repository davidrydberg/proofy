import type { Config } from "../config.js";
import { checkSeal, type SealInputs } from "./policy.js";
import { ADMIN_PORT, FORWARD, FORWARD_PORTS, MAIL_USER, MAILPIT, MAILPIT_IMAGE, MAILPIT_PORT, MOUNT, RUNNER, STANDIN } from "./contract.js";

export type Mode = "run" | "dev";

export interface ComposeInputs extends SealInputs {
  mode: Mode;
  subnet: string;
  standinIp: string;
  standinImage: string;
  runnerImage: string;
  /** The sandbox's admin secret: the fake-service container's admin token and Mailpit's password. Only the host, the runner and those two know it. */
  token: string;
  /** "uid:gid" of the person running proofy, so files written into mounted folders stay theirs on Linux. */
  user: string;
  dirs: { pkg: string; ca: string; runSetup: string; out: string; e2e: string; work: string; nodeModules: string };
}

export interface Generated {
  compose: Record<string, unknown>;
  notes: string[];
}

type Service = Record<string, unknown>;

/**
 * Rewrites the app's own compose model into a sealed sandbox: one internal network with no way out, every
 * hostname answered by the fake-service container, no published ports, settings only from the proofy config.
 */
export function sandboxCompose(inputs: ComposeInputs): Generated {
  checkSeal(inputs);
  const { model, config, mode, dirs } = inputs;
  const notes: string[] = [];
  const userServices = (model.services ?? {}) as Record<string, Service>;
  const services: Record<string, Service> = {};
  const topVolumes = (model.volumes ?? {}) as Record<string, Record<string, unknown> | null>;
  const files: Record<string, unknown> = {};
  for (const kind of ["secrets", "configs"] as const) {
    if (Object.keys((model[kind] ?? {}) as object).length > 0) files[kind] = model[kind];
  }

  for (const [name, original] of Object.entries(userServices)) {
    const service: Service = { ...original };
    if (service.env_file !== undefined) {
      notes.push(`${name}: env_file ignored, settings come only from e2e/proofy.json env`);
      delete service.env_file;
    }
    delete service.ports;
    delete service.container_name;
    service.networks = { proofy: { aliases: aliasesOf(original.networks) } };
    service.dns = [inputs.standinIp];
    // Compose interpolates the file it starts, so a $ in a config value stays literal only as $$. Values from the app's
    // own compose files are already escaped that way by docker compose config.
    const settings = Object.fromEntries(Object.entries(config.env[name] ?? {}).map(([key, value]) => [key, literal(value)]));
    service.environment = { ...((original.environment ?? {}) as Record<string, string | null>), ...settings };
    service.volumes = [...((original.volumes ?? []) as unknown[]), bind(dirs.ca, MOUNT.appCa, true)];
    service.depends_on = { ...((original.depends_on ?? {}) as Record<string, unknown>), [STANDIN]: { condition: "service_healthy", required: true } };
    services[name] = service;
  }

  services[STANDIN] = {
    image: inputs.standinImage,
    user: inputs.user,
    command: ["node", `${MOUNT.pkg}/dist/standin/server.js`],
    volumes: [
      bind(dirs.pkg, MOUNT.pkg, true),
      bind(dirs.ca, MOUNT.ca, false),
      bind(dirs.runSetup, MOUNT.runSetup, true),
      bind(dirs.out, MOUNT.out, false),
      bind(dirs.e2e, MOUNT.e2e, true),
    ],
    networks: { proofy: { ipv4_address: inputs.standinIp } },
    healthcheck: { test: ["CMD", "wget", "-q", "-O", "-", `http://127.0.0.1:${ADMIN_PORT}/health`], interval: "1s", timeout: "2s", retries: 60 },
  };
  // The app sends mail over SMTP without a login; reading or deleting it through the API needs the token.
  services[MAILPIT] = {
    image: MAILPIT_IMAGE,
    networks: { proofy: {} },
    environment: { MP_SMTP_AUTH_ACCEPT_ANY: "1", MP_SMTP_AUTH_ALLOW_INSECURE: "1", MP_UI_AUTH: `${MAIL_USER}:${inputs.token}` },
  };
  services[RUNNER] = {
    image: inputs.runnerImage,
    user: inputs.user,
    profiles: [RUNNER],
    working_dir: MOUNT.work,
    shm_size: "1gb",
    dns: [inputs.standinIp],
    networks: { proofy: {} },
    environment: { CI: "1", HOME: "/tmp", PROOFY_BASE_URL: literal(baseUrl(config)), PROOFY_START_MS: String(config.limits.startMinutes * 60_000), PROOFY_TOKEN: inputs.token },
    volumes: [
      bind(dirs.work, MOUNT.work, false),
      bind(dirs.pkg, MOUNT.pkg, true),
      bind(dirs.nodeModules, "/node_modules", true),
      bind(dirs.e2e, MOUNT.e2e, true),
      bind(dirs.out, MOUNT.out, false),
    ],
  };

  const networks: Record<string, unknown> = { proofy: { internal: true, ipam: { config: [{ subnet: inputs.subnet }] } } };
  if (mode === "dev" && config.app) {
    // The only container with a second network: it forwards host ports in and gives nothing a way out.
    services[FORWARD] = {
      image: inputs.standinImage,
      user: inputs.user,
      command: ["node", `${MOUNT.pkg}/dist/standin/forward.js`, `${FORWARD_PORTS.app}=${config.app.service}:${config.app.port}`, `${FORWARD_PORTS.mail}=${MAILPIT}:${MAILPIT_PORT}`],
      volumes: [bind(dirs.pkg, MOUNT.pkg, true)],
      networks: { proofy: {}, "proofy-host": {} },
      ports: [`127.0.0.1::${FORWARD_PORTS.app}`, `127.0.0.1::${FORWARD_PORTS.mail}`],
    };
    networks["proofy-host"] = {};
  }

  const compose: Record<string, unknown> = { services, networks, ...files };
  // Without a fixed name, compose names each volume after the sandbox, so none is shared with another project.
  if (model.volumes) compose.volumes = Object.fromEntries(Object.entries(topVolumes).map(([name, volume]) => [name, volume && Object.fromEntries(Object.entries(volume).filter(([key]) => key !== "name"))]));
  return { compose, notes };
}

export function baseUrl(config: Config): string {
  return config.app ? `http://${config.app.service}:${config.app.port}${config.app.path}` : "";
}

export interface UnsetUse {
  name: string;
  /** Where the compose model uses it, such as services.web.environment.KEY. */
  path: string[];
}

// Service settings proofy drops, so a variable used only there needs no value.
const DROPPED = new Set(["ports", "container_name", "env_file"]);
/** The proxy variables docker keeps from the machine. An image build may take them as build args, since it has internet anyway. */
export const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"].flatMap((name) => [name, name.toLowerCase()]);
// A variable use: ${NAME}, ${NAME:-default} and the other braced forms, or $NAME.
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)([}:?+-])|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Variables with no fixed value in the sandbox that actually reach the app. Skips settings proofy drops or overrides
 * and anything the app doesn't use. `raw` is the model before interpolation, `model` after, `unset` what compose left
 * blank (one found nowhere comes back with an empty path). `machine` marks docker's own variables (PATH, DOCKER_*,
 * proxies): those count even with a default, except proxies in build args.
 */
export function unsetUses(raw: Record<string, unknown>, model: Record<string, unknown>, config: Config, unset: string[], machine: (name: string) => boolean = () => false): UnsetUse[] {
  const found = new Map<string, UnsetUse[]>(unset.map((name) => [name, []]));
  const visit = (value: unknown, path: string[]) => {
    if (typeof value === "string") {
      // $$ is a literal dollar sign, never a variable.
      const text = value.replace(/\$\$/g, "");
      const names = new Set<string>();
      for (const [, braced, after, bare] of text.matchAll(VARIABLE)) {
        const name = braced ?? bare ?? "";
        // Compose leaves a variable blank only where it has no default; a machine variable counts in every form.
        if (machine(name) || (unset.includes(name) && (bare !== undefined || after === "}"))) names.add(name);
      }
      for (const name of names) found.set(name, [...(found.get(name) ?? []), { name, path: settingPath(path, value) }]);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    }
  };
  visit(raw, []);
  const reaches = ({ name, path }: UnsetUse) => {
    const [section = "", entry = "", setting = "", key = ""] = path;
    if (!["services", "volumes", "secrets", "configs"].includes(section)) return false;
    if ((model[section] as Record<string, unknown> | undefined)?.[entry] === undefined) return false;
    if (section !== "services") return true;
    if (DROPPED.has(setting)) return false;
    if (setting === "build" && key === "args" && PROXY_VARIABLES.includes(name)) return false;
    return !(setting === "environment" && config.env[entry]?.[key] !== undefined);
  };
  return [...found].flatMap(([name, uses]) => (uses.length === 0 ? [{ name, path: [] }] : uses.filter(reaches)));
}

// An environment entry in list form, "KEY=value", is named by its key like the map form.
function settingPath(path: string[], value: string): string[] {
  if (path[0] === "services" && path[2] === "environment" && path.length === 4 && /^\d+$/.test(path[3] ?? "")) {
    return [...path.slice(0, 3), value.split("=")[0] ?? ""];
  }
  return path;
}

/** A /24 per project, away from the ranges Docker and home networks usually take. */
export function subnetFor(seed: string, attempt: number): { subnet: string; standinIp: string } {
  let hash = 0;
  for (const char of `${seed}:${attempt}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const second = 200 + (hash % 50);
  const third = (hash >>> 8) % 256;
  return { subnet: `10.${second}.${third}.0/24`, standinIp: `10.${second}.${third}.53` };
}


function aliasesOf(networks: unknown): string[] {
  if (!networks || typeof networks !== "object" || Array.isArray(networks)) return [];
  const aliases = new Set<string>();
  for (const value of Object.values(networks as Record<string, unknown>)) {
    if (value && typeof value === "object" && Array.isArray((value as { aliases?: unknown }).aliases)) {
      for (const alias of (value as { aliases: unknown[] }).aliases) if (typeof alias === "string") aliases.add(alias);
    }
  }
  return [...aliases];
}

function bind(source: string, target: string, readOnly: boolean): Record<string, unknown> {
  return { type: "bind", source: literal(source), target, read_only: readOnly };
}

function literal(value: string): string {
  return value.replace(/\$/g, () => "$$");
}
