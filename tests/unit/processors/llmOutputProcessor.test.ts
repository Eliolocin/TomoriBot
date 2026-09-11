import { describe, expect, it } from "bun:test";
import {
  cleanLLMOutput,
  findMarkdownCodeRanges,
  isGenericSpeakerStopLabel,
  stripLeakedOwnNameLabels,
  truncateBeforeGenericSpeakerLine,
} from "@/utils/text/processors/llmOutputProcessor";
import { isAllowedRenderModifierSpeakerLabel } from "@/utils/discord/renderModifierParser";
import { buildPersonaMentionCatalog } from "@/utils/text/personaMentionHandles";

const PRESERVE_UNRESOLVED_EMOJI_SHORTCODES_ENV = "EMOJI_PRESERVE_UNRESOLVED_SHORTCODES";

function withPreserveUnresolvedShortcodes(value: string | undefined, assertion: () => void): void {
  const previous = process.env[PRESERVE_UNRESOLVED_EMOJI_SHORTCODES_ENV];
  if (value === undefined) {
    delete process.env[PRESERVE_UNRESOLVED_EMOJI_SHORTCODES_ENV];
  } else {
    process.env[PRESERVE_UNRESOLVED_EMOJI_SHORTCODES_ENV] = value;
  }

  try {
    assertion();
  } finally {
    if (previous === undefined) {
      delete process.env[PRESERVE_UNRESOLVED_EMOJI_SHORTCODES_ENV];
    } else {
      process.env[PRESERVE_UNRESOLVED_EMOJI_SHORTCODES_ENV] = previous;
    }
  }
}

describe("cleanLLMOutput", () => {
  const emojiStrings = ["<:hiroi1:1401852839730348033>", "<a:dance:123456789012345678>"];

  it("converts known server emoji shortcodes to Discord emoji tags", () => {
    expect(cleanLLMOutput(":hiroi1:", "Tomori", emojiStrings)).toBe("<:hiroi1:1401852839730348033>");
  });

  it("strips unresolved emoji shortcodes by default when an emoji list is available", () => {
    withPreserveUnresolvedShortcodes(undefined, () => {
      expect(cleanLLMOutput(":LILYESHYPER:\n:GOTTEM:", "Tomori", emojiStrings)).toBe("");
    });
  });

  it("strips unresolved emoji shortcodes by default when no emoji list is available", () => {
    withPreserveUnresolvedShortcodes(undefined, () => {
      expect(cleanLLMOutput("hello :LILYESHYPER:", "Tomori", [])).toBe("hello");
    });
  });

  it("strips unresolved Discord emoji tags by default", () => {
    withPreserveUnresolvedShortcodes(undefined, () => {
      expect(cleanLLMOutput("<:unknown:123456789012345678>", "Tomori", emojiStrings)).toBe("");
    });
  });

  it("preserves unresolved emoji shortcodes when preservation is enabled", () => {
    withPreserveUnresolvedShortcodes("true", () => {
      expect(cleanLLMOutput(":LILYESHYPER:\n:GOTTEM:", "Tomori", emojiStrings)).toBe(":LILYESHYPER:\n:GOTTEM:");
    });
  });

  it("preserves unresolved emoji shortcodes without an emoji list when preservation is enabled", () => {
    withPreserveUnresolvedShortcodes("true", () => {
      expect(cleanLLMOutput("hello :LILYESHYPER:", "Tomori", [])).toBe("hello :LILYESHYPER:");
    });
  });

  it("preserves unresolved Discord emoji tags when preservation is enabled", () => {
    withPreserveUnresolvedShortcodes("true", () => {
      expect(cleanLLMOutput("<:unknown:123456789012345678>", "Tomori", emojiStrings)).toBe(
        "<:unknown:123456789012345678>",
      );
    });
  });

  it("strips emoji shortcodes when emoji usage is disabled", () => {
    withPreserveUnresolvedShortcodes("true", () => {
      expect(cleanLLMOutput("hello :LILYESHYPER:", "Tomori", emojiStrings, false)).toBe("hello");
    });
  });

  it("strips a self-label that the emoji shortcode→tag conversion space-separated from its emoji", () => {
    // End-to-end: shortcode ":NagatoroSmug:" is converted (with inserted spaces) BEFORE the leak
    // handler runs, so the second "Tsukushi:" arrives as "<:NagatoroSmug:id> Tsukushi:".
    const emojiList = ["<:NagatoroSmug:1382568815900098660>"];
    const cleaned = cleanLLMOutput(
      "Tsukushi: :NagatoroSmug:Tsukushi: Staying up late. How devoted.",
      "Tsukushi",
      emojiList,
    );
    expect(cleaned).not.toContain("Tsukushi:");
    expect(cleaned).toContain("<:NagatoroSmug:1382568815900098660>");
    expect(cleaned).toContain("Staying up late.");
  });

  it("preserves known persona @trigger text after normal output cleanup", () => {
    const personaMentionMap = buildPersonaMentionCatalog([
      { persona_nickname: "Shy Tomori", trigger_words: ["lilya"] },
    ]).mentionMap;
    const cleaned = cleanLLMOutput(
      "Tomori: I should ask @(Shy Tomori).",
      "Tomori",
      [],
      true,
      new Map(),
      new Set(),
      undefined,
      [],
      personaMentionMap,
    );

    expect(cleaned).toBe("I should ask @lilya.");
  });
});

