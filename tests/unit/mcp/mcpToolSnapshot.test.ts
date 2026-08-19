import { describe, expect, it } from "bun:test";
import {
  MAX_MCP_TOOL_SNAPSHOT_NAME_CHARACTERS,
  MAX_MCP_TOOL_SNAPSHOT_NAMES,
  formatMcpToolNamesForDiscord,
  normalizeMcpToolNameSnapshot,
} from "@/utils/mcp/mcpToolSnapshot";

describe("MCP tool-name snapshots", () => {
  it("normalizes controls and whitespace, deduplicates, bounds, and does not alias mutable input", () => {
    const source = [
      "  read\n wiki\u0000 ",
      "read wiki",
      "x".repeat(MAX_MCP_TOOL_SNAPSHOT_NAME_CHARACTERS + 20),
      ...Array.from({ length: MAX_MCP_TOOL_SNAPSHOT_NAMES + 2 }, (_, index) => `tool-${index}`),
    ];
    const snapshot = normalizeMcpToolNameSnapshot(source);

    expect(snapshot[0]).toBe("read wiki");
    expect(snapshot[1]).toHaveLength(MAX_MCP_TOOL_SNAPSHOT_NAME_CHARACTERS);
    expect(snapshot).toHaveLength(MAX_MCP_TOOL_SNAPSHOT_NAMES);
    snapshot[0] = "mutated";
    expect(source[0]).toBe("  read\n wiki\u0000 ");
  });

  it("formats each hostile name inside its own bounded inline-code span", () => {
    const formatted = formatMcpToolNamesForDiscord([
      "read_wiki",
      "`open`\nrepo\u0000",
      "*danger*",
      "long_".repeat(20),
      "five",
      "six-hidden",
    ]);

    expect(formatted).not.toBeNull();
    expect(formatted).toContain("`read_wiki`, `'open' repo`, `*danger*`");
    expect(formatted?.match(/`[^`]*`/g)).toHaveLength(5);
    expect(formatted).toEndWith(", …");
    expect(formatted).not.toContain("six-hidden");
    expect(formatted?.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(180);
  });
});
