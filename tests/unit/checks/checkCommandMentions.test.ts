import { describe, expect, it } from "bun:test";
import { findRuntimeMentions } from "../../../scripts/checks/checkCommandMentions";

describe("findRuntimeMentions", () => {
  it("finds a single-line getCommandMention in an ordinary file", () => {
    const source = `const path = getCommandMention("a", "b");\n`;
    const findings = findRuntimeMentions(source, "src/commands/test.ts");
    expect(findings).toEqual([{ file: "src/commands/test.ts", line: 1, mention: "a b" }]);
  });

  it("finds a multi-line getCommandMention call", () => {
    const source = `
const __probeMultiline = getCommandMention(
  "definitely",
  "not",
  "real",
);
`;
    const findings = findRuntimeMentions(source, "src/commands/test.ts");
    expect(findings).toEqual([{ file: "src/commands/test.ts", line: 2, mention: "definitely not real" }]);
  });

  it("finds a mention call in an allowlisted file", () => {
    const source = `const path = mention("a", "b");\n`;
    const findings = findRuntimeMentions(source, "src/utils/discord/helpCatalog.ts");
    expect(findings).toEqual([{ file: "src/utils/discord/helpCatalog.ts", line: 1, mention: "a b" }]);
  });

  it("does not find a mention call in a non-allowlisted file", () => {
    const source = `const path = mention("add");\n`;
    const findings = findRuntimeMentions(source, "src/utils/discord/ui/anchorModelFlow.ts");
    expect(findings).toEqual([]);
  });

  it("does not find a call with non-literal arguments", () => {
    const source = `const path = getCommandMention("personal", "openrouter-model", action);\n`;
    const findings = findRuntimeMentions(source, "src/commands/test.ts");
    expect(findings).toEqual([]);
  });

  it("does not find calls inside commandRegistry.ts", () => {
    const source = `const path = getCommandMention("a", "b");\n`;
    const findings = findRuntimeMentions(source, "src/utils/discord/commandRegistry.ts");
    expect(findings).toEqual([]);
  });
});
