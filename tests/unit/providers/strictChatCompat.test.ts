import { describe, expect, it } from "bun:test";
import {
  applyAssistantPrefixCompletion,
  assistantMediaRelocationNotice,
  CONVERSATION_START_USER_TEXT,
  ensureLeadingUserTurn,
  mergeConsecutiveSameRole,
  type NormalizableMessage,
  providerRequiresAlternation,
  providerRequiresPrefixCompletion,
  relocateAssistantMediaContextItems,
  relocateAssistantMediaToUserTurns,
} from "@/providers/utils/strictChatCompat";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";

describe("providerRequires* safety nets", () => {
  it("flags anthropic for alternation, deepseek/zai/zaicoding for prefix", () => {
    expect(providerRequiresAlternation("anthropic")).toBe(true);
    expect(providerRequiresAlternation("custom")).toBe(false);
    expect(providerRequiresAlternation("deepseek")).toBe(false);

    for (const p of ["deepseek", "zai", "zaicoding"]) {
      expect(providerRequiresPrefixCompletion(p)).toBe(true);
    }
    expect(providerRequiresPrefixCompletion("anthropic")).toBe(false);
    expect(providerRequiresPrefixCompletion("custom")).toBe(false);
  });
});

describe("applyAssistantPrefixCompletion", () => {
  const prefill = "Sure, here";

  it("sets prefix:true when the trailing assistant message equals the prefill", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: prefill },
      ],
    };
    applyAssistantPrefixCompletion(body, prefill);
    expect((body.messages.at(-1) as Record<string, unknown>).prefix).toBe(true);
  });

  it("no-ops when prefill is missing", () => {
    const body = { messages: [{ role: "assistant", content: prefill }] };
    applyAssistantPrefixCompletion(body, undefined);
    expect((body.messages.at(-1) as Record<string, unknown>).prefix).toBeUndefined();
  });

  it("no-ops when the last message is not the prefill assistant turn", () => {
    const body = {
      messages: [
        { role: "assistant", content: prefill },
        { role: "user", content: "actually no" },
      ],
    };
    applyAssistantPrefixCompletion(body, prefill);
    expect((body.messages.at(-1) as Record<string, unknown>).prefix).toBeUndefined();
    expect((body.messages[0] as Record<string, unknown>).prefix).toBeUndefined();
  });

  it("no-ops when content does not exactly equal the prefill", () => {
    const body = { messages: [{ role: "assistant", content: `${prefill} more` }] };
    applyAssistantPrefixCompletion(body, prefill);
    expect((body.messages[0] as Record<string, unknown>).prefix).toBeUndefined();
  });

  it("no-ops on an empty messages array", () => {
    const body: { messages: unknown[] } = { messages: [] };
    expect(() => applyAssistantPrefixCompletion(body, prefill)).not.toThrow();
  });

  it("stamps reasoning_content: '' on the prefix turn when requiresReasoningContent is true", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: prefill },
      ],
    };
    applyAssistantPrefixCompletion(body, prefill, true);
    const last = body.messages.at(-1) as Record<string, unknown>;
    expect(last.prefix).toBe(true);
    expect(last.reasoning_content).toBe("");
  });

  it("omits reasoning_content when requiresReasoningContent is false or omitted", () => {
    const body = { messages: [{ role: "assistant", content: prefill }] };
    applyAssistantPrefixCompletion(body, prefill, false);
    expect((body.messages[0] as Record<string, unknown>).reasoning_content).toBeUndefined();
  });

  it("does not clobber an already-present reasoning_content", () => {
    const body = { messages: [{ role: "assistant", content: prefill, reasoning_content: "captured CoT" }] };
    applyAssistantPrefixCompletion(body, prefill, true);
    expect((body.messages[0] as Record<string, unknown>).reasoning_content).toBe("captured CoT");
  });
});

describe("mergeConsecutiveSameRole", () => {
  it("returns empty for empty input", () => {
    expect(mergeConsecutiveSameRole<NormalizableMessage>([])).toEqual([]);
  });

  it("leaves an already-alternating list untouched (string content preserved)", () => {
    const input: NormalizableMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    expect(mergeConsecutiveSameRole(input)).toEqual(input);
  });

  it("merges consecutive same-role string turns into flattened text", () => {
    const input: NormalizableMessage[] = [
      { role: "user", content: "one" },
      { role: "user", content: "two" },
      { role: "assistant", content: "ok" },
    ];
    expect(mergeConsecutiveSameRole(input)).toEqual([
      { role: "user", content: "one\ntwo" },
      { role: "assistant", content: "ok" },
    ]);
  });

  it("concatenates array content blocks when merging", () => {
    const input: NormalizableMessage[] = [
      { role: "user", content: [{ type: "text", text: "x" }] },
      { role: "user", content: [{ type: "image", source: {} }] },
    ];
    expect(mergeConsecutiveSameRole(input)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "x" },
          { type: "image", source: {} },
        ],
      },
    ]);
  });

  it("treats a tool_calls assistant turn as a merge boundary (preserves wiring, no orphan)", () => {
    // Mirrors the OpenAI-compatible array when strict_role_alternation is ON and function/tool
    // history follows a trailing dialogue assistant turn. Merging the two adjacent assistant turns
    // would drop the second's top-level tool_calls and orphan the matching tool result.
    const input = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "let me check that" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"result":1}' },
    ] as unknown as NormalizableMessage[];

    const merged = mergeConsecutiveSameRole(input) as unknown as Array<Record<string, unknown>>;

    // The plain dialogue assistant turn is preserved as its own (still-string) turn; not merged.
    expect(merged[1]).toEqual({ role: "assistant", content: "let me check that" });

    // The tool_calls turn survives intact with its wiring.
    const toolCallsTurn = merged.find((m) => Array.isArray(m.tool_calls));
    expect((toolCallsTurn?.tool_calls as Array<{ id: string }> | undefined)?.[0]?.id).toBe("call_1");

    // The tool result's tool_call_id still references a surviving tool_calls entry (no orphan).
    const toolMsg = merged.find((m) => m.role === "tool");
    const referenced = merged.some(
      (m) =>
        Array.isArray(m.tool_calls) &&
        (m.tool_calls as Array<{ id: string }>).some((t) => t.id === toolMsg?.tool_call_id),
    );
    expect(referenced).toBe(true);
  });
});

