import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const SRC_DIR = resolve(import.meta.dir, "../../../src");

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

const ALL_SOURCE_FILES = collectSourceFiles(SRC_DIR);

function findColourViolations(colour: "Primary" | "Success"): string[] {
  const needle = `ButtonStyle.${colour}`;
  const violations: string[] = [];

  for (const filePath of ALL_SOURCE_FILES) {
    const relPath = relative(SRC_DIR, filePath).replace(/\\/g, "/");
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      // A style union in a property type and a `{@link}` in JSDoc both name a colour without
      // painting a button, so a source-text scan reads them as uses. Narrowing such a union to
      // exclude a banned colour would otherwise trip this gate, which pushes the next author to
      // widen the type instead of narrowing it.
      const isTypePosition = line.includes("?:");
      const isComment = /^\s*(\/\/|\/?\*)/.test(line);
      if (isTypePosition || isComment) continue;

      // Primary is permitted for active category button rows, the shared state-control primitive, and a
      // terminal commit action that is disabled until its whole flow is valid.
      const isCategorySelection =
        (relPath === "utils/discord/ui/panel.ts" &&
          line.includes("cat.id === activeCategory ? ButtonStyle.Primary : ButtonStyle.Secondary")) ||
        (relPath === "utils/discord/ui/helpDashboard.ts" &&
          line.includes("category.id === activeCategoryId ? ButtonStyle.Primary : ButtonStyle.Secondary")) ||
        (relPath === "utils/stats/statsDashboard.ts" &&
          line.includes("index === activeIndex ? ButtonStyle.Primary : ButtonStyle.Secondary")) ||
        // The translation switcher is a state-control row: its active provider is the disabled one,
        // so the selected choice takes Primary under the same rule as a category button.
        (relPath === "utils/discord/embedHelper.ts" &&
          line.includes("provider === activeProvider ? ButtonStyle.Primary : ButtonStyle.Secondary"));
      const isStateControlSelection =
        relPath === "utils/discord/ui/panel.ts" &&
        line.includes("isSelected ? ButtonStyle.Primary : ButtonStyle.Secondary");
      // A terminal commit action earns Primary only while it is also gated: the setup wizard's Finish button is
      // disabled until every rendered requirement is complete, so Primary marks a state the actor can act on
      // rather than advertising an action that would fail. An ungated action button does not qualify.
      const isGatedCommitAction =
        relPath === "utils/discord/ui/setupPanel.ts" &&
        line.includes("isComplete ? ButtonStyle.Primary : ButtonStyle.Secondary");
      if (line.includes(needle) && !isCategorySelection && !isStateControlSelection && !isGatedCommitAction) {
        violations.push(`${relPath}:${index + 1}`);
      }
    }
  }

  return violations;
}

describe("panel button colour convention", () => {
  it("reserves Primary for the active category button and state-control rows", () => {
    expect(findColourViolations("Primary")).toEqual([]);

    const sharedPanelSource = readFileSync(resolve(SRC_DIR, "utils/discord/ui/panel.ts"), "utf8");
    expect(sharedPanelSource).toContain("cat.id === activeCategory ? ButtonStyle.Primary : ButtonStyle.Secondary");
    expect(sharedPanelSource).toContain("isSelected ? ButtonStyle.Primary : ButtonStyle.Secondary");
    expect(sharedPanelSource.match(/ButtonStyle\.Primary/g)).toHaveLength(2);
  });

  it("keeps panel actions grey or red rather than green", () => {
    expect(findColourViolations("Success")).toEqual([]);
  });
});
