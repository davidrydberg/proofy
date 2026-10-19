import { CliError } from "./errors.js";

export interface FlagSpec {
  values: string[];
  booleans: string[];
}

export interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

export function parseArgs(args: string[], spec: FlagSpec, command: string): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], values: new Map(), booleans: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
      continue;
    }
    const [name = "", inline] = splitFlag(arg.slice(2));
    if (spec.booleans.includes(name)) {
      if (inline !== undefined) {
        throw invalidFlag(`--${name} takes no value`, command);
      }
      parsed.booleans.add(name);
    } else if (spec.values.includes(name)) {
      const value = inline ?? args[++i];
      if (value === undefined || value === "") {
        throw invalidFlag(`--${name} needs a value`, command);
      }
      parsed.values.set(name, value);
    } else {
      throw invalidFlag(`Unknown flag --${name}`, command);
    }
  }
  return parsed;
}

function splitFlag(flag: string): [string, string | undefined] {
  const eq = flag.indexOf("=");
  return eq === -1 ? [flag, undefined] : [flag.slice(0, eq), flag.slice(eq + 1)];
}

function invalidFlag(message: string, command: string): CliError {
  return new CliError(message, "VALIDATION_ERROR", [`Run \`proofy ${command} --help\` to see its flags`]);
}
