import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");

function readSource(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function selectedCallback(source: string): string {
  const start = source.indexOf("async onSelected(selection)");
  const end = source.indexOf("if (workflowResult.outcome", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("composite persona workflow migrations", () => {
  it("keeps history-import persona progress and results on the anchor controller", () => {
    const source = readSource("src/commands/learn/history.ts");
    const personaMarker = source.indexOf("// SCOPE: PERSONA");
    const personaStart = source.indexOf('if (scope === "persona")', personaMarker);
    const globalStart = source.indexOf('if (scope === "global")', personaStart);
    expect(personaMarker).toBeGreaterThanOrEqual(0);
    expect(personaStart).toBeGreaterThanOrEqual(0);
    expect(globalStart).toBeGreaterThan(personaStart);
    const personaBranch = source.slice(personaStart, globalStart);
    const callback = selectedCallback(source);

    expect(personaBranch).toContain("runPersonaPickerWorkflow");
    expect(personaBranch).toContain("selection.openModal");
    expect(personaBranch).toContain("replyInteraction: work.message");
    expect(personaBranch).not.toContain("replyPaginatedPersonaChoicesV2");
    expect(personaBranch).not.toContain("modalSubmitInteraction");
    expect(callback).not.toContain("deferReply(");
  });

  it("contains none of the retired low-level picker boilerplate", () => {
    const source = readSource("src/commands/learn/history.ts");
    expect(source).not.toContain("replyPaginatedPersonaChoicesV2");
    expect(source).not.toContain("preserveSelectedInteraction: true");
    expect(source).not.toMatch(/onSelect:\s*async\s*\(\)\s*=>\s*\{\s*\}/);
  });
});
