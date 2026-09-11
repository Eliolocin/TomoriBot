import { expect, test } from "bun:test";
import { usesNaiStructuredPromptFormat } from "@/utils/image/naiImageGeneration";

test("uses the structured prompt schema for NovelAI Diffusion V4 and V5", () => {
  expect(usesNaiStructuredPromptFormat("nai-diffusion-4-5-full")).toBe(true);
  expect(usesNaiStructuredPromptFormat("nai-diffusion-5-curated")).toBe(true);
  expect(usesNaiStructuredPromptFormat("nai-diffusion-3-furry")).toBe(false);
});
