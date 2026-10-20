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

  for (const [name, original] of Object.entries(userServices)) {
    if (name.startsWith("proofy-") || name === MAILPIT) {
      throw new CliError(`The compose service name "${name}" is reserved by proofy`, "CONFIG_INVALID", ["Rename the service in your compose file"]);
    }
    const service: Service = { ...original };
    const breach = sealBreach(service, (model.volumes ?? {}) as Record<string, unknown>);
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
    const environment = { ...((original.environment ?? {}) as Record<string, string | null>), ...(config.env[name] ?? {}) };
    service.environment = environment;
    service.volumes = [...((original.volumes ?? []) as unknown[]), { type: "bind", source: dirs.ca, target: MOUNT.appCa, read_only: true }];
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
    environment: { CI: "1", HOME: "/tmp", PROOFY_BASE_URL: baseUrl(config), PROOFY_START_MS: String(config.limits.startMinutes * 60_000) },
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

  const compose: Record<string, unknown> = { services, networks };
  if (model.volumes) compose.volumes = model.volumes;
  return { compose, notes };
}

export function baseUrl(config: Config): string {
  return config.app ? `http://${config.app.service}:${config.app.port}${config.app.path}` : "";
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
function sealBreach(service: Service, topVolumes: Record<string, unknown>): { setting: string; why: string } | undefined {
  if (service.network_mode !== undefined) return { setting: "network_mode", why: "bypass the sealed network" };
  if (service.privileged === true) return { setting: "privileged", why: "give it the host's devices and network controls" };
  if (Array.isArray(service.cap_add) && service.cap_add.length > 0) return { setting: "cap_add", why: "give it powers beyond the sandbox's" };
  for (const key of ["pid", "ipc", "uts", "userns_mode"]) {
    if (service[key] === "host") return { setting: `${key}: host`, why: "share the host's namespace" };
  }
  if (Array.isArray(service.devices) && service.devices.length > 0) return { setting: "devices", why: "give it the host's devices" };
  for (const volume of (service.volumes ?? []) as unknown[]) {
    const mount = hostMount(volume, topVolumes);
    if (mount && exposesSocket(mount.source)) return { setting: mount.setting, why: "let it control Docker on the host" };
  }
  return undefined;
}

/** The host folder a service volume shows: a bind mount, or a named volume whose driver options bind a host path. */
function hostMount(volume: unknown, topVolumes: Record<string, unknown>): { source: string; setting: string } | undefined {
  if (!volume || typeof volume !== "object") return undefined;
  const { type, source } = volume as { type?: unknown; source?: unknown };
  if (typeof source !== "string") return undefined;
  if (type === "bind") return { source, setting: `a bind mount of ${source}` };
  if (type !== "volume") return undefined;
  const options = (topVolumes[source] as { driver_opts?: { o?: unknown; device?: unknown } } | null | undefined)?.driver_opts;
  if (typeof options?.o !== "string" || typeof options.device !== "string") return undefined;
  if (!options.o.split(",").some((option) => ["bind", "rbind"].includes(option.trim()))) return undefined;
  return { source: options.device, setting: `volume ${source}, a bind mount of ${options.device}` };
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
  return { type: "bind", source, target, read_only: readOnly };
}
