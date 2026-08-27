import { describe, expect, it } from "bun:test";
import { buildOpenAICompatibleMessages } from "@/providers/openaiCompatible/openaiCompatibleMessageBuilder";
import type { StructuredContextItem } from "@/types/misc/context";

// Golden-body regression coverage for the OpenAI-compatible message builder, which every
// OpenAI-compatible provider (deepseek, zai, zaicoding, custom, nvidia, ...) shares. The media
// notice intentionally supersedes the plan-07 byte-identical wording so relocated persona images
// can name their actual sender.
//
// Inline base64 image parts are used so no network/image-processing runs in the test.
function inlineImagePart(data: string): StructuredContextItem["parts"][number] {
  return {
    type: "image",
    inlineData: { mimeType: "image/png", data },
  } as unknown as StructuredContextItem["parts"][number];
}

describe("buildOpenAICompatibleMessages — assistant media relocation (golden)", () => {
  it("relocates a bot image into a synthetic user turn after the assistant text turn", async () => {
    const contextItems: StructuredContextItem[] = [
      { role: "user", parts: [{ type: "text", text: "Hello" }] },
      {
        role: "model",
        parts: [{ type: "text", text: "Hi there" }, inlineImagePart("AAA")],
        sender: { name: "Tomori", type: "persona" },
      },
    ];

    const messages = await buildOpenAICompatibleMessages({
      adapterName: "TestAdapter",
      contextItems,
      currentTurnModelParts: [],
      seesImages: true,
    });

    expect(messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      {
        role: "user",
        content: [
          { type: "text", text: "[System: The following image was sent by Tomori.]" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ]);
  });

  it("drops an image-only assistant turn, keeping only the relocated user turn (plural wording)", async () => {
    const contextItems: StructuredContextItem[] = [
      { role: "user", parts: [{ type: "text", text: "show me" }] },
      {
        role: "model",
        parts: [inlineImagePart("AAA"), inlineImagePart("BBB")],
        sender: { name: "Tomori", type: "persona" },
      },
    ];

    const messages = await buildOpenAICompatibleMessages({
      adapterName: "TestAdapter",
      contextItems,
      currentTurnModelParts: [],
      seesImages: true,
    });

    expect(messages).toEqual([
      { role: "user", content: "show me" },
      {
        role: "user",
        content: [
          { type: "text", text: "[System: The following images were sent by Tomori.]" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
        ],
      },
    ]);
  });

  it("attributes relocated images to each persona in multi-persona history", async () => {
    const contextItems: StructuredContextItem[] = [
      { role: "user", parts: [{ type: "text", text: "gallery" }] },
      {
        role: "model",
        parts: [{ type: "text", text: "Aki: first" }, inlineImagePart("AAA")],
        sender: { name: "Aki", type: "persona" },
      },
      { role: "user", parts: [{ type: "text", text: "next" }] },
      {
        role: "model",
        parts: [inlineImagePart("BBB")],
        sender: { name: "Ren", type: "persona" },
      },
    ];

    const messages = await buildOpenAICompatibleMessages({
      adapterName: "TestAdapter",
      contextItems,
      currentTurnModelParts: [],
      seesImages: true,
    });

    expect(messages).toEqual([
      { role: "user", content: "gallery" },
      { role: "assistant", content: "Aki: first" },
      {
        role: "user",
        content: [
          { type: "text", text: "[System: The following image was sent by Aki.]" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
      { role: "user", content: "next" },
      {
        role: "user",
        content: [
          { type: "text", text: "[System: The following image was sent by Ren.]" },
          { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
        ],
      },
    ]);
  });

  it("leaves a text-only assistant turn as a flat string (no relocation)", async () => {
    const contextItems: StructuredContextItem[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "model", parts: [{ type: "text", text: "hello" }] },
    ];

    const messages = await buildOpenAICompatibleMessages({
      adapterName: "TestAdapter",
      contextItems,
      currentTurnModelParts: [],
      seesImages: true,
    });

    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("appends the current-turn prefill as a trailing assistant string", async () => {
    const messages = await buildOpenAICompatibleMessages({
      adapterName: "TestAdapter",
      contextItems: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      currentTurnModelParts: [{ text: "Sure, " }],
      seesImages: true,
    });

    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Sure, " },
    ]);
  });

  it("serializes a text-only tool result once without a duplicate user turn", async () => {
    const functionResponse = {
      functionResponse: {
        name: "fetch_url",
        response: { result: { summary: "Fetched page content" } },
      },
    };
    const messages = await buildOpenAICompatibleMessages({
      adapterName: "TestAdapter",
      contextItems: [],
      currentTurnModelParts: [],
      functionInteractionHistory: [
        {
          functionCall: { name: "fetch_url", args: { url: "https://example.com" } },
          functionResponse,
        },
      ],
      seesImages: false,
    });

    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(messages[1]?.content).toBe(JSON.stringify(functionResponse));
  });

  it("inlines tool-returned images and corrects a misleading MIME label", async () => {
    const pngBytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const messages = await buildOpenAICompatibleMessages({
      adapterName: "TestAdapter",
      contextItems: [],
      currentTurnModelParts: [],
      functionInteractionHistory: [
        {
          functionCall: { name: "web_search", args: { query: "birds" } },
          functionResponse: { functionResponse: { name: "web_search", response: { result: "sent" } } },
          imageMetadata: {
            imageUrls: [
              {
                url: `data:image/jpeg;base64,${pngBytes.toString("base64")}`,
                mimeType: "image/jpeg",
                originalUrl: "https://media.discordapp.net/proxy-image.jpg",
              },
            ],
            totalSent: 1,
            totalValidated: 1,
          },
        },
      ],
      seesImages: true,
    });

    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${pngBytes.toString("base64")}` },
        },
      ],
    });
  });

  it("replaces a tool-returned GIF instead of sending it to the provider", async () => {
    const gifBytes = Buffer.from("GIF89a");
    const messages = await buildOpenAICompatibleMessages({
      adapterName: "TestAdapter",
      contextItems: [],
      currentTurnModelParts: [],
      functionInteractionHistory: [
        {
          functionCall: { name: "web_search", args: { query: "animation" } },
          functionResponse: { functionResponse: { name: "web_search", response: { result: "sent" } } },
          imageMetadata: {
            imageUrls: [
              {
                url: `data:image/jpeg;base64,${gifBytes.toString("base64")}`,
                mimeType: "image/jpeg",
              },
            ],
            totalSent: 1,
            totalValidated: 1,
          },
        },
      ],
      seesImages: true,
    });

    expect(messages[2]).toEqual({
      role: "user",
      content: "[System: A GIF returned by the tool is not supported by this endpoint.]",
    });
  });
});

describe("buildOpenAICompatibleMessages — reasoning_content replay", () => {
  const functionResponse = { functionResponse: { name: "get_weather", response: { result: "ok" } } };

  async function buildToolReplay(
    deepseekReasoningContent: string | undefined,
    requiresReasoningContentReplay: boolean,
  ): Promise<Array<Record<string, unknown>>> {
    return await buildOpenAICompatibleMessages({
      adapterName: "TestAdapter",
      contextItems: [],
      currentTurnModelParts: [],
      functionInteractionHistory: [
        {
          functionCall: { name: "get_weather", args: {}, deepseekReasoningContent },
          functionResponse,
        },
      ],
      seesImages: false,
      requiresReasoningContentReplay,
    });
  }

  it("emits an empty reasoning_content when replay is required but nothing was captured", async () => {
    // DeepSeek 400s on an omitted key but accepts "", and a degraded retry that dropped
    // `thinking` produces a tool call with no reasoning to capture.
    const messages = await buildToolReplay(undefined, true);

    expect(messages[0]).toHaveProperty("reasoning_content");
    expect(messages[0]?.reasoning_content).toBe("");
  });

  it("replays captured reasoning verbatim when replay is required", async () => {
    const messages = await buildToolReplay("thought about the weather", true);

    expect(messages[0]?.reasoning_content).toBe("thought about the weather");
  });

  it("omits reasoning_content entirely for endpoints that do not require the replay", async () => {
    const messages = await buildToolReplay(undefined, false);

    expect(messages[0]).not.toHaveProperty("reasoning_content");
  });
});
