import { describe, expect, it } from "bun:test";
import {
  normalizeCustomEmojisForLlm,
  replaceMentionHandles,
  sanitizeUnknownTemplatePlaceholders,
} from "@/utils/text/processors/mentionProcessor";
import { buildPersonaMentionCatalog } from "@/utils/text/personaMentionHandles";

describe("sanitizeUnknownTemplatePlaceholders", () => {
  describe("single-brace allowed vars", () => {
    it("preserves {user}", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{user}")).toBe("{user}");
    });
    it("preserves {bot}", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{bot}")).toBe("{bot}");
    });
    it("preserves {char}", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{char}")).toBe("{char}");
    });
    it("preserves formatted user and address term macros", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{user_formatted} {user_term}")).toBe("{user_formatted} {user_term}");
    });
    it("is case-insensitive for allowed vars", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{User}")).toBe("{User}");
      expect(sanitizeUnknownTemplatePlaceholders("{BOT}")).toBe("{BOT}");
    });
  });

  describe("single-brace unknown vars — braces stripped, inner word kept", () => {
    it("strips {username}", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{username}")).toBe("username");
    });
    it("strips {name}", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{name}")).toBe("name");
    });
    it("strips {assistant}", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{assistant}")).toBe("assistant");
    });
  });

  describe("double-brace allowed vars", () => {
    it("preserves {{user}}", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{{user}}")).toBe("{{user}}");
    });
    it("preserves {{bot}}", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{{bot}}")).toBe("{{bot}}");
    });
    it("preserves {{char}}", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{{char}}")).toBe("{{char}}");
    });
    it("preserves double-brace formatted user and address term macros", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{{user_formatted}} {{user_term}}")).toBe(
        "{{user_formatted}} {{user_term}}",
      );
    });
  });

  describe("double-brace unknown vars — braces stripped", () => {
    it("strips {{username}}", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{{username}}")).toBe("username");
    });
    it("strips {{name}}", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{{name}}")).toBe("name");
    });
  });

  describe("mixed text", () => {
    it("strips unknown var while preserving allowed var in same string", () => {
      expect(sanitizeUnknownTemplatePlaceholders("Hello {user}, your name is {username}")).toBe(
        "Hello {user}, your name is username",
      );
    });
    it("handles multiple unknown vars in sequence", () => {
      expect(sanitizeUnknownTemplatePlaceholders("{first} and {last}")).toBe("first and last");
    });
    it("handles text with no template vars unchanged", () => {
      expect(sanitizeUnknownTemplatePlaceholders("plain text")).toBe("plain text");
    });
    it("handles empty string", () => {
      expect(sanitizeUnknownTemplatePlaceholders("")).toBe("");
    });
  });
});

describe("normalizeCustomEmojisForLlm", () => {
  describe("emoji normalization", () => {
    it("converts static custom emoji to :name:", () => {
      expect(normalizeCustomEmojisForLlm("<:wave:123456789012345678>")).toBe(":wave:");
    });
    it("converts animated custom emoji to :name:", () => {
      expect(normalizeCustomEmojisForLlm("<a:spin:123456789012345678>")).toBe(":spin:");
    });
    it("converts multiple emojis in one string", () => {
      expect(normalizeCustomEmojisForLlm("<:hi:123456789012345678> and <:bye:987654321098765432>")).toBe(
        ":hi: and :bye:",
      );
    });
    it("leaves non-emoji text unchanged", () => {
      expect(normalizeCustomEmojisForLlm("hello world")).toBe("hello world");
    });
    it("ignores emoji with fewer than 17 digits (not a valid snowflake)", () => {
      expect(normalizeCustomEmojisForLlm("<:wave:12345>")).toBe("<:wave:12345>");
    });
  });

  describe("code block protection", () => {
    it("does not convert emoji inside triple-backtick code block", () => {
      const input = "```\n<:wave:123456789012345678>\n```";
      expect(normalizeCustomEmojisForLlm(input)).toBe(input);
    });
    it("does not convert emoji inside inline code", () => {
      const input = "`<:wave:123456789012345678>`";
      expect(normalizeCustomEmojisForLlm(input)).toBe(input);
    });
    it("converts emoji outside code block while preserving code block", () => {
      const result = normalizeCustomEmojisForLlm("<:hi:123456789012345678> ``` code ``` <:bye:987654321098765432>");
      expect(result).toBe(":hi: ``` code ``` :bye:");
    });
  });

  describe("edge cases", () => {
    it("returns empty string unchanged", () => {
      expect(normalizeCustomEmojisForLlm("")).toBe("");
    });
    it("handles text with no emojis", () => {
      expect(normalizeCustomEmojisForLlm("just text here")).toBe("just text here");
    });
  });
});

