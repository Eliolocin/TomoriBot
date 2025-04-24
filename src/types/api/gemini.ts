import {
	HarmCategory,
	HarmBlockThreshold,
	type SafetySetting,
	type GenerateContentConfig,
	type Tool,
	type GoogleGenAIOptions,
} from "@google/genai";
import { z } from "zod";

/**
 * Configuration for the Gemini API client, extends official Google GenAI options
 */
export type GeminiConfig = {
	model: string;
	apiKey: string;
	generationConfig: GenerateContentConfig;
	safetySettings: SafetySetting[];
	tools?: Tool[];
	enableSearch?: boolean;
} & GoogleGenAIOptions;

// Zod schema for config validation
export const GeminiConfigSchema = z.object({
	model: z.string(),
	apiKey: z.string().min(1, "API key is required"),
	generationConfig: z
		.object({
			temperature: z.number().min(0).max(2),
			topK: z.number().min(1),
			topP: z.number().min(0).max(1),
			maxOutputTokens: z.number().optional(),
		})
		.passthrough(), // Allow other official GenerateContentConfig properties
	safetySettings: z.array(
		z.object({
			category: z.nativeEnum(HarmCategory), // Convert enum to Zod enum type
			threshold: z.nativeEnum(HarmBlockThreshold), // Convert enum to Zod enum type
		}),
	),
	tools: z.array(z.record(z.any())).optional(), // Now accepts any object in the array
	enableSearch: z.boolean().optional(),
});
