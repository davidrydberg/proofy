/** The exit code contract. 1 is reserved for a requirement that did not hold, so a crash never looks like a finding. */
export const EXIT = { pass: 0, failed: 1, usage: 2, environment: 3, notApproved: 4 } as const;

export type ErrorCode = "VALIDATION_ERROR" | "CONFIG_INVALID" | "NOT_SET_UP" | "ENVIRONMENT_ERROR" | "NOT_APPROVED";

const EXIT_CODES: Record<ErrorCode, number> = {
  VALIDATION_ERROR: EXIT.usage,
  CONFIG_INVALID: EXIT.usage,
  NOT_SET_UP: EXIT.usage,
  ENVIRONMENT_ERROR: EXIT.environment,
  NOT_APPROVED: EXIT.notApproved,
};

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly suggestions: string[];

  constructor(message: string, code: ErrorCode, suggestions: string[] = []) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.suggestions = suggestions;
  }
}

export function exitCodeFor(error: unknown): number {
  return error instanceof CliError ? EXIT_CODES[error.code] : EXIT.environment;
}
