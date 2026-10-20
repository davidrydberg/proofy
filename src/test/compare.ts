import { isDeepStrictEqual } from "node:util";

// How claims are compared and shown. Shared by claim() in the runner and the report on the host, which compares
// again from the recorded values, so a tick proofy shows always follows from the values next to it.

/** Expected and actual equal as JSON: same values and types, key order aside. */
export function sameJson(expected: unknown, actual: unknown): boolean {
  return isDeepStrictEqual(asJson(expected), asJson(actual));
}

/** The value as it is recorded in claims.jsonl. */
export function asJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

/** A claim value for the report. Compared values show as JSON, so "3" and 3 look different, as they compare. */
export function showValue(value: unknown, compared: boolean): string {
  if (typeof value === "string" && !compared) return value;
  return JSON.stringify(value) ?? "undefined";
}