describe("stripLeakedOwnNameLabels", () => {
  // Branch A: the model opened its turn with its own label: real speech. The starter is dropped
  // and any *later* self-labels are collapsed at their turn boundary, PRESERVING preceding text.
  describe("opened with own label (real turn — keep preceding, collapse later labels)", () => {
    it("removes the starter label", () => {
      expect(stripLeakedOwnNameLabels("Tomori: hello there", "Tomori").trim()).toBe("hello there");
    });

    it("keeps preceding speech and collapses a later self-label to a newline", () => {
      expect(stripLeakedOwnNameLabels("Tsukushi: exact numbers, Misuzu.Tsukushi: But if you wanted", "Tsukushi")).toBe(
        "exact numbers, Misuzu.\nBut if you wanted",
      );
    });

    it("collapses repeated later self-labels", () => {
      expect(stripLeakedOwnNameLabels("Tsukushi: done.Tsukushi: more.Tsukushi: again", "Tsukushi")).toBe(
        "done.\nmore.\nagain",
      );
    });

    it("handles bold starter and later bold labels", () => {
      expect(stripLeakedOwnNameLabels("**Tomori:** hi.**Tomori:** there", "Tomori")).toBe("hi.\nthere");
    });

    it("drops a trailing self-label after keeping the real speech", () => {
      expect(stripLeakedOwnNameLabels("Bella: my favorite chew toy!Bella:", "Bella").trim()).toBe(
        "my favorite chew toy!",
      );
    });

    it("collapses a self-label glued to an emoji's closing bracket", () => {
      expect(
        stripLeakedOwnNameLabels(
          "Tsukushi: Such an honest girl. <:TomoriSmug:1476754434078801980>Tsukushi: It's adorable",
          "Tsukushi",
        ),
      ).toBe("Such an honest girl. <:TomoriSmug:1476754434078801980>\nIt's adorable");
    });

    it("collapses a self-label glued to a non-alphanumeric char", () => {
      expect(stripLeakedOwnNameLabels("Tomori: (an aside)Tomori: back to it", "Tomori")).toBe("(an aside)\nback to it");
    });

    it("collapses a self-label space-separated from a preceding emoji tag", () => {
      // Mirrors the post-conversion form: the emoji shortcode→tag step inserts a space, so the leak
      // arrives as "<:Emoji:id> Tsukushi:" rather than glued.
      expect(
        stripLeakedOwnNameLabels(
          "Tsukushi: <:NagatoroSmug:1382568815900098660> Tsukushi: Staying up late. How devoted.",
          "Tsukushi",
        ),
      ).toBe("<:NagatoroSmug:1382568815900098660>\nStaying up late. How devoted.");
    });
  });

  // Branch B: the model did NOT open with its own label: content before the first leak-shaped
  // label is a leaked "thought" and is dropped, keeping only the real response.
  describe("did not open with own label (leaked thought — cut the preamble)", () => {
    it("cuts a thought glued to the re-introduction label", () => {
      expect(stripLeakedOwnNameLabels("the answer is 30Bella: I think the answer is 30!", "Bella")).toBe(
        "I think the answer is 30!",
      );
    });

    it("cuts a thought ended by a newline before the label", () => {
      expect(stripLeakedOwnNameLabels("reasoning here\nTomori: hi", "Tomori")).toBe("hi");
    });

    it("cuts a thought ended by sentence punctuation before the label", () => {
      expect(stripLeakedOwnNameLabels("she scored 100.Tomori: nice", "Tomori")).toBe("nice");
    });

    it("keeps the text and drops the bare label when nothing follows (trailing-only)", () => {
      expect(stripLeakedOwnNameLabels("my favorite chew toy!Bella:", "Bella").trim()).toBe("my favorite chew toy!");
    });

    it("cuts a thought glued to the label via an emoji bracket", () => {
      expect(stripLeakedOwnNameLabels("hmm let me think<:smile:123456789012345678>Bella: the answer", "Bella")).toBe(
        "the answer",
      );
    });
  });

  // Multi-name personas: a bundled persona answers to its webhook nickname ("Lilya") AND its
  // lore/default name ("Tomori"), so the model opens with a chain of both labels.
  describe("alias names (multi-name persona opening chain)", () => {
    it("peels a leading lore-name + nickname chain", () => {
      expect(stripLeakedOwnNameLabels("Tomori: Lilya: Zaya-senpai...!", "Lilya", ["Tomori"]).trim()).toBe(
        "Zaya-senpai...!",
      );
    });

    it("peels the chain regardless of label order", () => {
      expect(stripLeakedOwnNameLabels("Lilya: Tomori: hi there", "Lilya", ["Tomori"]).trim()).toBe("hi there");
    });

    it("peels a leading alias label even when the nickname never appears", () => {
      expect(stripLeakedOwnNameLabels("Tomori: just the lore name", "Lilya", ["Tomori"]).trim()).toBe(
        "just the lore name",
      );
    });

    it("matches aliases case-insensitively", () => {
      expect(stripLeakedOwnNameLabels("tomori: lilya: hey", "Lilya", ["Tomori"]).trim()).toBe("hey");
    });

    it("still collapses a later self-label after an alias opening chain", () => {
      expect(stripLeakedOwnNameLabels("Tomori: Lilya: hi.Lilya: bye", "Lilya", ["Tomori"])).toBe("hi.\nbye");
    });

    it("does not strip an alias used mid-prose at a non-boundary", () => {
      const text = "Lilya: my sister, Tomori: is around";
      expect(stripLeakedOwnNameLabels(text, "Lilya", ["Tomori"]).trim()).toBe("my sister, Tomori: is around");
    });

    it("behaves identically to the no-alias path when aliases are empty", () => {
      expect(stripLeakedOwnNameLabels("Tomori: Lilya: hi", "Lilya", [])).toBe("Tomori: Lilya: hi");
    });
  });

  // Identity-macro labels: the model sometimes labels its own turn with the template syntax
  // ("{bot}:") instead of the resolved name. Stripped only at the opening; mid-text macros are
  // legitimate content whenever the persona is drafting a preset or system prompt for a user.
  describe("identity-macro opening labels", () => {
    it("peels a leading {bot} label", () => {
      expect(stripLeakedOwnNameLabels("{bot}: hello there", "Tomori").trim()).toBe("hello there");
    });

    it("peels a leading double-brace {{char}} label", () => {
      expect(stripLeakedOwnNameLabels("{{char}}: hello there", "Tomori").trim()).toBe("hello there");
    });

    it("peels a leading bold macro label", () => {
      expect(stripLeakedOwnNameLabels("**{bot}:** hello there", "Tomori").trim()).toBe("hello there");
    });

    it("peels a mixed macro + real-name opening chain", () => {
      expect(stripLeakedOwnNameLabels("{bot}: Tomori: hello there", "Tomori").trim()).toBe("hello there");
    });

    it("peels a leading {user} label rather than posting it verbatim", () => {
      expect(stripLeakedOwnNameLabels("{user}: hello there", "Tomori").trim()).toBe("hello there");
    });

    it("preserves macros in drafted prose that does not open with a macro label", () => {
      const draft = "Sure! Here's a preset:\n{{char}}: Hi!\n{{user}}: Hey.";
      expect(stripLeakedOwnNameLabels(draft, "Tomori")).toBe(draft);
    });

    it("preserves a macro used inline mid-sentence", () => {
      const text = "Use {bot} to refer to yourself and {user} for the target.";
      expect(stripLeakedOwnNameLabels(text, "Tomori")).toBe(text);
    });

    it("preserves a fenced preset draft opening with a macro label", () => {
      const draft = "```\n{{char}}: Hi!\n```";
      expect(stripLeakedOwnNameLabels(draft, "Tomori")).toBe(draft);
    });

    it("does not treat an unrelated braced word as a turn label", () => {
      const text = "{persona}: not an identity macro";
      expect(stripLeakedOwnNameLabels(text, "Tomori")).toBe(text);
    });
  });

  /**
   * Safety net for the decorated render-modifier grammar ("Tomori (silly):"). Only a label opening a
   * segment is consumed by parseLeadingRenderModifier; one stranded mid-body because a buffer
   * boundary shifted used to reach Discord as visible text.
   */
  describe("decorated render-modifier labels", () => {
    it("strips a stranded mid-body label while keeping the reply before it", () => {
      expect(stripLeakedOwnNameLabels("bet sending the vibes.\ntomori (silly): double message", "tomori")).toBe(
        "bet sending the vibes.\ndouble message",
      );
    });

    it("removes a decorated starter label", () => {
      expect(stripLeakedOwnNameLabels("Tomori (shy): h-hello", "Tomori").trim()).toBe("h-hello");
    });

    it("removes a decorated alias starter without exposing it to the preamble branch", () => {
      expect(stripLeakedOwnNameLabels("Tomori (angry): actual reply", "Lilya", ["Tomori"]).trim()).toBe("actual reply");
    });

    it("keeps an alias-decorated first line when a plain active-name label follows", () => {
      expect(stripLeakedOwnNameLabels("Tomori (angry): first reply\nLilya: second reply", "Lilya", ["Tomori"])).toBe(
        "first reply\nsecond reply",
      );
    });

    it("matches full-width colons and bold decorated labels", () => {
      expect(stripLeakedOwnNameLabels("Tomori (shy)： h-hello", "Tomori").trim()).toBe("h-hello");
      expect(stripLeakedOwnNameLabels("**Tomori (shy):** h-hello", "Tomori").trim()).toBe("h-hello");
      expect(stripLeakedOwnNameLabels("**Tomori (shy)**： h-hello", "Tomori").trim()).toBe("h-hello");
    });

    /**
     * Opening decorated must land on branch A. On branch B the leaked-preamble pass cuts everything
     * before the label it matches, which would delete the real reply preceding a stray one.
     */
    it("keeps text preceding a stranded label rather than treating it as a leaked preamble", () => {
      const result = stripLeakedOwnNameLabels("first real line here.\nTomori (mad): second line", "Tomori");

      expect(result).toContain("first real line here.");
      expect(result).toContain("second line");
      expect(result).not.toContain("(mad)");
    });

    it("leaves another character's decorated label alone so quoted dialogue survives", () => {
      const text = "I don't think Ren would say\nRen (lovestruck): I love you!\nbecause that's weird";
      expect(stripLeakedOwnNameLabels(text, "Tomori")).toBe(text);
    });

    it("does not strip a parenthetical that is not a label", () => {
      const text = "Tomori (the one you know) is here";
      expect(stripLeakedOwnNameLabels(text, "Tomori")).toBe(text);
    });
  });

  describe("preserves legitimate Name: usages", () => {
    it("does not strip a hyphen list item", () => {
      const text = "Power levels:\n- Tsukushi: 100\n- Bella: 80";
      expect(stripLeakedOwnNameLabels(text, "Tsukushi")).toBe(text);
    });

    it("does not strip a numbered list item", () => {
      const text = "1. Tsukushi: 100\n2. Bella: 80";
      expect(stripLeakedOwnNameLabels(text, "Tsukushi")).toBe(text);
    });

    it("does not strip a numbered list item at the very start of text", () => {
      expect(stripLeakedOwnNameLabels("1. Tomori: 100", "Tomori")).toBe("1. Tomori: 100");
    });

    it("does not strip an indented numbered list item", () => {
      const text = "Scores:\n   12. Tsukushi: 100";
      expect(stripLeakedOwnNameLabels(text, "Tsukushi")).toBe(text);
    });

    it("does not strip the name after a comma in prose", () => {
      const text = "Remember this, Tsukushi: never give up";
      expect(stripLeakedOwnNameLabels(text, "Tsukushi")).toBe(text);
    });

    it("does not strip another speaker's label (own-name only)", () => {
      const text = "done.Bella: hi";
      expect(stripLeakedOwnNameLabels(text, "Tsukushi")).toBe(text);
    });

    it("does not strip labels inside a code block", () => {
      const text = "```\nTomori: in code\n```";
      expect(stripLeakedOwnNameLabels(text, "Tomori")).toBe(text);
    });

    it("does not strip labels inside an inline code span", () => {
      const text = "see `Tomori: example` here";
      expect(stripLeakedOwnNameLabels(text, "Tomori")).toBe(text);
    });

    it("does not mangle an emoji named exactly like the persona", () => {
      // "<:Tomori:id>" contains "Tomori:" preceded by a colon, so excluded from the glued char so the
      // emoji is preserved, while the genuinely leaked label after ">" is still collapsed.
      expect(stripLeakedOwnNameLabels("Tomori: hi <:Tomori:123456789012345678> there", "Tomori").trim()).toBe(
        "hi <:Tomori:123456789012345678> there",
      );
    });

    it("returns text unchanged when no label is present", () => {
      expect(stripLeakedOwnNameLabels("just normal text", "Tomori")).toBe("just normal text");
    });

    it("returns text unchanged for an empty bot name", () => {
      expect(stripLeakedOwnNameLabels("done.Tomori: hi", "  ")).toBe("done.Tomori: hi");
    });
  });
});

