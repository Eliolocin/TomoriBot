import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const PANEL_UI_DIR = resolve(import.meta.dir, "../../../src/utils/discord/ui");
const PANEL_FILES = [...readdirSync(PANEL_UI_DIR).filter((name) => name.endsWith("Panel.ts")), "panel.ts"];

function findColourViolations(colour: "Primary" | "Success"): string[] {
  const needle = `ButtonStyle.${colour}`;
  const violations: string[] = [];

  for (const file of PANEL_FILES) {
    const lines = readFileSync(resolve(PANEL_UI_DIR, file), "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const isCategorySelection =
        file === "panel.ts" && line.includes("cat.id === activeCategory ? ButtonStyle.Primary : ButtonStyle.Secondary");
      if (line.includes(needle) && !isCategorySelection) {
        violations.push(`${file}:${index + 1}`);
      }
    }
  }

  return violations;
}

describe("panel button colour convention", () => {
  it("reserves Primary for the active category button", () => {
    expect(findColourViolations("Primary")).toEqual([]);

    const sharedPanelSource = readFileSync(resolve(PANEL_UI_DIR, "panel.ts"), "utf8");
    expect(sharedPanelSource).toContain("cat.id === activeCategory ? ButtonStyle.Primary : ButtonStyle.Secondary");
    expect(sharedPanelSource.match(/ButtonStyle\.Primary/g)).toHaveLength(1);
  });

  it("keeps panel actions grey or red rather than green", () => {
    expect(findColourViolations("Success")).toEqual([]);
  });
});