describe("replaceMentionHandles", () => {
  const mentionMap = new Map([
    ["alice", ["111111111111111111"]],
    ["bob", ["222222222222222222"]],
    ["ambiguous", ["333333333333333333", "444444444444444444"]], // two IDs, so ambiguous
  ]);
  const mentionIdSet = new Set(["111111111111111111", "222222222222222222"]);

  describe("passthrough when no map provided", () => {
    it("returns text unchanged when mentionMap is undefined", () => {
      expect(replaceMentionHandles("@{alice}")).toBe("@{alice}");
    });
    it("returns text unchanged when mentionMap is empty", () => {
      expect(replaceMentionHandles("@{alice}", new Map())).toBe("@{alice}");
    });
  });

  describe("@{name} format", () => {
    it("resolves known name to <@id>", () => {
      expect(replaceMentionHandles("hello @{alice}!", mentionMap, mentionIdSet)).toBe("hello <@111111111111111111>!");
    });
    it("is case-insensitive for name lookup", () => {
      expect(replaceMentionHandles("@{Alice}", mentionMap, mentionIdSet)).toBe("<@111111111111111111>");
    });
    it("falls back to bare name for unknown handle", () => {
      expect(replaceMentionHandles("@{unknown}", mentionMap, mentionIdSet)).toBe("unknown");
    });
    it("falls back to bare name when handle is ambiguous (multiple IDs)", () => {
      expect(replaceMentionHandles("@{ambiguous}", mentionMap, mentionIdSet)).toBe("ambiguous");
    });
  });

  describe("@{name|id} pipe-id format", () => {
    it("resolves when id is in mentionIdSet", () => {
      expect(replaceMentionHandles("@{alice|111111111111111111}", mentionMap, mentionIdSet)).toBe(
        "<@111111111111111111>",
      );
    });
  });

  describe("@(name) LLM hallucination — parentheses", () => {
    it("resolves known name", () => {
      expect(replaceMentionHandles("@(alice) hi", mentionMap, mentionIdSet)).toBe("<@111111111111111111> hi");
    });
    it("falls back to bare name for unknown", () => {
      expect(replaceMentionHandles("@(nobody)", mentionMap, mentionIdSet)).toBe("nobody");
    });
  });

  describe("@[name] LLM hallucination — square brackets", () => {
    it("resolves known name", () => {
      expect(replaceMentionHandles("@[bob]", mentionMap, mentionIdSet)).toBe("<@222222222222222222>");
    });
  });

  describe("bare @name format", () => {
    it("resolves known single-match name", () => {
      const result = replaceMentionHandles("hey @alice", mentionMap, mentionIdSet);
      expect(result).toBe("hey <@111111111111111111>");
    });
    it("strips @ for unknown name (returns bare word)", () => {
      const result = replaceMentionHandles("hey @nobody", mentionMap, mentionIdSet);
      expect(result).toBe("hey nobody");
    });
    it("does not resolve @everyone", () => {
      expect(replaceMentionHandles("@everyone", mentionMap, mentionIdSet)).toBe("@everyone");
    });
    it("does not resolve @here", () => {
      expect(replaceMentionHandles("@here", mentionMap, mentionIdSet)).toBe("@here");
    });
  });

  describe("@name|id format (no braces)", () => {
    it("resolves when id is known", () => {
      const result = replaceMentionHandles("@alice|111111111111111111", mentionMap, mentionIdSet);
      expect(result).toBe("<@111111111111111111>");
    });
  });

  describe("persona trigger preservation", () => {
    const personaMentionMap = buildPersonaMentionCatalog([
      { persona_nickname: "Shy Tomori", trigger_words: ["lilya"] },
      { persona_nickname: "Ren", trigger_words: ["ren"] },
    ]).mentionMap;

    it("canonicalizes braced persona nicknames to @trigger text", () => {
      expect(replaceMentionHandles("go ask @{Shy Tomori}", mentionMap, mentionIdSet, personaMentionMap)).toBe(
        "go ask @lilya",
      );
    });

    it("canonicalizes common hallucinated mention styles", () => {
      expect(replaceMentionHandles("@(Shy Tomori) @[Ren] @lilya", mentionMap, mentionIdSet, personaMentionMap)).toBe(
        "@lilya @ren @lilya",
      );
    });

    it("canonicalizes bare multi-word persona aliases before normal mention cleanup", () => {
      expect(replaceMentionHandles("go ask @Shy Tomori now", mentionMap, mentionIdSet, personaMentionMap)).toBe(
        "go ask @lilya now",
      );
    });

    it("keeps Discord user mentions ahead of persona trigger aliases", () => {
      const overlappingPersonas = buildPersonaMentionCatalog([
        { persona_nickname: "Alice", trigger_words: ["alice"] },
      ]).mentionMap;
      expect(replaceMentionHandles("hey @alice", mentionMap, mentionIdSet, overlappingPersonas)).toBe(
        "hey <@111111111111111111>",
      );
    });

    it("does not preserve ambiguous persona aliases", () => {
      const ambiguousPersonas = buildPersonaMentionCatalog([
        { persona_nickname: "Ren", trigger_words: ["ren"] },
        { persona_nickname: "Ren", trigger_words: ["renee"] },
      ]).mentionMap;
      expect(replaceMentionHandles("hey @Ren", new Map(), new Set(), ambiguousPersonas)).toBe("hey Ren");
    });
  });

  describe("code block protection", () => {
    it("does not resolve mention inside triple-backtick block", () => {
      const input = "```\n@{alice}\n```";
      expect(replaceMentionHandles(input, mentionMap, mentionIdSet)).toBe(input);
    });
    it("does not resolve mention inside inline code", () => {
      const input = "`@{alice}`";
      expect(replaceMentionHandles(input, mentionMap, mentionIdSet)).toBe(input);
    });
    it("resolves mention outside code block, leaves one inside untouched", () => {
      const result = replaceMentionHandles("@{alice} said `@{bob}`", mentionMap, mentionIdSet);
      expect(result).toBe("<@111111111111111111> said `@{bob}`");
    });
  });
});