describe("ensureLeadingUserTurn", () => {
  const factory = (): NormalizableMessage => ({ role: "user", content: CONVERSATION_START_USER_TEXT });

  it("prepends a user turn when the first dialogue turn is assistant", () => {
    const input: NormalizableMessage[] = [
      { role: "assistant", content: "hello" },
      { role: "user", content: "hi" },
    ];
    expect(ensureLeadingUserTurn(input, factory)).toEqual([
      { role: "user", content: CONVERSATION_START_USER_TEXT },
      { role: "assistant", content: "hello" },
      { role: "user", content: "hi" },
    ]);
  });

  it("does nothing when the first dialogue turn is already user", () => {
    const input: NormalizableMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(ensureLeadingUserTurn(input, factory)).toEqual(input);
  });

  it("skips a leading system turn and inserts before the first assistant turn", () => {
    const input: NormalizableMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "hello" },
    ];
    expect(ensureLeadingUserTurn(input, factory)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: CONVERSATION_START_USER_TEXT },
      { role: "assistant", content: "hello" },
    ]);
  });
});

describe("assistantMediaRelocationNotice", () => {
  it("uses singular vs plural wording", () => {
    expect(assistantMediaRelocationNotice(1, "Tomori")).toBe("[System: The following image was sent by Tomori.]");
    expect(assistantMediaRelocationNotice(2, "Tomori")).toBe("[System: The following images were sent by Tomori.]");
  });

  it("falls back to generic wording when no sender is available", () => {
    expect(assistantMediaRelocationNotice(1)).toBe("[System: The following image was sent]");
    expect(assistantMediaRelocationNotice(2)).toBe("[System: The following images were sent]");
  });
});

describe("relocateAssistantMediaContextItems", () => {
  const img = { type: "image", uri: "data:image/png;base64,AAA", mimeType: "image/png" } as const;

  it("relocates model images with sender attribution while preserving model text", () => {
    const input: StructuredContextItem[] = [
      { role: "user", parts: [{ type: "text", text: "look" }] },
      {
        role: "model",
        parts: [{ type: "text", text: "here" }, img],
        metadataTag: ContextItemTag.DIALOGUE_HISTORY,
        messageId: "m1",
        sender: { name: "Tomori", type: "persona" },
      },
    ];

    expect(relocateAssistantMediaContextItems(input)).toEqual([
      { role: "user", parts: [{ type: "text", text: "look" }] },
      {
        role: "model",
        parts: [{ type: "text", text: "here" }],
        metadataTag: ContextItemTag.DIALOGUE_HISTORY,
        messageId: "m1",
        sender: { name: "Tomori", type: "persona" },
      },
      {
        role: "user",
        parts: [{ type: "text", text: assistantMediaRelocationNotice(1, "Tomori") }, img],
        metadataTag: ContextItemTag.DIALOGUE_HISTORY,
        messageId: "m1",
        sender: { name: "Tomori", type: "persona" },
      },
    ]);
  });

  it("attributes image-only model turns instead of dropping the sender", () => {
    const input: StructuredContextItem[] = [
      {
        role: "model",
        parts: [img],
        sender: { name: "Kana", type: "persona" },
      },
    ];

    expect(relocateAssistantMediaContextItems(input)).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: assistantMediaRelocationNotice(1, "Kana") }, img],
        sender: { name: "Kana", type: "persona" },
      },
    ]);
  });
});

describe("relocateAssistantMediaToUserTurns", () => {
  const img = { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } };

  it("peels images off an assistant turn into a following user turn", () => {
    const input = [
      { role: "user", content: "look" },
      { role: "assistant", content: [{ type: "text", text: "here" }, img] },
    ];
    expect(relocateAssistantMediaToUserTurns(input)).toEqual([
      { role: "user", content: "look" },
      { role: "assistant", content: "here" },
      {
        role: "user",
        content: [{ type: "text", text: assistantMediaRelocationNotice(1) }, img],
      },
    ]);
  });

  it("drops the assistant turn entirely when it only carried images", () => {
    const input = [{ role: "assistant", content: [img, img] }];
    expect(relocateAssistantMediaToUserTurns(input)).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: assistantMediaRelocationNotice(2) }, img, img],
      },
    ]);
  });

  it("uses serialized sender metadata when present", () => {
    const input = [{ role: "assistant", content: [img], assistantMediaSenderName: "Mika" }];
    expect(relocateAssistantMediaToUserTurns(input)).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: assistantMediaRelocationNotice(1, "Mika") }, img],
      },
    ]);
  });

  it("leaves string-content and non-assistant messages untouched", () => {
    const input = [
      { role: "user", content: [{ type: "text", text: "u" }, img] },
      { role: "assistant", content: "plain" },
    ];
    expect(relocateAssistantMediaToUserTurns(input)).toEqual(input);
  });
});
