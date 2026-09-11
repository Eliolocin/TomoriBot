import { describe, expect, it } from "bun:test";
import { personaSections } from "@/db/seed/catalog/personas";

describe("official persona naming catalog", () => {
  it("keeps every seeded lineage and language map explicit and exact", () => {
    const actual = Object.fromEntries(
      personaSections
        .flatMap((section) => section.rows)
        .map((persona) => [`${persona.lineageId}:${persona.language}`, persona.namingConfig]),
    );
    expect(actual).toEqual({
      "4:en-US": {
        prefixes: {},
        suffixes: {},
        addressTerms: { masculine: "bro", feminine: "sis", neutral: "fam" },
      },
      "4:ja": { prefixes: {}, suffixes: {}, addressTerms: {} },
      "50:en-US": {
        prefixes: { masculine: "Master", feminine: "Mistress", neutral: "Master" },
        suffixes: {},
        addressTerms: {},
      },
      "50:ja": { prefixes: {}, suffixes: { neutral: "様" }, addressTerms: {} },
      "716:en-US": { prefixes: {}, suffixes: {}, addressTerms: {} },
      "716:ja": { prefixes: {}, suffixes: {}, addressTerms: {} },
      "1770:en-US": { prefixes: {}, suffixes: {}, addressTerms: {} },
      "1770:ja": { prefixes: {}, suffixes: {}, addressTerms: {} },
      "3585:en-US": { prefixes: {}, suffixes: { neutral: "-senpai" }, addressTerms: {} },
      "3585:ja": { prefixes: {}, suffixes: { neutral: "先輩" }, addressTerms: {} },
    });
  });

  it("uses macros for seeded user-vocative output habits", () => {
    const personas = personaSections.flatMap((section) => section.rows);
    const rose = personas.find((persona) => persona.lineageId === 4 && persona.language === "en-US");
    const shy = personas.filter((persona) => persona.lineageId === 3585);
    expect(rose?.sampleDialoguesOut.join("\n")).toContain("{user_term}");
    for (const persona of shy) {
      expect(persona.sampleDialoguesOut.join("\n")).toContain("{user_formatted}");
    }
  });
});
