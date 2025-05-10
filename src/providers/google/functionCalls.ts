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

// Future plans:
// 1. Google Search [X]
// 2. Tomori Self-Teaching
// 3. Scrape Danbooru/Gelbooru
