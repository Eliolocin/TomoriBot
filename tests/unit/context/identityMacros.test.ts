import { describe, expect, it } from "bun:test";
import type { Client } from "discord.js";
import { HumanizerDegree, type AssembledServerConfig, type TomoriState } from "@/types/db/schema";
import { convertMentions } from "@/utils/text/context/mentionNormalizer";
import { appendDialogueHistoryContext } from "@/utils/text/context/dialogueHistory";
import { buildSampleDialogueContextItems } from "@/utils/text/context/templates";
import type { SimplifiedMessageForContext } from "@/utils/text/context/types";

// These fixtures contain no Discord mentions and always pass an explicit bot nickname, so
// convertMentions never touches the client or the persona repository. That keeps the suite free of
// module mocks (which are process-wide in Bun and leak into later test files).
const CLIENT = {} as Client;

describe("convertMentions — identityMacroMode", () => {
  it("resolves identity macros by default", async () => {
    const result = await convertMentions("{bot} greets {user}", CLIENT, "guild-1", "Alice", "Tomori");
    expect(result).toBe("Tomori greets Alice");
  });

  it("treats {char} as an alias for {bot} when resolving", async () => {
    const result = await convertMentions("{{char}} waves", CLIENT, "guild-1", "Alice", "Tomori");
    expect(result).toBe("Tomori waves");
  });

  it("resolves formatted-name and address-term macros in both brace forms", async () => {
    const result = await convertMentions(
      "{user_formatted}, {{user_term}}!",
      CLIENT,
      "guild-1",
      "Sparrow",
      "Tomori",
      true,
      undefined,
      "resolve",
      { userFormatted: "Master Sparrow-san", userTerm: "fam" },
    );
    expect(result).toBe("Master Sparrow-san, fam!");
  });

  it("leaves identity macros literal in preserve mode", async () => {
    const result = await convertMentions(
      "{bot} greets {user}",
      CLIENT,
      "guild-1",
      "Alice",
      "Tomori",
      true,
      undefined,
      "preserve",
    );
    expect(result).toBe("{bot} greets {user}");
  });

  it("preserves double-brace macros too", async () => {
    const result = await convertMentions(
      "{{char}}: Hi!\n{{user}}: Hey.",
      CLIENT,
      "guild-1",
      "Alice",
      "Tomori",
      true,
      undefined,
      "preserve",
    );
    expect(result).toBe("{{char}}: Hi!\n{{user}}: Hey.");
  });

  it("preserves new identity macros in preserve mode", async () => {
    const result = await convertMentions(
      "{user_formatted} / {{user_term}}",
      CLIENT,
      "guild-1",
      "Sparrow",
      "Tomori",
      true,
      undefined,
      "preserve",
      { userFormatted: "Master Sparrow", userTerm: "fam" },
    );
    expect(result).toBe("{user_formatted} / {{user_term}}");
  });

  it("still normalizes Discord channel links in preserve mode", async () => {
    const result = await convertMentions(
      "see https://discord.com/channels/123456789012345678/234567890123456789 and {bot}",
      CLIENT,
      "guild-1",
      "Alice",
      "Tomori",
      true,
      undefined,
      "preserve",
    );
    expect(result).toContain("<#234567890123456789>");
    expect(result).toContain("{bot}");
  });
});

function makeConfig(): AssembledServerConfig {
  return {
    message_fetch_limit: 80,
    context_note: null,
    context_note_depth: 0,
    humanizer_degree: HumanizerDegree.NONE,
    personal_memories_enabled: true,
    uncensor_unicode_space_enabled: false,
    uncensor_sanitize_enabled: false,
    verbatim_tool_calling_enabled: false,
  } as AssembledServerConfig;
}

function makeTomoriState(): TomoriState {
  return {
    context_note: null,
    context_note_depth: 0,
    llm: { has_tools: false, llm_provider: "custom" },
  } as TomoriState;
}

/** Runs the real convertMentions through the dialogue-history builder for a single message. */
async function buildHistoryText(
  msg: SimplifiedMessageForContext,
  naming?: Pick<
    Parameters<typeof appendDialogueHistoryContext>[0],
    "historyUserLabels" | "historyPersonaMentionLabels"
  >,
): Promise<string> {
  const contextItems: Parameters<typeof appendDialogueHistoryContext>[0]["contextItems"] = [];
  await appendDialogueHistoryContext({
    contextItems,
    client: CLIENT,
    guildId: "guild-1",
    simplifiedMessageHistory: [msg],
    botName: "Tomori",
    tomoriConfig: makeConfig(),
    tomoriState: makeTomoriState(),
    includeTimestamps: false,
    isUserImpersonation: false,
    ...naming,
    uncensorInputOptions: { unicodeSpacesEnabled: false, sanitizeEnabled: false },
    convertMentions,
  });
  return contextItems.flatMap((item) => item.parts.map((part) => (part.type === "text" ? part.text : ""))).join("");
}

