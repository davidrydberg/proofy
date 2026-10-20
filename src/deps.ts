import type { Proc } from "./sandbox/docker.js";

export interface Deps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Runs docker, git and gh. Tests inject a fake. */
  proc: Proc;
  now: () => Date;
  /** Progress lines for long commands. Goes to stderr, so stdout stays one clean result. */
  log: (line: string) => void;
  /** Asks the person at the terminal and returns their answer. Absent when stdin or stdout is not a terminal, so only a person can approve. */
  ask?: (question: string) => Promise<string>;
}
