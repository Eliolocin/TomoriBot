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

  it("loads vectorize choices after acknowledgement and binds confirmation to a fresh button", () => {
    const callback = selectedCallback(readSource("src/commands/memory/server/vectorize.ts"));

    expect(callback).toContain("selection.openModal(async () =>");
    expect(callback).toContain("selection.useButton(confirmationButton)");
    expect(callback).toContain("confirmationPhase.openModal");
    expect(callback).not.toContain("deferReply(");
    expect(callback).not.toContain("replyInfoEmbed(");
    expect(callback).not.toContain("editReply(");
  });

  it("acknowledges sprite selection before loading sprites and uses nested page buttons", () => {
    const source = readSource("src/commands/persona/sprites/remove.ts");
    const callback = selectedCallback(source);
    const acknowledgeIndex = callback.indexOf("selection.beginInPlaceWork()");
    const spriteLoadIndex = callback.indexOf("personaSpriteRepository.listForPersona");
    const nestedButtonIndex = source.indexOf("selection.useButton(buttonInteraction)");
    const nestedModalIndex = source.indexOf("nested.openModal");

    expect(acknowledgeIndex).toBeGreaterThanOrEqual(0);
    expect(spriteLoadIndex).toBeGreaterThan(acknowledgeIndex);
    expect(nestedButtonIndex).toBeGreaterThanOrEqual(0);
    expect(nestedModalIndex).toBeGreaterThan(nestedButtonIndex);
    expect(source).toContain("flags: MessageFlags.IsComponentsV2");
    expect(callback).not.toContain("replyInfoEmbed(");
    expect(callback).not.toContain("deferReply(");
  });

  it("contains none of the retired low-level picker boilerplate", () => {
    for (const relativePath of [
      "src/commands/learn/history.ts",
      "src/commands/memory/server/vectorize.ts",
      "src/commands/persona/sprites/remove.ts",
    ]) {
      const source = readSource(relativePath);
      expect(source).not.toContain("replyPaginatedPersonaChoicesV2");
      expect(source).not.toContain("preserveSelectedInteraction: true");
      expect(source).not.toMatch(/onSelect:\s*async\s*\(\)\s*=>\s*\{\s*\}/);
    }
  });
});
