function positiveIntegerFromEnvironment(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const MAX_MCP_TOOL_SNAPSHOT_NAMES = positiveIntegerFromEnvironment("MCP_TOOL_SNAPSHOT_MAX_NAMES", 100);
export const MAX_MCP_TOOL_SNAPSHOT_NAME_CHARACTERS = positiveIntegerFromEnvironment(
  "MCP_TOOL_SNAPSHOT_NAME_MAX_CHARS",
  128,
);

const MAX_DISPLAYED_NAMES = 5;
const MAX_DISPLAYED_NAME_CHARACTERS = 40;
const MAX_DISPLAYED_CHARACTERS = 180;

function normalizeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }).join("");
}

export function normalizeMcpToolNameSnapshot(functionNames: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawName of functionNames) {
    const name = Array.from(normalizeControlCharacters(rawName).replace(/\s+/g, " ").trim())
      .slice(0, MAX_MCP_TOOL_SNAPSHOT_NAME_CHARACTERS)
      .join("");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
    if (normalized.length >= MAX_MCP_TOOL_SNAPSHOT_NAMES) break;
  }
  return normalized;
}

export function formatMcpToolNamesForDiscord(functionNames: readonly string[]): string | null {
  const normalized = normalizeMcpToolNameSnapshot(functionNames);
  const displayed: string[] = [];
  for (const [index, name] of normalized.slice(0, MAX_DISPLAYED_NAMES).entries()) {
    const boundedName = Array.from(name).slice(0, MAX_DISPLAYED_NAME_CHARACTERS).join("").replaceAll("`", "'");
    const formatted = `\`${boundedName}\``;
    const candidate = [...displayed, formatted].join(", ");
    const needsEllipsis = index + 1 < normalized.length;
    if (candidate.length + (needsEllipsis ? 3 : 0) > MAX_DISPLAYED_CHARACTERS) break;
    displayed.push(formatted);
  }
  if (displayed.length === 0) return null;
  const joined = displayed.join(", ");
  return displayed.length < normalized.length ? `${joined}, …` : joined;
}
