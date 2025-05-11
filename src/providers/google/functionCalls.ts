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
		"Queries the Google search engine with a given search term and returns a concise summary of the findings. Use this to find real-time information, facts, or details not present in your existing knowledge. You will be informed of the search result and will then generate the final text message for the user.",
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
		"Use this function when you identify a new, distinct piece of information, fact, preference, or instruction during the conversation that seems important to remember for future interactions. This helps you learn and adapt. Specify if the information is a general server-wide fact or something specific about the current user you are talking to. Avoid saving information that is already known or redundant.",
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
					"Specify the scope of this memory. Use 'server_wide' for general information applicable to the whole server, or 'about_current_user' for information specific to the user you are currently interacting with.",
				enum: ["server_wide", "about_current_user"],
			},
			current_user_nickname: {
				type: Type.STRING,
				description:
					"If memory_scope is 'about_current_user', provide the nickname of the user this memory pertains to, as you see them in the current conversation. This helps confirm the memory is for the correct user.",
			},
		},
		required: ["memory_content", "memory_scope"], // current_user_nickname is conditionally required by logic, not strictly by schema here for simplicity, but will be validated in the backend.
	},
};

// Future plans:
// 1. Google Search [X]
// 2. Tomori Self-Teaching
// 3. Scrape Danbooru/Gelbooru
