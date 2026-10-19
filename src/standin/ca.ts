import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Runs inside the fake-service container, which has openssl. The certificate authority lives in the project's
// cache folder, so apps that copy it into their trust store at start keep trusting it across runs.

const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

export function ensureCa(dir: string): void {
  mkdirSync(join(dir, "leaf"), { recursive: true });
  if (!existsSync(join(dir, "ca.crt"))) {
    openssl([
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", join(dir, "ca.key"), "-out", join(dir, "ca.crt"), "-days", "3650",
      "-subj", "/CN=proofy sandbox CA",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
  }
  if (!existsSync(join(dir, "leaf.key"))) {
    openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", join(dir, "leaf.key")]);
  }
  // For clients that take one bundle file instead of adding to the system store, such as Python's requests.
  const system = existsSync(SYSTEM_BUNDLE) ? readFileSync(SYSTEM_BUNDLE, "utf8") : "";
  writeFileSync(join(dir, "ca-bundle.crt"), `${system}\n${readFileSync(join(dir, "ca.crt"), "utf8")}`);
}

/** A certificate for one hostname, signed by the sandbox authority and cached on disk. */
export function leafFor(dir: string, host: string): { key: Buffer; cert: Buffer } {
  const safe = host.replace(/[^a-z0-9.-]/gi, "_");
  const file = join(dir, "leaf", `${safe}.crt`);
  if (!existsSync(file)) {
    openssl([
      "req", "-x509", "-new", "-key", join(dir, "leaf.key"), "-subj", `/CN=${safe}`,
      "-addext", `subjectAltName=DNS:${safe}`, "-addext", "basicConstraints=critical,CA:FALSE",
      "-addext", "extendedKeyUsage=serverAuth",
      "-CA", join(dir, "ca.crt"), "-CAkey", join(dir, "ca.key"), "-days", "365", "-out", file,
    ]);
  }
  return { key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(file) };
}

function openssl(args: string[]): void {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
}
