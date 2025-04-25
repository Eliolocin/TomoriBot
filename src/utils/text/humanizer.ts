import { log } from "../misc/logger";
import type { TextChannel } from "discord.js";

/**
 * List of common internet expressions that should be converted to lowercase
 * even though they are technically acronyms
 */
const INTERNET_EXPRESSIONS = new Set([
	"lol",
	"rofl",
	"lmao",
	"lmfao",
	"wtf",
	"btw",
	"omg",
	"iirc",
	"afaik",
	"tbh",
	"imo",
	"imho",
	"fyi",
	"idk",
	"brb",
	"afk",
	"ttyl",
	"rn",
	"smh",
	"tysm",
]);

/**
 * Humanizes text by lowercasing words and simplifying punctuation while preserving
 * code blocks, acronyms, internet expressions, and sender prefixes.
 *
 * Modifications:
 * - Converts text to lowercase unless it's an acronym or special expression
 * - Preserves sender strings in format "(Name): " or "Name: "
 * - Removes periods and commas while preserving ? and ! marks
 * - Maintains code blocks and inline code unchanged
 * - Preserves standalone "I" pronoun
 *
 * @param text - Full text that may include code blocks
 * @returns Humanized text with simplified punctuation and preserved code blocks
 */
export function humanizeString(text: string): string {
	// 1. Store code blocks and replace with placeholders
	const codeBlocks: string[] = [];
	const inlineCode: string[] = [];
	const senderStrings: string[] = [];

	// 2. Replace code blocks (```) with placeholders
	let processedText = text.replace(/```[\s\S]*?```/g, (match) => {
		codeBlocks.push(match);
		return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
	});

	// 3. Replace inline code (`) with placeholders
	// Look for inline code that contains alphanumeric characters or common code symbols
	processedText = processedText.replace(
		/`[\w\s\(\)\[\]\{\}\.,:;=+\-*/<>!?#$%^&|~\\]+`/g,
		(match) => {
			inlineCode.push(match);
			return `__INLINE_CODE_${inlineCode.length - 1}__`;
		},
	);

	// 4. Replace sender strings with placeholders
	processedText = processedText.replace(
		/((?:\([\w\s]+\)|[\w\s]+):)/g, // <-- Remove the trailing \s, capture the colon
		(match) => {
			senderStrings.push(match); // Push only "Name:"
			return `__SENDER_${senderStrings.length - 1}__`;
		},
	);
	// 5. Apply lowercase transformation to text outside code blocks
	processedText = processedText.replace(/\b([A-Za-z][a-zA-Z']*)\b/g, (word) => {
		const isAcronym = /^[A-Z]{2,}$/.test(word);
		const isInternet = INTERNET_EXPRESSIONS.has(word.toLowerCase());
		// Preserve standalone "I" pronoun
		const isStandaloneI = word === "I";
		return isAcronym || isInternet || isStandaloneI ? word : word.toLowerCase();
	});

	// 6. Remove periods and commas, but keep question marks and exclamation points
	processedText = processedText.replace(/[.,;]/g, ""); // Remove periods, commas, semicolons, colons

	// 7. Fix potential issues with multiple punctuation
	processedText = processedText.replace(/([?!])+/g, "$1"); // Replace multiple ???? or !!!! with single one

	// 8. Restore placeholders in reverse order to avoid index issues
	// First restore sender strings
	for (let i = senderStrings.length - 1; i >= 0; i--) {
		processedText = processedText.replace(`__SENDER_${i}__`, senderStrings[i]);
	}

	// Then restore inline code
	for (let i = inlineCode.length - 1; i >= 0; i--) {
		processedText = processedText.replace(
			`__INLINE_CODE_${i}__`,
			inlineCode[i],
		);
	}

	// Finally restore code blocks
	for (let i = codeBlocks.length - 1; i >= 0; i--) {
		processedText = processedText.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
	}

	return processedText;
}

/**
 * Sends message chunks with realistic typing simulation.
 * Calculates typing speed based on message length and adds random "thinking" pauses.
 *
 * @param channel - The Discord text channel to send messages to
 * @param chunks - Array of message chunks to send
 * @returns Promise that resolves when all chunks are sent
 */
export async function sendWithTypingSimulation(
	channel: TextChannel,
	chunks: string[],
): Promise<void> {
	if (!chunks.length) return;

	// Constants for typing simulation
	const BASE_TYPE_SPEED = 10; // ms per character (average human typing speed ~80-120 WPM)
	const MAX_TYPING_TIME = 5000; // cap at 5 seconds for very long messages
	const MIN_RANDOM_PAUSE = 300; // minimum pause between messages
	const MAX_RANDOM_PAUSE = 2000; // maximum pause between messages
	const THINKING_PAUSE_CHANCE = 0.3; // 30% chance of a longer "thinking" pause

	log.info(`Humanizer: Sending ${chunks.length} chunks with typing simulation`);
	// 1. Send the first chunk immediately without delay
	if (chunks.length > 0) {
		await channel.send(chunks[0]);
		log.info("Humanizer: Sent first chunk immediately");
	}

	for (let i = 1; i < chunks.length; i++) {
		const chunk = chunks[i];

		// 1. Start typing indicator
		await channel.sendTyping();

		// 2. Calculate a realistic typing delay
		// Formula: length × speed, but capped to avoid extremely long waits
		let typingTime = Math.min(chunk.length * BASE_TYPE_SPEED, MAX_TYPING_TIME);

		// Adjust typing time based on chunk complexity (code blocks take longer)
		if (chunk.includes("```")) {
			typingTime *= 1.5; // Code blocks take longer to "type"
		}

		// 3. Wait for the calculated typing time
		log.info(`Humanizer: Simulating typing for ${Math.round(typingTime)}ms`);
		await new Promise((resolve) => setTimeout(resolve, typingTime));

		// 4. Send the message
		await channel.send(chunk);

		// 5. Add a random pause between chunks (simulates thinking)
		if (i < chunks.length - 1) {
			// Determine if this should be a longer "thinking" pause
			const isThinkingPause = Math.random() < THINKING_PAUSE_CHANCE;

			let pauseTime = Math.floor(
				MIN_RANDOM_PAUSE +
					Math.random() * (MAX_RANDOM_PAUSE - MIN_RANDOM_PAUSE),
			);

			// Longer pause if "thinking"
			if (isThinkingPause) {
				pauseTime *= 2;
				// Show typing indicator again briefly during the thinking pause
				setTimeout(() => {
					channel
						.sendTyping()
						.catch((err) =>
							log.error("Error sending typing indicator during pause:", err),
						);
				}, pauseTime / 2);
			}

			log.info(
				`Humanizer: Pausing for ${pauseTime}ms${isThinkingPause ? " (thinking pause)" : ""}`,
			);
			await new Promise((resolve) => setTimeout(resolve, pauseTime));
		}
	}
}
