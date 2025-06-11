import {
	GoogleGenAI, // 1. Use the same client class as generateGeminiResponse
	type Content,
	type GenerateContentConfig,
} from "@google/genai";
import type { TomoriState, ErrorContext } from "@/types/db/schema";
import { log } from "@/utils/misc/logger";

/**
 * Executes a Google search query using a sub-agent LLM.
 * The sub-agent is configured with the native Google Search tool.
 *
 * @param searchQuery - The query string for the Google search.
 * @param conversationHistory - A string representing the recent conversation history for context.
 * @param _tomoriState - The current Tomori state (unused for now).
 * @param originalApiKey - The decrypted Google API key.
 * @returns A promise resolving to an object with the search summary or an error message.
 */
export async function executeSearchSubAgent(
	searchQuery: string,
	conversationHistory: string, // 1. Added conversationHistory parameter
	_tomoriState: TomoriState, // Reserved for future model config overrides
	originalApiKey: string,
): Promise<{ summary?: string; error?: string }> {
	log.info(`Sub-agent: Executing Google search for query: "${searchQuery}"`);

	// 1. Pick the sub-agent model
	const subAgentModel =
		process.env.DEFAULT_GEMINI_SUBAGENT_MODEL ||
		"gemini-2.5-flash-preview-04-17";

	try {
		// 2. Instantiate the same GoogleGenerativeAI client we use elsewhere
		const genAI = new GoogleGenAI({ apiKey: originalApiKey });

		// 3. Build our systemInstruction as a Content block
		const systemInstruction: Content = {
			role: "system",
			parts: [
				{
					text: `You are an advanced Google search assistant whose goal is to thoroughly research and gather detailed information from Google based on the 'Primary Search Query' in order to help the main assistant.

**Instructions:**

1. Use the provided 'Conversation History' to deeply understand the context and intent behind the user's query.
2. Perform a Google search using your search tool and carefully review all of the search results, picking out the most relevant.
3. Extract and present all of the most important details, facts, figures, quotations, examples, and explanations from the search results that are relevant to the current context of the conversation and query of the user.
4. After presenting these detailed findings, synthesize them into a clear and comprehensive summary paragraph at the end of your response.
5. Do not skip relevant details or over-summarize prematurely. Your priority is providing thorough and transparent information before synthesizing.

Your response format should be:

### Detailed Findings
- [Topic 1]
  - Detail 1
  - Detail 2
  - Detail 3 (quotes, numbers, explanations, etc.)
- [Topic 2]
  - Detail 1
  - Detail 2
  - Detail 3 (quotes, numbers, explanations, etc.)
...

### Comprehensive Summary
- [A brief synthesis that integrates the details above clearly and cohesively.]

**Remember:** prioritize detailed information first, then summarize clearly at the end. Provide as much context and depth as possible to help the main assistant fully understand the topic.
`,
				},
			],
		};

		// 4. Prepare the user prompt content, combining history and query
		const userPromptText = `Conversation History (for context):
---
${conversationHistory}
---
Primary Search Query:
---
${searchQuery}
---`;

		const userPromptContent: Content = {
			role: "user",
			parts: [{ text: userPromptText }],
		};

		// 5. Only the googleSearch tool is enabled for this sub-agent
		const tools = [{ googleSearch: {} }];

		// 4. Prepare the generation config (low temperature for facts)
		const generationConfig: GenerateContentConfig = {
			temperature: 1.0,
			topK: 1,
			topP: 0.9,
			maxOutputTokens: 3000,
			systemInstruction: systemInstruction,
			tools: tools,
		};

		log.info(
			`Sub-agent: Calling model ${subAgentModel} with Google Search tool.`,
		);

		// 6. Call generateContent exactly as in generateGeminiResponse
		const response = await genAI.models.generateContent({
			model: subAgentModel,
			contents: [userPromptContent], // Pass the combined user prompt
			config: generationConfig,
		});

		// 7. Extract the text result
		const text = response.text;
		if (text?.trim()) {
			log.success(`Sub-agent: Received summary: "${text}"`);
			return { summary: text.trim() };
		}

		// 8. Handle block or finish reasons
		const finishReason = response.candidates?.[0]?.finishReason;
		const blockReason = response.promptFeedback?.blockReason;
		if (blockReason) {
			log.warn(`Sub-agent blocked: ${blockReason}`);
			return { error: `Search blocked: ${blockReason}` };
		}
		if (finishReason && finishReason !== "STOP") {
			log.warn(`Sub-agent ended with reason '${finishReason}' but no text.`);
			return { error: `No summary (finish reason: ${finishReason}).` };
		}

		log.warn("Sub-agent: No text summary returned.");
		return { error: "Empty summary from search sub-agent." };
	} catch (err) {
		// 9. Log and return error
		const error = err as Error;
		log.error(`Sub-agent error: ${error.message}`, error, {
			errorType: "SubAgentExecutionError",
			metadata: { searchQuery, subAgentModel },
		} satisfies ErrorContext);
		return {
			error: `Sub-agent failed: ${error.message}`,
		};
	}
}
