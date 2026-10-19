export class CliError extends Error {
  readonly code: string;
  readonly suggestions: string[];

  constructor(message: string, code: string, suggestions: string[] = []) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.suggestions = suggestions;
  }
}

// 1 is reserved for a failed requirement, so an unexpected crash must not look like a finding about the app.
const EXIT_CODES: Record<string, number> = {
  VALIDATION_ERROR: 2,
  CONFIG_INVALID: 2,
  NOT_SET_UP: 2,
  ENVIRONMENT_ERROR: 3,
  NOT_APPROVED: 4,
};

export function exitCodeFor(error: unknown): number {
  return error instanceof CliError ? (EXIT_CODES[error.code] ?? 3) : 3;
}