describe("findMarkdownCodeRanges", () => {
  it("returns empty array when no backticks present", () => {
    expect(findMarkdownCodeRanges("hello world")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(findMarkdownCodeRanges("")).toEqual([]);
  });

  describe("inline code spans", () => {
    it("detects a single inline code span", () => {
      const ranges = findMarkdownCodeRanges("`code`");
      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toEqual({ start: 0, end: 6 });
    });

    it("detects multiple inline code spans", () => {
      const ranges = findMarkdownCodeRanges("`a` and `b`");
      expect(ranges).toHaveLength(2);
      expect(ranges[0]).toEqual({ start: 0, end: 3 });
      expect(ranges[1]).toEqual({ start: 8, end: 11 });
    });

    it("extends to end of string on unclosed backtick", () => {
      const text = "`open";
      const ranges = findMarkdownCodeRanges(text);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].start).toBe(0);
      expect(ranges[0].end).toBe(text.length);
    });
  });

  describe("triple-backtick code blocks", () => {
    it("detects a fenced code block", () => {
      const text = "```\nhello\n```";
      const ranges = findMarkdownCodeRanges(text);
      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toEqual({ start: 0, end: text.length });
    });

    it("detects code block with language tag", () => {
      const text = "```ts\nconst x = 1;\n```";
      const ranges = findMarkdownCodeRanges(text);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].start).toBe(0);
      expect(ranges[0].end).toBe(text.length);
    });
  });

  describe("mixed inline and block", () => {
    it("detects both inline code and a code block in the same string", () => {
      const text = "`inline` then ```block``` here";
      const ranges = findMarkdownCodeRanges(text);
      expect(ranges).toHaveLength(2);
    });
  });
});

