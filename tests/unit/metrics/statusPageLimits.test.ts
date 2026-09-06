import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const STATUS_DIR = resolve(import.meta.dir, "../../../src/utils/metrics/status");

function collectStatusTsFiles(): string[] {
  return readdirSync(STATUS_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => resolve(STATUS_DIR, file));
}

function getFieldCountsPerPage(source: string): number[] {
  const counts: number[] = [];

  for (const match of source.matchAll(/fields:\s*\[/g)) {
    const startIndex = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let endIndex = startIndex;

    while (endIndex < source.length && depth > 0) {
      const char = source[endIndex];
      if (char === "[") depth++;
      else if (char === "]") depth--;
      endIndex++;
    }

    const fieldsContent = source.slice(startIndex, endIndex - 1);
    const nameKeyMatches = fieldsContent.match(/\bnameKey:\s*/g);
    counts.push(nameKeyMatches ? nameKeyMatches.length : 0);
  }

  return counts;
}

describe("status embed limits and ownership", () => {
  it("restricts MAX_PROMPT_PREVIEW reference to sharedFormatters.ts within status metrics", () => {
    const files = collectStatusTsFiles();
    const violatingFiles: string[] = [];

    for (const filePath of files) {
      const fileName = basename(filePath);
      if (fileName === "sharedFormatters.ts") continue;

      const content = readFileSync(filePath, "utf8");
      if (content.includes("MAX_PROMPT_PREVIEW")) {
        violatingFiles.push(fileName);
      }
    }

    expect(violatingFiles).toEqual([]);
  });

  it("asserts at most 25 fields per status page across all status page producers", () => {
    const violations: Array<{ file: string; pageIndex: number; count: number }> = [];
    const producersScanned: string[] = [];

    // Producers are discovered rather than listed, so a status file added later cannot escape this limit.
    for (const filePath of collectStatusTsFiles()) {
      const source = readFileSync(filePath, "utf8");
      const counts = getFieldCountsPerPage(source);
      if (counts.length === 0) continue;

      producersScanned.push(basename(filePath));
      counts.forEach((count, pageIndex) => {
        if (count > 25) {
          violations.push({ file: basename(filePath), pageIndex: pageIndex + 1, count });
        }
      });
    }

    expect(producersScanned.length).toBeGreaterThanOrEqual(5);
    expect(violations).toEqual([]);
  });
});
