import type { Result } from "../output.js";
import type { Style } from "../style.js";

export interface CommandResult extends Result {
  json?: unknown;
  pretty?: (style: Style) => string;
  /** Set by commands whose result is a verdict, such as run; 0 otherwise. */
  exitCode?: number;
}
