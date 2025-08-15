import {
	Type, // Import Type for function declaration
} from "@google/genai";

/**
 * Function declaration for Gemini to call when it wants to select a sticker
 * to potentially accompany its text response.
 * The LLM will be informed of the selection result and then generate the final message.
 */
export const selectStickerFunctionDeclaration = {
	// Renamed for clarity
	name: "select_sticker_for_response", // Function name Gemini will use
	description:
		"Selects a specific sticker from the available server stickers that is relevant to the current conversational context. Use this to choose a sticker that expresses an emotion or reaction aligning with the sticker's name or description. You will be informed of the selection result and will then generate the final text message for the user.",
	parameters: {
		type: Type.OBJECT, // Use the imported enum
		properties: {
			sticker_id: {
				type: Type.STRING, // Use the imported enum
				description:
					"The unique Discord ID of the sticker to select (e.g., '123456789012345678'). This ID must be from the provided list of available server stickers.",
			},
			// No message_content here, as the LLM will generate it in the next step
		},
		required: ["sticker_id"], // Only sticker_id is required from the LLM at this stage
	},
};

/**
 * Function declaration for Gemini to call when it needs to search the web
 * for real-time information or facts not present in its existing knowledge.
 * The LLM will provide a search query and will be given a summary of the findings.
 */
export const queryGoogleSearchFunctionDeclaration = {
	name: "query_google_search", // Function name Gemini will use
	description:
		"Queries the Google search engine with a given search term and returns a concise summary of the findings. Use this to find real-time information, facts, or details not present in your existing knowledge. You will be informed of the search result and will then generate the final text message for the user. Do NOT use on YouTube links or video content.",
	parameters: {
		type: Type.OBJECT,
		properties: {
			search_query: {
				type: Type.STRING,
				description:
					"The specific search query string to use for the Google search. Be concise and clear.",
			},
		},
		required: ["search_query"],
	},
};

/**
 * Function declaration for Gemini to call when it identifies new information
 * during a conversation that it should remember for future interactions.
 * This allows Tomori to learn and adapt.
 */
export const rememberThisFactFunctionDeclaration = {
	name: "remember_this_fact", // Function name Gemini will use
	description:
		"Use this function when you identify a new, distinct piece of information, fact, preference, or instruction during the conversation that seems important to remember for future interactions. This helps you learn and adapt. Specify if the information is a general server-wide fact or something specific about a user. Avoid saving information that is already known or redundant.",
	parameters: {
		type: Type.OBJECT,
		properties: {
			memory_content: {
				type: Type.STRING,
				description:
					"The specific piece of information, fact, or preference to remember. Be concise, clear, and ensure it's new information not already in your knowledge base.",
			},
			memory_scope: {
				type: Type.STRING,
				description:
					"Specify the scope of this memory. Use 'server_wide' for general information applicable to the whole server, or 'target_user' for information specific to a particular user.",
				enum: ["server_wide", "target_user"],
			},
			target_user_discord_id: {
				// NEW parameter
				type: Type.STRING,
				description:
					"If memory_scope is 'target_user', provide the unique Discord ID of the user this memory pertains to (e.g., '123456789012345678'). This ID should be obtained from the user's information visible in the context.",
			},
			target_user_nickname: {
				// Existing parameter, description updated
				type: Type.STRING,
				description:
					"If memory_scope is 'target_user', also provide the nickname of the user this memory pertains to, as you see them in the current conversation or their user profile information. This is used to confirm the target user alongside their Discord ID.",
			},
		},
		// Both memory_content and memory_scope are always required.
		// target_user_discord_id and target_user_nickname will be conditionally required by backend logic
		// if memory_scope is 'target_user'. The schema reflects the always-required fields.
		required: ["memory_content", "memory_scope"],
	},
};

// Future plans:
// 1. Google Search [X]
// 2. Tomori Self-Teaching [x]
// 3. Scrape Danbooru/Gelbooru
