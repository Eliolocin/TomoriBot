import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  FENCE_GUARD,
  getDiscordTextLength,
  neutralizeFenceRuns,
  truncateDiscordText,
} from "@/utils/text/discordTextLimits";

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const matches = source.matchAll(/(?:import|export)\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']/g);
  for (const match of matches) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

describe("discordTextLimits module boundary", () => {
  it("declares no discord.js import and confines all imports to src/utils/text/", async () => {
    const rootPath = resolve(import.meta.dir, "../../../");
    const targetFile = resolve(rootPath, "src/utils/text/discordTextLimits.ts");
    const allowedDir = resolve(rootPath, "src/utils/text");

    const visited = new Set<string>();
    const queue = [targetFile];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);

      const content = await Bun.file(current).text();
      const specifiers = extractImportSpecifiers(content);

      for (const specifier of specifiers) {
        expect(specifier).not.toBe("discord.js");
        expect(specifier.startsWith("discord.js/")).toBe(false);

        let resolvedPath: string;
        if (specifier.startsWith("@/utils/text/")) {
          resolvedPath = resolve(allowedDir, specifier.slice("@/utils/text/".length));
        } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
          resolvedPath = resolve(current, "..", specifier);
        } else {
          throw new Error(`Forbidden import specifier outside text domain: ${specifier}`);
        }

        const normalizedResolved = resolvedPath.replace(/\.ts$/, "");
        const normalizedAllowed = allowedDir.toLowerCase();
        expect(normalizedResolved.toLowerCase().startsWith(normalizedAllowed)).toBe(true);

        const candidateTs = `${normalizedResolved}.ts`;
        if (await Bun.file(candidateTs).exists()) {
          queue.push(candidateTs);
        }
      }
    }

    expect(visited.has(targetFile)).toBe(true);
  });

  it("measures Unicode codepoints matching Discord backend length", () => {
    expect(getDiscordTextLength("hello")).toBe(5);
    expect(getDiscordTextLength("🎉🎈")).toBe(2);
    expect(getDiscordTextLength("你好")).toBe(2);
  });

  it("truncates text grapheme-safely without splitting astral codepoints", () => {
    expect(truncateDiscordText("🎉🎈🚀🔥", 2, "")).toBe("🎉🎈");
    expect(truncateDiscordText("hello world", 8)).toBe("hello...");
    expect(truncateDiscordText("abc", 5)).toBe("abc");
    expect(truncateDiscordText("abc", 0)).toBe("");
  });

  it("neutralizes fence runs with zero-width space interleaving", () => {
    expect(FENCE_GUARD).toBe("\u200B");
    expect(neutralizeFenceRuns("```")).toBe(`\`${FENCE_GUARD}\`${FENCE_GUARD}\``);
    expect(neutralizeFenceRuns("`````")).not.toContain("``");
  });
});
