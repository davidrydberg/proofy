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

/** The list items under a `## <heading>` section of a spec file, such as "Assumed" or "Not covered". */
export function specSection(markdown: string, heading: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of markdown.split(/\r?\n/)) {
    const title = /^##\s+(.+?)\s*$/.exec(line);
    if (title) {
      inside = title[1]?.toLowerCase() === heading.toLowerCase();
      continue;
    }
    const item = inside ? /^\s*[-*]\s+(.+?)\s*$/.exec(line) : null;
    if (item?.[1]) out.push(item[1]);
  }
  return out;
}
