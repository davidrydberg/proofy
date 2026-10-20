import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { detectCompose, type ComposeGuess, type EnvGuess } from "./detect.js";

/** Hosts an app calls without needing the answer: analytics, tracking, error reports. Matched on the end of the hostname. */
const TELEMETRY = [
  "posthog.com", "google-analytics.com", "analytics.google.com", "googletagmanager.com", "doubleclick.net", "sentry.io", "segment.io", "segment.com",
  "hotjar.com", "hotjar.io", "clarity.ms", "plausible.io", "mixpanel.com", "amplitude.com", "fullstory.com", "datadoghq.com", "datadoghq.eu",
  "nr-data.net", "bugsnag.com", "logrocket.io", "logrocket.com", "connect.facebook.net", "snap.licdn.com", "analytics.tiktok.com",
];
/** Hosts whose answer an app usually needs, found in code as well as in settings. */
const NEEDS_ANSWER = ["stripe.com", "klarna.com", "adyen.com", "mollie.com", "paypal.com", "klaviyo.com", "sendgrid.com", "mailgun.net", "postmarkapp.com", "twilio.com"];

const CODE = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte", ".php", ".py", ".rb", ".go", ".html", ".twig"]);
const SKIP = new Set(["node_modules", "vendor", ".git", "dist", "build", "coverage", ".next", ".nuxt", "storage", "e2e", "tmp", ".cache"]);
const MAX_FILES = 5000;
const MAX_BYTES = 512 * 1024;
const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/;

export interface OutsideGuess {
  /** Telemetry hosts found, ready for `hosts` as record. */
  record: string[];
  /** Other outside hosts the app may need an answer from: the agent picks fake or record. */
  decide: Array<{ host: string; from: string }>;
  /** Settings pointing at a local port no compose service serves: most likely a backend in another repository. */
  backends: Array<{ key: string; file: string; url: string; port: number; sibling?: { dir: string; service: string } }>;
}

export async function detectOutside(root: string, compose: ComposeGuess | undefined, envs: EnvGuess[]): Promise<OutsideGuess> {
  const services = new Set(compose?.services ?? []);
  const found = new Map<string, string>();
  const backends: OutsideGuess["backends"] = [];
  for (const env of envs) {
    for (const { key, url } of env.urls) {
      const host = url.hostname.toLowerCase();
      if (LOCAL.test(host)) {
        const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
        if (compose?.published[port] === undefined) backends.push({ key, file: env.file, url: url.href, port });
      } else if (!services.has(host) && host.includes(".") && !found.has(host)) {
        found.set(host, `${key} in ${env.file}`);
      }
    }
  }
  for (const [host, file] of await hostsInCode(root)) {
    if (!found.has(host) && (matches(host, TELEMETRY) || matches(host, NEEDS_ANSWER))) found.set(host, file);
  }
  await Promise.all(backends.map(async (backend) => {
    const sibling = await siblingServing(root, backend.port);
    if (sibling) backend.sibling = sibling;
  }));
  const record = [...found.keys()].filter((host) => matches(host, TELEMETRY)).sort();
  const decide = [...found].filter(([host]) => !matches(host, TELEMETRY)).map(([host, from]) => ({ host, from })).sort((a, b) => a.host.localeCompare(b.host));
  return { record, decide, backends };
}

function matches(host: string, suffixes: string[]): boolean {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Hostnames in URLs in the repository's source, with the first file each appears in. */
async function hostsInCode(root: string): Promise<Map<string, string>> {
  const hosts = new Map<string, string>();
  let budget = MAX_FILES;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (budget <= 0) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) await walk(path);
      } else if (entry.isFile() && CODE.has(extname(entry.name))) {
        budget--;
        if ((await stat(path)).size > MAX_BYTES) continue;
        const text = await readFile(path, "utf8");
        for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,63})\b/gi)) {
          const host = (match[1] ?? "").toLowerCase();
          if (!hosts.has(host)) hosts.set(host, relative(root, path));
        }
      }
    }
  };
  await walk(root);
  return hosts;
}

/** A folder next to this one whose compose file publishes `port`, such as the API repository next to a frontend. */
async function siblingServing(root: string, port: number): Promise<{ dir: string; service: string } | undefined> {
  const parent = dirname(root);
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === basename(root)) continue;
    const compose = await detectCompose(join(parent, entry.name)).catch(() => undefined);
    const service = compose?.published[port];
    if (service) return { dir: join("..", entry.name), service };
  }
  return undefined;
}
