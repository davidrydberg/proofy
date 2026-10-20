import type { Config } from "../config.js";
import { CliError } from "../errors.js";
import { FORWARD, MAILPIT, MAILPIT_IMAGE, MOUNT, RUNNER, STANDIN } from "./contract.js";

export type Mode = "run" | "dev";

export interface ComposeInputs {
  /** The app's compose files, normalized by `docker compose config --format json`. */
  model: Record<string, unknown>;
  config: Config;
  mode: Mode;
  subnet: string;
  standinIp: string;
  standinImage: string;
  runnerImage: string;
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
  const { model, config, mode, dirs } = inputs;
  const notes: string[] = [];
  const userServices = (model.services ?? {}) as Record<string, Service>;
  const services: Record<string, Service> = {};

  for (const name of Object.keys(config.env)) {
    if (!(name in userServices)) {
      throw new CliError(`e2e/proofy.json env names service "${name}", which is not in the compose files`, "CONFIG_INVALID", [
        `Services: ${Object.keys(userServices).join(", ") || "none"}`,
      ]);
    }
  }
  const named: Array<[string, { service: string } | undefined]> = [
    ["app", config.app],
    ["seed", config.seed],
    ...Object.entries(config.exec).map(([key, value]): [string, { service: string }] => [`exec.${key}`, value]),
  ];
  for (const [label, entry] of named) {
    if (entry && !(entry.service in userServices)) {
      throw new CliError(`e2e/proofy.json ${label} names service "${entry.service}", which is not in the compose files`, "CONFIG_INVALID", [
        `Services: ${Object.keys(userServices).join(", ") || "none"}`,
      ]);
    }
  }

  const topVolumes = (model.volumes ?? {}) as Record<string, Record<string, unknown> | null>;
  for (const [name, volume] of Object.entries(topVolumes)) {
    const setting = ["driver", "driver_opts"].find((key) => volume?.[key] !== undefined);
    if (setting) {
      throw new CliError(`Volume ${name} sets ${setting}, which could mount a host folder or a network share into the sandbox`, "CONFIG_INVALID", [
        `Remove ${setting} from volume ${name} in the compose file proofy uses; a plain named volume works`,
      ]);
    }
  }
  const files: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const kind of ["secrets", "configs"] as const) {
    const entries = (model[kind] ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, entry] of Object.entries(entries)) {
      if (typeof entry.environment === "string") {
        throw new CliError(`${kind}.${name} reads the variable ${entry.environment} from the environment proofy runs in, which the sandbox never uses`, "CONFIG_INVALID", [
          `Give ${kind}.${name} a file${kind === "configs" ? " or content" : ""} with a sandbox value in the compose file proofy uses`,
        ]);
      }
      if (typeof entry.file === "string" && exposesSocket(entry.file)) {
        throw new CliError(`${kind}.${name} mounts ${entry.file}, which would let a service control Docker on the host`, "CONFIG_INVALID", [
          `Remove ${kind}.${name} from the compose file proofy uses`,
        ]);
      }
    }
    if (Object.keys(entries).length > 0) files[kind] = entries;
  }

  for (const [name, original] of Object.entries(userServices)) {
    if (name.startsWith("proofy-") || name === MAILPIT) {
      throw new CliError(`The compose service name "${name}" is reserved by proofy`, "CONFIG_INVALID", ["Rename the service in your compose file"]);
    }
    const service: Service = { ...original };
    const breach = sealBreach(service);
    if (breach) {
      throw new CliError(`Service ${name} sets ${breach.setting}, which would ${breach.why}`, "CONFIG_INVALID", [
        `Remove ${breach.setting} from the compose file proofy uses`,
      ]);
    }
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
    healthcheck: { test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:8099/health"], interval: "1s", timeout: "2s", retries: 60 },
  };
  services[MAILPIT] = { image: MAILPIT_IMAGE, networks: { proofy: {} }, environment: { MP_SMTP_AUTH_ACCEPT_ANY: "1", MP_SMTP_AUTH_ALLOW_INSECURE: "1" } };
  services[RUNNER] = {
    image: inputs.runnerImage,
    user: inputs.user,
    profiles: [RUNNER],
    working_dir: MOUNT.work,
    shm_size: "1gb",
    dns: [inputs.standinIp],
    networks: { proofy: {} },
    environment: { CI: "1", HOME: "/tmp", PROOFY_BASE_URL: literal(baseUrl(config)), PROOFY_START_MS: String(config.limits.startMinutes * 60_000) },
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
      command: ["node", `${MOUNT.pkg}/dist/standin/forward.js`, `8080=${config.app.service}:${config.app.port}`, `8025=${MAILPIT}:8025`],
      volumes: [bind(dirs.pkg, MOUNT.pkg, true)],
      networks: { proofy: {}, "proofy-host": {} },
      ports: ["127.0.0.1::8080", "127.0.0.1::8025"],
    };
    networks["proofy-host"] = {};
  }

  const compose: Record<string, unknown> = { services, networks, ...files };
  if (model.volumes) compose.volumes = model.volumes;
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

