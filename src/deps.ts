import type { Proc } from "./sandbox/docker.js";

export interface Deps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Runs docker, git and gh. Tests inject a fake. */
  proc: Proc;
  now: () => Date;
  /** Progress lines for long commands. Goes to stderr, so stdout stays one clean result. */
  log: (line: string) => void;
}
