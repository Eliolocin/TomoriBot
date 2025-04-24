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
