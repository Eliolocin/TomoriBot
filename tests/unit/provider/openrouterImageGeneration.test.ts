import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  generateOpenRouterImage,
  usesChatCompletionsImageGeneration,
} from "@/providers/openrouter/openrouterImageGeneration";

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
}

function stubFetch(payload: unknown, captured: CapturedCall[], status = 200) {
  return spyOn(globalThis, "fetch").mockImplementation(async (input: unknown, init?: RequestInit) => {
    captured.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

const restore: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of restore.splice(0)) spy.mockRestore();
});

describe("OpenRouter image generation routing", () => {
  it("sends dedicated image models to the images endpoint, not chat completions", () => {
    // Chat completions answers these with a 404 naming the images endpoint, or an opaque 500.
    expect(usesChatCompletionsImageGeneration("bytedance-seed/seedream-5-0-pro")).toBe(false);
    expect(usesChatCompletionsImageGeneration("qwen/qwen-image-3")).toBe(false);
    expect(usesChatCompletionsImageGeneration("black-forest-labs/flux-1-dev")).toBe(false);
    expect(usesChatCompletionsImageGeneration("google/gemini-2.5-flash-image")).toBe(true);
  });

  it("posts an image model to /api/v1/images and decodes b64_json", async () => {
    const captured: CapturedCall[] = [];
    const spy = stubFetch({ data: [{ b64_json: "QUJD", media_type: "image/webp" }] }, captured);
    restore.push(spy);

    const result = await generateOpenRouterImage({
      apiKey: "key",
      modelCodename: "qwen/qwen-image-3",
      prompt: "a red cube",
      aspectRatio: "2:3",
      referenceImages: [{ mimeType: "image/png", data: "Zm9v" }],
    });

    expect(captured[0]?.url).toBe("https://openrouter.ai/api/v1/images");
    expect(captured[0]?.body).toMatchObject({
      model: "qwen/qwen-image-3",
      prompt: "a red cube",
      aspect_ratio: "2:3",
      input_references: [{ type: "image_url", image_url: { url: "data:image/png;base64,Zm9v" } }],
    });
    // The chat-only fields must not leak onto this endpoint.
    expect(captured[0]?.body).not.toHaveProperty("messages");
    expect(captured[0]?.body).not.toHaveProperty("modalities");
    expect(result).toEqual({ imageData: "QUJD", mimeType: "image/webp" });
  });

  it("keeps Gemini models on chat completions with both modalities", async () => {
    const captured: CapturedCall[] = [];
    const spy = stubFetch(
      { choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,QUJD" } }] } }] },
      captured,
    );
    restore.push(spy);

    const result = await generateOpenRouterImage({
      apiKey: "key",
      modelCodename: "google/gemini-2.5-flash-image",
      prompt: "a red cube",
      aspectRatio: "1:1",
    });

    expect(captured[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured[0]?.body).toMatchObject({ modalities: ["image", "text"] });
    expect(result).toEqual({ imageData: "QUJD", mimeType: "image/png" });
  });

  it("surfaces the provider's own error message on failure", async () => {
    const captured: CapturedCall[] = [];
    const spy = stubFetch(
      { error: { message: "qwen/qwen-image-3 is an image generation model", code: 404 } },
      captured,
      404,
    );
    restore.push(spy);

    await expect(
      generateOpenRouterImage({
        apiKey: "key",
        modelCodename: "qwen/qwen-image-3",
        prompt: "x",
        aspectRatio: "1:1",
      }),
    ).rejects.toThrow("is an image generation model");
  });
});
