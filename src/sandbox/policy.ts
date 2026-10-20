import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Config } from "../config.js";
import { CliError } from "../errors.js";
import { MAILPIT } from "./contract.js";

type Service = Record<string, unknown>;

export interface SealInputs {
  /** The app's compose files, normalized by `docker compose config --format json`. */
  model: Record<string, unknown>;
  config: Config;
  /** Repo root. Builds, bind mounts, secrets and configs can't read host files outside it. */
  repoDir: string;
  /** The real path, symlinks resolved, of repoDir and of every path hostPaths returns. A path missing here is compared as written. */
  realPaths: Record<string, string>;
}

/** Throws on the first compose setting that would break the seal, or a config entry naming a service that does not exist. */
export function checkSeal({ model, config, repoDir, realPaths }: SealInputs): void {
  const userServices = (model.services ?? {}) as Record<string, Service>;
  const named: Array<[string, { service: string } | undefined]> = [
    ...Object.keys(config.env).map((service): [string, { service: string }] => ["env", { service }]),
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

  for (const [name, volume] of Object.entries((model.volumes ?? {}) as Record<string, Record<string, unknown> | null>)) {
    const setting = volume?.driver_opts !== undefined ? "driver_opts" : volume?.driver !== undefined && volume.driver !== "local" ? "driver" : undefined;
    if (setting) {
      throw new CliError(`Volume ${name} sets ${setting}, which could mount a host folder or a network share into the sandbox`, "CONFIG_INVALID", [
        `Remove ${setting} from volume ${name} in the compose file proofy uses; a plain named volume, or driver: local, works`,
      ]);
    }
    if (volume?.external !== undefined && volume.external !== false) {
      throw new CliError(`Volume ${name} is external, which would mount a Docker volume from outside the sandbox`, "CONFIG_INVALID", [
        `Remove external from volume ${name} in the compose file proofy uses; the sandbox starts it empty`,
      ]);
    }
  }

  for (const kind of ["secrets", "configs"] as const) {
    for (const [name, entry] of Object.entries((model[kind] ?? {}) as Record<string, Record<string, unknown>>)) {
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
      if (typeof entry.file === "string" && outsideRepo(resolve(repoDir, entry.file), repoDir, realPaths)) {
        throw new CliError(`${kind}.${name} mounts ${entry.file}, which would give a service host files outside the repository`, "CONFIG_INVALID", [
          `Point ${kind}.${name} at a file inside the repository in the compose file proofy uses`,
        ]);
      }
    }
  }

  for (const [name, service] of Object.entries(userServices)) {
    if (name.startsWith("proofy-") || name === MAILPIT) {
      throw new CliError(`The compose service name "${name}" is reserved by proofy`, "CONFIG_INVALID", ["Rename the service in your compose file"]);
    }
    const breach = sealBreach(service, repoDir, realPaths);
    if (breach) {
      throw new CliError(`Service ${name} sets ${breach.setting}, which would ${breach.why}`, "CONFIG_INVALID", [
        `Remove ${breach.setting} from the compose file proofy uses`,
      ]);
    }
  }
}

// Host paths a Docker or containerd socket lives at. Mounting one, or a folder holding one, lets a container
// start other containers outside the seal.
const SOCKETS = ["/var/run/docker.sock", "/run/docker.sock", "/var/run/containerd/containerd.sock", "/run/containerd/containerd.sock"];
const SOCKET_NAME = /(^|\/)(docker|containerd|podman)\.sock$/;
// Rootless Docker keeps its socket in the user's runtime folder, /run/user/<uid>/docker.sock.
const ROOTLESS = /^(\/var)?\/run\/user(\/\d+)?$/;

/** The first service setting that would let the service out of the sealed sandbox. */
function sealBreach(service: Service, repoDir: string, realPaths: Record<string, string>): { setting: string; why: string } | undefined {
  if (service.network_mode !== undefined) return { setting: "network_mode", why: "bypass the sealed network" };
  if (service.privileged === true) return { setting: "privileged", why: "give it the host's devices and network controls" };
  if (Array.isArray(service.cap_add) && service.cap_add.length > 0) return { setting: "cap_add", why: "give it powers beyond the sandbox's" };
  for (const key of ["pid", "ipc", "uts", "userns_mode"]) {
    if (service[key] === "host") return { setting: `${key}: host`, why: "share the host's namespace" };
    if (typeof service[key] === "string" && service[key].startsWith("container:")) return { setting: `${key}: ${service[key]}`, why: "share the namespace of a container outside the sandbox" };
  }
  for (const entry of (service.volumes_from ?? []) as unknown[]) {
    if (typeof entry === "string" && entry.startsWith("container:")) return { setting: `volumes_from ${entry}`, why: "give it the mounts of a container outside the sandbox" };
  }
  if (Array.isArray(service.devices) && service.devices.length > 0) return { setting: "devices", why: "give it the host's devices" };
  // The image build has internet, so a pull request's Dockerfile could use these to act as the person running proofy.
  const build = (service.build ?? {}) as { ssh?: unknown; secrets?: unknown; privileged?: unknown; entitlements?: unknown };
  if (Array.isArray(build.ssh) && build.ssh.length > 0) return { setting: "build.ssh", why: "give the image build the SSH agent of the person running proofy" };
  if (Array.isArray(build.secrets) && build.secrets.length > 0) return { setting: "build.secrets", why: "give the image build secrets from the host" };
  if (build.privileged === true) return { setting: "build.privileged", why: "give the image build the host's devices and network controls" };
  if (Array.isArray(build.entitlements) && build.entitlements.length > 0) return { setting: "build.entitlements", why: "give the image build powers beyond the sandbox's" };
  for (const { setting, value, path } of contextsOf(service, repoDir)) {
    if (outsideRepo(path, repoDir, realPaths)) return { setting: `${setting} ${value}`, why: "give the image build host files outside the repository" };
  }
  for (const source of bindSources(service)) {
    if (exposesSocket(source)) return { setting: `a bind mount of ${source}`, why: "let it control Docker on the host" };
    if (outsideRepo(resolve(repoDir, source), repoDir, realPaths)) return { setting: `a bind mount of ${source}`, why: "give it host files outside the repository" };
  }
  return undefined;
}

/**
 * Every host path the model reads: local build contexts, bind mount sources, and secret and config files. prepare
 * resolves their symlinks before sandboxCompose compares them with the repository.
 */
export function hostPaths(model: Record<string, unknown>, repoDir: string): string[] {
  const services = Object.values((model.services ?? {}) as Record<string, Service>);
  const files = (["secrets", "configs"] as const).flatMap((kind) => Object.values((model[kind] ?? {}) as Record<string, { file?: unknown }>));
  return [
    ...services.flatMap((service) => [...contextsOf(service, repoDir).map(({ path }) => path), ...bindSources(service).map((source) => resolve(repoDir, source))]),
    ...files.flatMap(({ file }) => (typeof file === "string" ? [resolve(repoDir, file)] : [])),
  ];
}

function bindSources(service: Service): string[] {
  return ((service.volumes ?? []) as unknown[]).flatMap((volume) => {
    const { type, source } = (volume && typeof volume === "object" ? volume : {}) as { type?: unknown; source?: unknown };
    return type === "bind" && typeof source === "string" ? [source] : [];
  });
}

function contextsOf(service: Service, repoDir: string): Array<{ setting: string; value: string; path: string }> {
  const build = (service.build ?? {}) as { context?: unknown; additional_contexts?: unknown };
  const contexts: Array<[string, unknown]> = [
    ["build.context", build.context],
    ...Object.entries((build.additional_contexts ?? {}) as Record<string, unknown>).map(([name, value]): [string, unknown] => [`build.additional_contexts.${name}`, value]),
  ];
  return contexts.flatMap(([setting, value]) => {
    const path = typeof value === "string" ? hostPath(value, repoDir) : undefined;
    return path === undefined ? [] : [{ setting, value: value as string, path }];
  });
}

// A context with a scheme, such as https://, docker-image:// or service:, or a git@ address is not a host folder.
const REMOTE = /^([A-Za-z][A-Za-z0-9+.-]*:|git@)/;

/** The host folder a build context reads, or undefined for a remote one. An OCI layout is a host folder too. */
function hostPath(context: string, repoDir: string): string | undefined {
  const layout = /^oci-layout:\/\/(.*?)(@[^/]*)?$/.exec(context);
  if (layout) return resolve(repoDir, layout[1] ?? "");
  return REMOTE.test(context) ? undefined : resolve(repoDir, context);
}

/** Whether a host path lies outside the repository, by real paths where prepare resolved them, so a symlink cannot point out of it. */
function outsideRepo(path: string, repoDir: string, realPaths: Record<string, string>): boolean {
  const real = realPaths[path];
  return !(real === undefined ? inside(repoDir, path) : inside(realPaths[repoDir] ?? repoDir, real));
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function exposesSocket(source: string): boolean {
  const path = source.replace(/\/+$/, "");
  return SOCKET_NAME.test(path) || ROOTLESS.test(path) || SOCKETS.some((socket) => socket === path || socket.startsWith(`${path}/`));
}
