import { spawn } from "node:child_process";
import { CliError } from "../errors.js";

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcOptions {
  cwd?: string;
  timeoutMs?: number;
  /** The program's whole environment. proofy's own environment when absent. */
  env?: NodeJS.ProcessEnv;
  /** Streams output as it comes, for long steps such as image builds and test runs. */
  onOutput?: (chunk: string) => void;
}

/** Runs a program without a shell. Injected so tests never start Docker. */
export type Proc = (program: string, args: string[], options?: ProcOptions) => Promise<ProcResult>;

export const spawnProc: Proc = (program, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      options.onOutput?.(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      options.onOutput?.(chunk.toString());
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new CliError(`${program} is not installed or not on PATH`, "ENVIRONMENT_ERROR", [installHint(program)]));
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });

function installHint(program: string): string {
  if (program === "docker") return "Install Docker (Docker Desktop, OrbStack or Docker Engine) and start it";
  if (program === "gh") return "Install the GitHub CLI: https://cli.github.com, then run `gh auth login`";
  return `Install ${program}`;
}

/** The last lines of a command's output, for error messages that point at the cause. */
export function tail(text: string, lines = 15): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}
