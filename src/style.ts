export interface Style {
  color: boolean;
  width: number;
}

export interface Painter {
  bold: (text: string) => string;
  dim: (text: string) => string;
  red: (text: string) => string;
  green: (text: string) => string;
  yellow: (text: string) => string;
  cyan: (text: string) => string;
}

// Kept ASCII in source; these render as check mark, cross and bullet.
export const GLYPH = { ok: "\u2713", fail: "\u2717", warn: "!", dot: "\u2022" };

export function resolveStyle(env: NodeJS.ProcessEnv, isTTY: boolean, columns: number | undefined): Style {
  let color = isTTY;
  if (env.FORCE_COLOR !== undefined) {
    color = env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  }
  if (env.NO_COLOR) {
    color = false;
  }
  return { color, width: Math.max(60, columns || 100) };
}

export function painter(style: Style): Painter {
  const wrap = (open: number, close: number) => (text: string) =>
    style.color && text ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

export function truncate(text: string, max: number): string {
  if (max <= 3) return text.slice(0, Math.max(0, max));
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

// Pads by visible length so colored text still lines up.
export function padVisible(text: string, width: number, align: "left" | "right" = "left"): string {
  const visible = stripAnsi(text).length;
  const pad = " ".repeat(Math.max(0, width - visible));
  return align === "left" ? text + pad : pad + text;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
