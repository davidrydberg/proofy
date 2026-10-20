import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { parse } from "yaml";
import { exists } from "../project.js";

export interface ComposeSources {
  /** The listed compose files and every file they include or extend, relative to the root, in the order found. */
  files: string[];
  /** Env files compose reads to interpolate an included file: the include's env_file, or .env in its folder. */
  envFiles: string[];
}

/** Reads the compose files as YAML to find what else compose reads for them. No Docker, so it is fast enough for `proofy`. */
export async function composeSources(root: string, listed: string[]): Promise<ComposeSources> {
  const files: string[] = [];
  const envFiles: string[] = [];
  const visit = async (file: string): Promise<void> => {
    const path = normalize(file);
    if (files.includes(path)) return;
    files.push(path);
    let doc: unknown;
    try {
      doc = parse(await readFile(resolve(root, path), "utf8"));
    } catch {
      // Missing or not YAML: docker compose says why when the sandbox starts.
      return;
    }
    if (!isRecord(doc)) return;
    const dir = dirname(path);
    for (const entry of Array.isArray(doc.include) ? doc.include : []) {
      const included = strings(isRecord(entry) ? entry.path : entry).map((name) => from(dir, name));
      if (included.length === 0) continue;
      if (isRecord(entry) && entry.env_file !== undefined) {
        envFiles.push(...strings(entry.env_file).map((name) => from(dir, name)));
      } else {
        const project = isRecord(entry) && typeof entry.project_directory === "string" ? from(dir, entry.project_directory) : dirname(included[0] ?? "");
        const fallback = join(project, ".env");
        if (await exists(resolve(root, fallback))) envFiles.push(fallback);
      }
      for (const name of included) await visit(name);
    }
    for (const service of Object.values(isRecord(doc.services) ? doc.services : {})) {
      const extended = isRecord(service) && isRecord(service.extends) ? service.extends.file : undefined;
      if (typeof extended === "string") await visit(from(dir, extended));
    }
  };
  for (const file of listed) await visit(file);
  return { files, envFiles: [...new Set(envFiles)] };
}

// Compose resolves a relative path against the folder of the file that names it.
function from(dir: string, name: string): string {
  return isAbsolute(name) ? normalize(name) : join(dir, name);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
