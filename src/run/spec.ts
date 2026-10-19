export interface Requirement {
  id: string;
  text: string;
}

/** Numbered requirements from a spec file: lines starting with R1., R2: or R3). */
export function parseRequirements(markdown: string): Requirement[] {
  const out: Requirement[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s+)?\**(R\d+)\**[.:)]\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, id = "", text = ""] = match;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, text });
  }
  return out;
}
