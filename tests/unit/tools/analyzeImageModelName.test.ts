import { describe, expect, it } from "bun:test";
import { resolveVisionApiModelName } from "@/tools/functionCalls/analyzeImageTool";

const CUSTOM_PROVIDER = "custom:s2:gemini";
const SYNTHETIC_CODENAME = "custom-s2-gemini-text-google-gemini-3-5-flash-lite";
const UPSTREAM_MODEL_NAME = "google/gemini-3.5-flash-lite";

describe("vision API model name resolution", () => {
  it("sends the endpoint's upstream model name for custom endpoints", () => {
    expect(resolveVisionApiModelName(CUSTOM_PROVIDER, SYNTHETIC_CODENAME, UPSTREAM_MODEL_NAME)).toBe(
      UPSTREAM_MODEL_NAME,
    );
  });

  it("falls back to the codename for backends that register no model name", () => {
    expect(resolveVisionApiModelName("custom:s17:koboldcpp", "custom-s17-koboldcpp-text", null)).toBe(
      "custom-s17-koboldcpp-text",
    );
    expect(resolveVisionApiModelName("custom:s17:koboldcpp", "custom-s17-koboldcpp-text", "   ")).toBe(
      "custom-s17-koboldcpp-text",
    );
  });

  it("leaves catalog providers on their codename", () => {
    expect(resolveVisionApiModelName("google", "gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
    expect(resolveVisionApiModelName("openrouter", "google/gemma-4-31b-it")).toBe("google/gemma-4-31b-it");
  });

  it("keeps the Z.ai codename translation ahead of any endpoint override", () => {
    expect(resolveVisionApiModelName("zai", "zai/glm-4.6v", "ignored-by-zai")).toBe("glm-4.6v");
    expect(resolveVisionApiModelName("zaicoding", "glm-4.6v", "ignored-by-zai")).toBe("glm-4.6v");
  });
});
