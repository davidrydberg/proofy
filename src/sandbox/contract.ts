// Names and paths shared by the host side and the containers. Changing one changes both.

export const STANDIN = "proofy-standin";
export const MAILPIT = "mailpit";
export const RUNNER = "proofy-runner";
export const FORWARD = "proofy-forward";

export const ADMIN_PORT = 8099;
export const MAILPIT_PORT = 8025;
export const MAILPIT_API = `http://${MAILPIT}:${MAILPIT_PORT}`;
/** What the dev forwarder listens on inside the sandbox. Docker publishes each on a free port of 127.0.0.1. */
export const FORWARD_PORTS = { app: 8080, mail: MAILPIT_PORT } as const;
export const STANDIN_ADMIN = `http://${STANDIN}:${ADMIN_PORT}`;
/** Mailpit's login for its API and web view; the password is the sandbox token. */
export const MAIL_USER = "proofy";
/** How a test whose claims failed ends, so the host can tell it from a test that broke. */
export const REQUIREMENTS_NOT_MET = "Requirements not met";

/** Mount points inside containers. */
export const MOUNT = {
  ca: "/proofy-ca",
  appCa: "/proofy",
  runSetup: "/proofy-run",
  out: "/out",
  e2e: "/e2e",
  work: "/work",
  pkg: "/proofy-pkg",
  exec: "/work/exec",
} as const;

export const MAILPIT_IMAGE = "axllent/mailpit:v1.27.11";

/** One line of e2e/out/<run>/flows/<flow>/claims.jsonl, read by the host to build the report. */
export type Entry =
  // `compared`: ok left out, so proofy compared expected and actual. Lines without it were decided by the test.
  | { type: "claim"; test: string; spec: string; did: string; expected: unknown; actual: unknown; ok: boolean; compared?: true; evidence?: unknown; fakes: string[] }
  | { type: "not-covered"; test: string; spec: string; why: string }
  | { type: "shot"; test: string; file: string; label: string };