/**
 * Where the compose files use a variable that has no value in the sandbox, leaving out uses that never reach it: a
 * setting proofy drops or replaces, an e2e/proofy.json env value that overrides it, or a service, volume, secret or
 * config the app does not use. `raw` is the model before interpolation, `model` after. A variable compose reported
 * that is found nowhere is returned with an empty path, so it is never silently blank.
 */
export function unsetUses(raw: Record<string, unknown>, model: Record<string, unknown>, config: Config, names: string[]): UnsetUse[] {
  const found = new Map<string, UnsetUse[]>(names.map((name) => [name, []]));
  const visit = (value: unknown, path: string[]) => {
    if (typeof value === "string") {
      // $$ is a literal dollar sign, never a variable.
      const text = value.replace(/\$\$/g, "");
      for (const name of names) {
        if (new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`).test(text)) found.get(name)?.push({ name, path: settingPath(path, value) });
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    }
  };
  visit(raw, []);
  const reaches = ({ path }: UnsetUse) => {
    const [section = "", entry = "", setting = "", key = ""] = path;
    if (!["services", "volumes", "secrets", "configs"].includes(section)) return false;
    if ((model[section] as Record<string, unknown> | undefined)?.[entry] === undefined) return false;
    if (section !== "services") return true;
    if (DROPPED.has(setting)) return false;
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

// Host paths a Docker or containerd socket lives at. Mounting one, or a folder holding one, lets a container
// start other containers outside the seal.
const SOCKETS = ["/var/run/docker.sock", "/run/docker.sock", "/var/run/containerd/containerd.sock", "/run/containerd/containerd.sock"];
const SOCKET_NAME = /(^|\/)(docker|containerd|podman)\.sock$/;
// Rootless Docker keeps its socket in the user's runtime folder, /run/user/<uid>/docker.sock.
const ROOTLESS = /^(\/var)?\/run\/user(\/\d+)?$/;

/** The first service setting that would let the service out of the sealed sandbox. */
function sealBreach(service: Service): { setting: string; why: string } | undefined {
  if (service.network_mode !== undefined) return { setting: "network_mode", why: "bypass the sealed network" };
  if (service.privileged === true) return { setting: "privileged", why: "give it the host's devices and network controls" };
  if (Array.isArray(service.cap_add) && service.cap_add.length > 0) return { setting: "cap_add", why: "give it powers beyond the sandbox's" };
  for (const key of ["pid", "ipc", "uts", "userns_mode"]) {
    if (service[key] === "host") return { setting: `${key}: host`, why: "share the host's namespace" };
  }
  if (Array.isArray(service.devices) && service.devices.length > 0) return { setting: "devices", why: "give it the host's devices" };
  // The image build has internet, so a pull request's Dockerfile could use these to act as the person running proofy.
  const build = (service.build ?? {}) as { ssh?: unknown; secrets?: unknown };
  if (Array.isArray(build.ssh) && build.ssh.length > 0) return { setting: "build.ssh", why: "give the image build the SSH agent of the person running proofy" };
  if (Array.isArray(build.secrets) && build.secrets.length > 0) return { setting: "build.secrets", why: "give the image build secrets from the host" };
  for (const volume of (service.volumes ?? []) as unknown[]) {
    if (!volume || typeof volume !== "object") continue;
    const { type, source } = volume as { type?: unknown; source?: unknown };
    if (type === "bind" && typeof source === "string" && exposesSocket(source)) return { setting: `a bind mount of ${source}`, why: "let it control Docker on the host" };
  }
  return undefined;
}

function exposesSocket(source: string): boolean {
  const path = source.replace(/\/+$/, "");
  return SOCKET_NAME.test(path) || ROOTLESS.test(path) || SOCKETS.some((socket) => socket === path || socket.startsWith(`${path}/`));
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
