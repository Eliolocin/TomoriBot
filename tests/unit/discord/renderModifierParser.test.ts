import { describe, expect, it } from "bun:test";
import type { TomoriState } from "@/types/db/schema";
import {
  collectRenderModifierSourceNames,
  formatRenderModifierWebhookName,
  isAllowedRenderModifierSpeakerLabel,
  matchesRenderModifierName,
  parseLeadingGenericSpeakerLabel,
  parseLeadingRenderModifier,
  parseRenderModifierWebhookName,
  resolveRenderModifierSourcePersona,
} from "@/utils/discord/renderModifierParser";

function persona(nickname: string, id = 1): TomoriState {
  return {
    persona_id: id,
    persona_nickname: nickname,
  } as TomoriState;
}

describe("render modifier parser", () => {
  it("parses active persona copied-render syntax", () => {
    const result = parseLeadingRenderModifier("Ren (Obonya): hi", ["Ren"]);

    expect(result).toEqual({
      sourceName: "Ren",
      modifier: "Obonya",
      body: "hi",
      matchedPrefix: "Ren (Obonya): ",
    });
  });

  it("parses a self-label chain before active persona render-modifier syntax", () => {
    const result = parseLeadingRenderModifier("Tomori: Aphel (done): Rose is fine.", ["Aphel", "Tomori"]);

    expect(result).toEqual({
      sourceName: "Aphel",
      modifier: "done",
      body: "Rose is fine.",
      matchedPrefix: "Tomori: Aphel (done): ",
    });
  });

  it("allows a known previous-persona chain before the active persona render-modifier syntax", () => {
    const result = parseLeadingRenderModifier(
      "Lilya: Aphel (embarrassed): Can you not?",
      ["Aphel", "Tomori"],
      ["Aphel", "Tomori", "Lilya"],
    );

    expect(result).toEqual({
      sourceName: "Aphel",
      modifier: "embarrassed",
      body: "Can you not?",
      matchedPrefix: "Lilya: Aphel (embarrassed): ",
    });
  });

  it("does not let a chain-only persona become the active render-modifier source", () => {
    const result = parseLeadingRenderModifier(
      "Lilya (embarrassed): Can you not?",
      ["Aphel", "Tomori"],
      ["Aphel", "Tomori", "Lilya"],
    );

    expect(result).toBeNull();
  });

  it("parses unresolved modifiers so callers can strip the parenthetical label", () => {
    const result = parseLeadingRenderModifier("Ren (unknown): hi", ["Ren"]);

    expect(result?.modifier).toBe("unknown");
    expect(result?.body).toBe("hi");
  });

  it("does not parse other speakers", () => {
    expect(parseLeadingRenderModifier("Other (Obonya): hi", ["Ren"])).toBeNull();
    expect(parseLeadingRenderModifier("Other: Ren (Obonya): hi", ["Ren", "Tomori"])).toBeNull();
  });

  it("ignores code-block and list-like starts", () => {
    expect(parseLeadingRenderModifier("```\nRen (Obonya): hi\n```", ["Ren"])).toBeNull();
    expect(parseLeadingRenderModifier("- Ren (Obonya): hi", ["Ren"])).toBeNull();
    expect(parseLeadingRenderModifier("1. Ren (Obonya): hi", ["Ren"])).toBeNull();
  });

  it("rejects overlong modifiers", () => {
    expect(parseLeadingRenderModifier(`Ren (${"a".repeat(65)}): hi`, ["Ren"])).toBeNull();
  });

  it("formats webhook names within Discord's username limit", () => {
    const formatted = formatRenderModifierWebhookName("R".repeat(90), "Obonya");

    expect(formatted.length).toBeLessThanOrEqual(80);
    expect(formatted.endsWith(" (Obonya)")).toBe(true);
  });

  it("parses visible webhook names back into source and modifier", () => {
    expect(parseRenderModifierWebhookName("Ren (Obonya)")).toEqual({
      sourceName: "Ren",
      modifier: "Obonya",
    });
  });

  it("resolves legacy copied-render webhook names to the source persona while preserving display label", () => {
    const personaByNickname = new Map([["ren", persona("Ren", 123)]]);

    const result = resolveRenderModifierSourcePersona("Ren (Obonya)", personaByNickname);

    expect(result?.persona.persona_id).toBe(123);
    expect(result?.displayName).toBe("Ren (Obonya)");
  });

  it("resolves flipped copied-render webhook names and rebuilds the source-first context label", () => {
    const personaByNickname = new Map([["ren", persona("Ren", 123)]]);

    // Discord display puts the impersonated name first; the model-facing label
    // must come back source-persona-first.
    const result = resolveRenderModifierSourcePersona("Obonya (Ren)", personaByNickname);

    expect(result?.persona.persona_id).toBe(123);
    expect(result?.displayName).toBe("Ren (Obonya)");
  });

  it("prefers the flipped orientation when both name parts match personas", () => {
    const personaByNickname = new Map([
      ["ren", persona("Ren", 123)],
      ["tomori", persona("Tomori", 456)],
    ]);

    // New persona-impersonates-persona display: "Tomori (Ren)" = Ren disguised
    // as Tomori. Legacy messages with the same shape are misattributed until
    // they age out of the history fetch window (documented trade-off).
    const result = resolveRenderModifierSourcePersona("Tomori (Ren)", personaByNickname);

    expect(result?.persona.persona_id).toBe(123);
    expect(result?.displayName).toBe("Ren (Tomori)");
  });

  it("allows active render-modifier speaker labels through the speaker guard", () => {
    const sourceNames = collectRenderModifierSourceNames("Ren", ["Tomori"]);

    expect(isAllowedRenderModifierSpeakerLabel("Ren (Obonya)", sourceNames)).toBe(true);
    expect(isAllowedRenderModifierSpeakerLabel("Tomori (Obonya)", sourceNames)).toBe(true);
    expect(isAllowedRenderModifierSpeakerLabel("Other (Obonya)", sourceNames)).toBe(false);
  });
});

