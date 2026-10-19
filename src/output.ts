import { encode } from "@toon-format/toon";

export type Data = Record<string, unknown>;

export interface Result {
  data: Data;
  help: string[];
}

// Help is rendered one hint per line, which TOON's inline primitive arrays would not do.
export function renderResult(result: Result): string {
  const parts: string[] = [];
  if (Object.keys(result.data).length > 0) {
    parts.push(encode(result.data));
  }
  if (result.help.length > 0) {
    parts.push(renderHelp(result.help));
  }
  return parts.join("\n");
}

export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function renderError(message: string, code: string, suggestions: string[]): string {
  return renderResult({ data: { error: message, code }, help: suggestions });
}

function renderHelp(help: string[]): string {
  return [`help[${help.length}]:`, ...help.map((line) => `  ${line}`)].join("\n");
}
