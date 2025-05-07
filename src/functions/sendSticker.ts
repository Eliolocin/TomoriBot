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
