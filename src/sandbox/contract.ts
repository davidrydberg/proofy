// Names and paths shared by the host side and the containers. Changing one changes both.

export const STANDIN = "proofy-standin";
export const MAILPIT = "mailpit";
export const RUNNER = "proofy-runner";
export const FORWARD = "proofy-forward";

export const ADMIN_PORT = 8099;
export const MAILPIT_API = `http://${MAILPIT}:8025`;
export const STANDIN_ADMIN = `http://${STANDIN}:${ADMIN_PORT}`;

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