describe("generic leading speaker label parser (opening-label leak guard)", () => {
  it("parses a decorated label with any speaker name", () => {
    const result = parseLeadingGenericSpeakerLabel('Chris (smug): Bro said "love you"');

    expect(result).toEqual({
      sourceName: "Chris",
      modifier: "smug",
      body: 'Bro said "love you"',
      matchedPrefix: "Chris (smug): ",
    });
  });

  it("parses a plain label with any speaker name", () => {
    const result = parseLeadingGenericSpeakerLabel("Chris: overreaction, dont you think?");

    expect(result).toEqual({
      sourceName: "Chris",
      modifier: undefined,
      body: "overreaction, dont you think?",
      matchedPrefix: "Chris: ",
    });
  });

  it("parses full-width colon labels", () => {
    const result = parseLeadingGenericSpeakerLabel("クリス (照れ)： うるさい！");

    expect(result?.sourceName).toBe("クリス");
    expect(result?.modifier).toBe("照れ");
    expect(result?.body).toBe("うるさい！");
  });

  it("still parses prose-shaped openings, leaving known-name filtering to the caller", () => {
    // "Note:" IS label-shaped: the segment processor only fires when the name matches a
    // known conversation participant, which "Note" never will.
    const result = parseLeadingGenericSpeakerLabel("Note: remember to hydrate");

    expect(result?.sourceName).toBe("Note");
    expect(matchesRenderModifierName("Note", ["Chris", "Tomori"])).toBe(false);
  });

  it("ignores code fences, list items, blockquotes, and headings", () => {
    expect(parseLeadingGenericSpeakerLabel("```\nChris (smug): hi\n```")).toBeNull();
    expect(parseLeadingGenericSpeakerLabel("- Chris (smug): quoted line")).toBeNull();
    expect(parseLeadingGenericSpeakerLabel("1. Chris (smug): quoted line")).toBeNull();
    expect(parseLeadingGenericSpeakerLabel("> Chris: quoted line")).toBeNull();
    expect(parseLeadingGenericSpeakerLabel("# Chris: heading")).toBeNull();
  });

  it("ignores names opening with link/mention/timestamp brackets or without word characters", () => {
    expect(parseLeadingGenericSpeakerLabel("<@123456789012345678>: hi")).toBeNull();
    expect(parseLeadingGenericSpeakerLabel("[Chris]: hi")).toBeNull();
    expect(parseLeadingGenericSpeakerLabel("!!!: hi")).toBeNull();
    expect(parseLeadingGenericSpeakerLabel(":thumbsup: nice")).toBeNull();
  });

  it("rejects overlong modifiers in the decorated shape", () => {
    expect(parseLeadingGenericSpeakerLabel(`Chris (${"a".repeat(65)}): hi`)).toBeNull();
  });

  it("matches names case-insensitively via render-modifier normalization", () => {
    expect(matchesRenderModifierName("chris", ["Chris"])).toBe(true);
    expect(matchesRenderModifierName("CHRIS", ["chris"])).toBe(true);
    expect(matchesRenderModifierName("Matt", ["Chris"])).toBe(false);
    expect(matchesRenderModifierName("", ["Chris"])).toBe(false);
  });
});