function personaMessage(content: string): SimplifiedMessageForContext {
  return {
    id: "message-0",
    authorId: "bot-1",
    authorName: "Tomori",
    authorType: "persona",
    personaName: "Tomori",
    content,
    imageAttachments: [],
    videoAttachments: [],
  };
}

function userMessage(content: string): SimplifiedMessageForContext {
  return {
    id: "message-0",
    authorId: "user-1",
    authorName: "Alice",
    authorType: "user",
    content,
    imageAttachments: [],
    videoAttachments: [],
  };
}

describe("appendDialogueHistoryContext — identity macros in message bodies", () => {
  // The regression: on a model-role line the author label AND the bot nickname are the same
  // string, so resolving macros in the body collapsed BOTH onto the persona's own name.
  it("does not collapse {bot} and {user} onto the persona name in its own message", async () => {
    const text = await buildHistoryText(personaMessage("Write {user} likes dogs, or {bot} greets {user}."));
    expect(text).toBe("Tomori: Write {user} likes dogs, or {bot} greets {user}.");
  });

  it("keeps a drafted preset body verbatim", async () => {
    const draft = "Here's a preset:\n{{char}} is cheerful and always greets {{user}} warmly.";
    const text = await buildHistoryText(personaMessage(draft));
    expect(text).toBe(`Tomori: ${draft}`);
  });

  it("keeps macros literal in a human-typed message", async () => {
    const text = await buildHistoryText(userMessage("what does {bot} mean in a memory?"));
    expect(text).toBe("Alice: what does {bot} mean in a memory?");
  });

  it("still prefixes the resolved author label", async () => {
    const text = await buildHistoryText(userMessage("hello"));
    expect(text.startsWith("Alice: ")).toBe(true);
  });

  it("uses the receiving persona's formatted user speaker label", async () => {
    const text = await buildHistoryText(userMessage("hello"), {
      historyUserLabels: new Map([["user-1", "Master Alice"]]),
    });
    expect(text).toBe("Master Alice: hello");
  });

  it("uses a proven author persona lineage for real historical mentions", async () => {
    const message = { ...personaMessage("Hello <@123456789012345678>"), authorPersonaLineageId: 50 };
    const text = await buildHistoryText(message, {
      historyPersonaMentionLabels: new Map([["50:123456789012345678", "Master Sparrow"]]),
    });
    expect(text).toBe("Tomori: Hello Master Sparrow");
  });
});

// Sample dialogues are authored content stored once and rendered per turn, so they keep the
// default "resolve" mode. They sit next to dialogue history in the assembled prompt but take a
// different code path, and crucially pass the *real* triggerer as `triggererName` which is why
// they never suffered the persona-name collapse. Pinned here so widening "preserve" cannot
// silently turn stored macros into literal braces in the prompt.
describe("buildSampleDialogueContextItems — identity macros still resolve", () => {
  async function buildSamples(inputs: string[], outputs: string[]): Promise<string[]> {
    const items = await buildSampleDialogueContextItems({
      client: CLIENT,
      guildId: "guild-1",
      triggererName: "Alice",
      botName: "Tomori",
      tomoriState: {
        sample_dialogues_in: inputs,
        sample_dialogues_out: outputs,
      } as unknown as TomoriState,
      tomoriConfig: makeConfig(),
      isUserImpersonation: false,
      uncensorInputOptions: { unicodeSpacesEnabled: false, sanitizeEnabled: false },
      convertMentions,
    } as unknown as Parameters<typeof buildSampleDialogueContextItems>[0]);
    return items.map((item) => item.parts.map((part) => (part.type === "text" ? part.text : "")).join(""));
  }

  it("resolves {bot} and {user} to distinct names", async () => {
    const texts = await buildSamples(["Hey {bot}, what's up?"], ["Not much, {user}!"]);
    expect(texts).toEqual(["Hey Tomori, what's up?", "Tomori: Not much, Alice!"]);
  });

  it("resolves the {char} alias", async () => {
    const texts = await buildSamples(["Who am I, {char}?"], ["You're {user}."]);
    expect(texts[0]).toBe("Who am I, Tomori?");
  });

  it("does not double-prefix an output stored with a {{char}}: speaker label", async () => {
    const texts = await buildSamples(["Who am I?"], ["{{char}}: You're {{user}}, obviously."]);
    expect(texts[1]).toBe("Tomori: You're Alice, obviously.");
  });
});
