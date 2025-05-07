/**
 * Words and patterns that can trigger a bot response
 */
export interface TriggerConfig {
	autoThreshold: number;
	words: string[];
	regexPatterns?: RegExp[];
}

/**
 * A segment of context for the LLM conversation
 */
export interface ContextSegment {
	type: "preamble" | "memory" | "sample" | "history";
	content: string;
	order: number; // Lower numbers appear earlier in context
	tokens?: number; // Optional token count for context pruning
}

export type ContextPart =
	| { type: "text"; text: string }
	| { type: "image"; uri: string; mimeType: string }; // URI could be a public URL or a data URI

export type StructuredContextItem = {
	role: "system" | "user" | "model"; // 'system' for initial instructions, 'user' for user/tool inputs, 'model' for LLM responses
	parts: ContextPart[];
};

/**
 * Full context assembly options
 */
export interface ContextOptions {
	preambles: string[];
	serverMemories: string[];
	userMemories: Record<string, string[]>;
	sampleDialogs: string[];
	messageHistory: Array<{
		author: string;
		content: string;
		timestamp: Date;
	}>;
	variables: Record<string, string>;
}
