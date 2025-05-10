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
export type ContextPart =
	| { type: "text"; text: string }
	| { type: "image"; uri: string; mimeType: string }; // URI could be a public URL or a data URI

// New: Define the possible metadata tags for context items (Rule 13)
export enum ContextItemTag {
	// System-level instructions and configurations
	SYSTEM_INSTRUCTION_BLOCK = "system_instruction_block", // For the main consolidated system prompt
	SYSTEM_PERSONALITY = "system_personality", // Specific to bot's core personality attributes
	SYSTEM_HUMANIZER_RULES = "system_humanizer_rules", // Specific to humanization instructions
	SYSTEM_FUNCTION_GUIDE = "system_function_guide", // New: For instructions on using available functions

	// Knowledge base and environmental context
	KNOWLEDGE_SERVER_INFO = "knowledge_server_info",
	KNOWLEDGE_SERVER_EMOJIS = "knowledge_server_emojis",
	KNOWLEDGE_SERVER_STICKERS = "knowledge_server_stickers",
	KNOWLEDGE_SERVER_MEMORIES = "knowledge_server_memories",
	KNOWLEDGE_USER_MEMORIES = "knowledge_user_memories", // For a block of multiple users' memories
	KNOWLEDGE_USER_STATUS = "knowledge_user_status", // For a block of multiple users' statuses
	KNOWLEDGE_CURRENT_CONTEXT = "knowledge_current_context", // Time, channel info

	// Dialogue examples and history
	DIALOGUE_SAMPLE = "dialogue_sample", // For individual sample user/model turns
	DIALOGUE_HISTORY = "dialogue_history", // For actual conversation history turns

	// Tool/Function related (if we ever need to tag parts of tool descriptions or results)
	// TOOL_DESCRIPTION = "tool_description",
	// TOOL_RESULT = "tool_result",
}

export type StructuredContextItem = {
	role: "system" | "user" | "model"; // 'system' for initial instructions, 'user' for user/tool inputs, 'model' for LLM responses
	parts: ContextPart[];
	metadataTag?: ContextItemTag; // Optional tag for internal processing
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