describe("isGenericSpeakerStopLabel", () => {
  describe("valid speaker labels", () => {
    it("accepts 'User'", () => {
      expect(isGenericSpeakerStopLabel("User")).toBe(true);
    });
    it("accepts 'Assistant'", () => {
      expect(isGenericSpeakerStopLabel("Assistant")).toBe(true);
    });
    it("accepts labels with underscores", () => {
      expect(isGenericSpeakerStopLabel("Character_Name")).toBe(true);
    });
    it("accepts labels with numbers", () => {
      expect(isGenericSpeakerStopLabel("Speaker2")).toBe(true);
    });
    it("accepts labels with leading/trailing whitespace (trimmed internally)", () => {
      expect(isGenericSpeakerStopLabel("  User  ")).toBe(true);
    });
  });

  describe("invalid speaker labels", () => {
    it("rejects empty string", () => {
      expect(isGenericSpeakerStopLabel("")).toBe(false);
    });
    it("rejects whitespace-only string", () => {
      expect(isGenericSpeakerStopLabel("   ")).toBe(false);
    });
    it("rejects labels starting with '['", () => {
      expect(isGenericSpeakerStopLabel("[User]")).toBe(false);
    });
    it("rejects labels starting with '<'", () => {
      expect(isGenericSpeakerStopLabel("<tag>")).toBe(false);
    });
    it("rejects labels longer than 64 characters", () => {
      expect(isGenericSpeakerStopLabel("a".repeat(65))).toBe(false);
    });
    it("accepts labels exactly 64 characters long", () => {
      expect(isGenericSpeakerStopLabel("a".repeat(64))).toBe(true);
    });
  });
});

