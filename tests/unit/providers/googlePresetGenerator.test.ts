import { describe, expect, it } from "bun:test";
import type { GoogleGenAI } from "@google/genai";
import { generatePresetFromPrompt } from "@/providers/google/presetGenerator";

describe("Google preset generation", () => {
  it("keeps the selected model for persona generation", async () => {
    const requestedModels: string[] = [];
    const response = JSON.stringify({
      attribute_list: ["a", "b", "c", "d", "e", "f"],
      sample_dialogues_in: ["a", "b", "c", "d", "e"],
      sample_dialogues_out: ["a", "b", "c", "d", "e"],
    });
    const client = {
      models: {
        generateContent: async ({ model }: { model: string }) => {
          requestedModels.push(model);
          return {
            text: requestedModels.length === 1 ? "None found, this is an original character from the user" : response,
          };
        },
      },
    } as unknown as GoogleGenAI;

    const result = await generatePresetFromPrompt(
      "test-api-key",
      {
        characterName: "Lighthouse",
        characterDescription: "A helpful guide.",
        speechExamples: "Calm and clear.",
        useWebSearch: true,
        modelName: "selected-persona-model",
      },
      "en-US",
      client,
      "configured-google-default",
    );

    expect(result.error).toBeUndefined();
    expect(requestedModels).toEqual(["configured-google-default", "selected-persona-model"]);
  });

  it("classifies a retired Search grounding model as a model error", async () => {
    const client = {
      models: {
        generateContent: async () => {
          throw new Error(
            '{"error":{"code":404,"message":"This model models/gemini-old is no longer available to new users."}}',
          );
        },
      },
    } as unknown as GoogleGenAI;

    const result = await generatePresetFromPrompt(
      "test-api-key",
      {
        characterName: "Lighthouse",
        characterDescription: "A helpful guide.",
        speechExamples: "Calm and clear.",
        useWebSearch: true,
        modelName: "selected-persona-model",
      },
      "en-US",
      client,
      "configured-provider-default",
    );

    expect(result.errorType).toBe("MODEL_ERROR");
    expect(result.error).toContain("Error Code 404");
  });

  it("classifies a retired persona generation model as a model error", async () => {
    const client = {
      models: {
        generateContent: async () => {
          throw new Error(
            '{"error":{"code":404,"message":"This model models/gemini-old is no longer available to new users."}}',
          );
        },
      },
    } as unknown as GoogleGenAI;

    const result = await generatePresetFromPrompt(
      "test-api-key",
      {
        characterName: "Lighthouse",
        characterDescription: "A helpful guide.",
        speechExamples: "Calm and clear.",
        useWebSearch: false,
        modelName: "retired-persona-model",
      },
      "en-US",
      client,
    );

    expect(result.errorType).toBe("MODEL_ERROR");
    expect(result.error).toContain("Error Code 404");
  });
});