describe("truncateBeforeGenericSpeakerLine", () => {
  describe("no speaker present — pass through unchanged", () => {
    it("returns text unchanged when no speaker line found", () => {
      const result = truncateBeforeGenericSpeakerLine("Hello world");
      expect(result).toEqual({ text: "Hello world", stopTriggered: false });
    });

    it("returns empty string unchanged", () => {
      const result = truncateBeforeGenericSpeakerLine("");
      expect(result).toEqual({ text: "", stopTriggered: false });
    });

    it("does not trigger on a lone colon mid-sentence", () => {
      const result = truncateBeforeGenericSpeakerLine("time: 3pm");
      expect(result.stopTriggered).toBe(false);
    });
  });

  describe("speaker at a newline — truncate", () => {
    it("truncates at '\\nUser:'", () => {
      const result = truncateBeforeGenericSpeakerLine("Some text\nUser: more text");
      expect(result.text).toBe("Some text");
      expect(result.stopTriggered).toBe(true);
      expect(result.matchedSpeaker).toBe("User");
    });

    it("truncates at '\\nAssistant:'", () => {
      const result = truncateBeforeGenericSpeakerLine("Reply here\nAssistant: continuation");
      expect(result.text).toBe("Reply here");
      expect(result.stopTriggered).toBe(true);
      expect(result.matchedSpeaker).toBe("Assistant");
    });

    it("truncates at the first speaker line when multiple are present", () => {
      const result = truncateBeforeGenericSpeakerLine("Intro\nUser: A\nAssistant: B");
      expect(result.text).toBe("Intro");
      expect(result.matchedSpeaker).toBe("User");
    });
  });

  describe("speaker inside code block — skip", () => {
    it("does not trigger on speaker label inside triple-backtick block", () => {
      const text = "```\nUser: in code\n```\nActual text";
      const result = truncateBeforeGenericSpeakerLine(text);
      expect(result.stopTriggered).toBe(false);
      expect(result.text).toBe(text);
    });

    it("does not trigger on speaker label inside inline code", () => {
      const text = "Here is `User: example` and more text";
      const result = truncateBeforeGenericSpeakerLine(text);
      expect(result.stopTriggered).toBe(false);
    });
  });

  describe("includeStart option — also checks first line", () => {
    it("triggers on first-line speaker when includeStart is true", () => {
      const result = truncateBeforeGenericSpeakerLine("User: starts here", { includeStart: true });
      expect(result.stopTriggered).toBe(true);
      expect(result.matchedSpeaker).toBe("User");
      expect(result.text).toBe("");
    });

    it("does NOT trigger on first-line speaker when includeStart is false (default)", () => {
      const result = truncateBeforeGenericSpeakerLine("User: starts here");
      expect(result.stopTriggered).toBe(false);
    });
  });

  describe("allowed speaker labels", () => {
    it("does not stop on active render-modifier syntax", () => {
      const text = "Ren (Obonya): hi\nOther: stop here";
      const result = truncateBeforeGenericSpeakerLine(text, {
        includeStart: true,
        isAllowedSpeakerLabel: (label) => isAllowedRenderModifierSpeakerLabel(label, ["Ren"]),
      });

      expect(result.stopTriggered).toBe(true);
      expect(result.matchedSpeaker).toBe("Other");
      expect(result.text).toBe("Ren (Obonya): hi");
    });

    it("still stops on render-modifier syntax from another speaker", () => {
      const result = truncateBeforeGenericSpeakerLine("Other (Obonya): hi", {
        includeStart: true,
        isAllowedSpeakerLabel: (label) => isAllowedRenderModifierSpeakerLabel(label, ["Ren"]),
      });

      expect(result.stopTriggered).toBe(true);
      expect(result.matchedSpeaker).toBe("Other (Obonya)");
    });
  });
});
