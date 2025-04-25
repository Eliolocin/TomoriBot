/**
 * Replaces template variables in a text string with their corresponding values.
 *
 * This function searches for placeholders in the format `{variableName}` in the input text
 * and replaces them with the values provided in the variables object.
 *
 * @param text - The template string containing placeholders to be replaced
 * @param variables - An object mapping variable names to their values
 * @returns The text with all placeholders replaced with their corresponding values
 *
 * @example
 * ```ts
 * const template = "Hello, {name}! Welcome to {location}.";
 * const vars = { name: "John", location: "Paris" };
 * const result = replaceTemplateVariables(template, vars);
 * // result: "Hello, John! Welcome to Paris."
 * ```
 */
export function replaceTemplateVariables(
	text: string,
	variables: Record<string, string | undefined>,
): string {
	let result = text;

	// Process each variable replacement
	for (const [placeholder, value] of Object.entries(variables)) {
		if (value) {
			const regex = new RegExp(`{${placeholder}}`, "g");
			result = result.replace(regex, value);
		}
	}

	return result;
}

/**
 * Gets the current time in a formatted string
 * @returns Current time in format "Month Day, Year | Hour:Minutes AM/PM | Weekday"
 */
export function getCurrentTime(): string {
	const monthNames = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	];
	const date = new Date();
	const weekday = getDayOfWeek(date);
	const day = date.getDate();
	const year = date.getFullYear();
	let hour = date.getHours();
	const minutes = date.getMinutes().toString().padStart(2, "0");
	let mid = "AM";

	if (hour === 0) {
		// Midnight case
		hour = 12;
	} else if (hour === 12) {
		// Noon case
		mid = "PM";
	} else if (hour > 12) {
		// Afternoon/Evening case
		hour = hour % 12;
		mid = "PM";
	}

	const month = monthNames[date.getMonth()];
	return `${month} ${day}, ${year} | ${hour}:${minutes} ${mid} | ${weekday}`;
}

/**
 * Gets the day name for a given date
 * @param date - Date object to get day name from
 * @returns The name of the day (e.g., "Monday")
 */
function getDayOfWeek(date: Date): string {
	const dayOfWeek = new Date(date).getDay();
	return Number.isNaN(dayOfWeek)
		? ""
		: [
				"Sunday",
				"Monday",
				"Tuesday",
				"Wednesday",
				"Thursday",
				"Friday",
				"Saturday",
			][dayOfWeek];
}

/**
 * Splits a long message into smaller chunks for Discord's limits, preserving code blocks and natural breakpoints
 * @param inputText - Text to split into chunks
 * @param humanizerIsEnabled - When true, also breaks messages at consecutive newlines *outside* of code blocks
 * @param chunkLength - Optional max length for each chunk (defaults to 1900, just below Discord's 2000 char limit)
 * @returns Array of message chunks under Discord's limit
 */
export function chunkMessage(
	inputText: string,
	humanizerDegree: number,
	chunkLength = 1900,
): string[] {
	// 1. Initialize and handle empty input
	const chunkedMessages: string[] = [];
	if (!inputText || inputText.length === 0) {
		return chunkedMessages;
	}

	// 2. Find all code blocks first to treat them as atomic units (unless they exceed chunkLength)
	const codeBlockRegex = /```(?:(\w+)\n)?([\s\S]*?)```/g;
	const blocks: Array<{
		content: string;
		isCode: boolean;
		start: number;
		end: number;
	}> = [];
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: Separate match assignment from null check
	while ((match = codeBlockRegex.exec(inputText)) !== null) {
		// 2a. Add text segment before the code block
		if (match.index > lastIndex) {
			blocks.push({
				content: inputText.substring(lastIndex, match.index),
				isCode: false,
				start: lastIndex,
				end: match.index,
			});
		}
		// 2b. Add the code block itself
		blocks.push({
			content: match[0],
			isCode: true,
			start: match.index,
			end: match.index + match[0].length,
		});
		lastIndex = match.index + match[0].length;
	}
	// 2c. Add any remaining text after the last code block
	if (lastIndex < inputText.length) {
		blocks.push({
			content: inputText.substring(lastIndex),
			isCode: false,
			start: lastIndex,
			end: inputText.length,
		});
	}

	// 3. Process blocks (text segments and code blocks) in order
	let currentChunk = "";

	for (const block of blocks) {
		if (block.isCode) {
			// 3a. Handle Code Blocks (existing logic is mostly fine)
			// Check if adding the code block exceeds the limit
			if (currentChunk.length + block.content.length > chunkLength) {
				// Finish current chunk if it has content
				if (currentChunk.length > 0) {
					chunkedMessages.push(currentChunk);
					currentChunk = "";
				}
				// If code block itself is too large, split it
				if (block.content.length > chunkLength) {
					const codeChunks = splitCodeBlock(block.content, chunkLength);
					chunkedMessages.push(...codeChunks);
				} else {
					// Add the whole code block as a new chunk
					chunkedMessages.push(block.content);
				}
			} else {
				// Code block fits, add it to the current chunk (prepend newline if needed)
				currentChunk += (currentChunk.length > 0 ? "\n" : "") + block.content;
			}
		} else {
			// 3b. Handle Text Segments (Integrate Humanizer Logic Here)
			const textToAdd = block.content;

			if (humanizerDegree >= 2) {
				// 3b-i. Split *this text segment* by any newlines (single or consecutive)
				const subSegments = textToAdd.split(/(\n+)/); // Keep separators to identify breaks

				for (let i = 0; i < subSegments.length; i++) {
					const subSegment = subSegments[i];
					if (!subSegment) continue; // Skip empty strings

					// If it's a separator (\n+) and we have content, force a chunk break
					if (subSegment.match(/^\n+$/) && currentChunk.length > 0) {
						chunkedMessages.push(currentChunk);
						currentChunk = "";
						continue; // Don't add the separator itself
					}

					// Process the actual text part using addTextSegment logic
					currentChunk = addTextSegment(
						subSegment,
						currentChunk,
						chunkedMessages,
						chunkLength,
					);
				}
			} else {
				// 3b-ii. Not humanizing, process the whole text segment normally
				currentChunk = addTextSegment(
					textToAdd,
					currentChunk,
					chunkedMessages,
					chunkLength,
				);
			}
		}
	}

	// 4. Add the final remaining chunk if not empty
	if (currentChunk.length > 0) {
		chunkedMessages.push(currentChunk);
	}

	// 5. Handle edge case: input text was non-empty but resulted in zero chunks (should be rare)
	if (chunkedMessages.length === 0 && inputText.length > 0) {
		// Fallback to simple chunking by length
		let remainingInput = inputText;
		while (remainingInput.length > 0) {
			const chunk = remainingInput.substring(0, chunkLength);
			chunkedMessages.push(chunk);
			remainingInput = remainingInput.substring(chunkLength);
		}
	}

	return chunkedMessages;
}

/**
 * Helper function to split text by newlines and respect chunk size limits
 * @param text - Text to split
 * @param chunkLength - Maximum chunk length
 * @returns Array of chunked messages
 */
function splitByNewlines(text: string, chunkLength: number): string[] {
	const lines = text.split("\n");
	const chunks: string[] = [];
	let currentChunk = "";

	for (const line of lines) {
		// If adding this line would exceed chunk size
		if (currentChunk.length + line.length + 1 > chunkLength) {
			// Save current chunk if not empty
			if (currentChunk.length > 0) {
				chunks.push(currentChunk);
				currentChunk = "";
			}

			// If the line itself is too long, split it
			if (line.length > chunkLength) {
				// Split at word boundaries when possible
				let remainingLine = line;
				while (remainingLine.length > 0) {
					// Try to find a space to break at
					const breakPoint = findBreakPoint(remainingLine, chunkLength);
					const chunk = remainingLine.substring(0, breakPoint);
					chunks.push(chunk);
					remainingLine = remainingLine.substring(breakPoint);
				}
			} else {
				// Line fits in a new chunk
				currentChunk = line;
			}
		} else {
			// Line fits in current chunk
			currentChunk = currentChunk ? `${currentChunk}\n${line}` : line;
		}
	}

	// Add the last chunk if not empty
	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}

	return chunks;
}

/**
 * Helper function to find a good breakpoint in text that exceeds chunk length
 * @param text - Text to find breakpoint in
 * @param maxLength - Maximum length to look within
 * @returns Index where text should be broken
 */
function findBreakPoint(text: string, maxLength: number): number {
	// If text is shorter than max length, return its full length
	if (text.length <= maxLength) {
		return text.length;
	}

	// Try to break at a space within the last ~10% of the max length
	const preferredBreakZone = Math.floor(maxLength * 0.9);
	for (let i = maxLength; i >= preferredBreakZone; i--) {
		if (text[i] === " ") {
			return i + 1; // Break after the space
		}
	}

	// If no good breakpoint found, just break at the max length
	return maxLength;
}

/**
 * Helper function to split code blocks when they're too large
 * @param codeBlock - The code block text including the ``` markers
 * @param chunkLength - Maximum chunk length
 * @returns Array of code block chunks
 */
function splitCodeBlock(codeBlock: string, chunkLength: number): string[] {
	const chunks: string[] = [];

	// Extract language and content from code block
	const match = codeBlock.match(/```(\w+)?\n?([\s\S]*?)```/);
	if (!match) {
		// Shouldn't happen, but handle just in case
		return [codeBlock.substring(0, chunkLength)];
	}

	const language = match[1] || "";
	const content = match[2];

	// Split content into lines
	const lines = content.split("\n");
	let currentChunk = `\`\`\`${language}\n`;

	for (const line of lines) {
		// If adding this line would exceed limit
		if (currentChunk.length + line.length + 1 + 3 > chunkLength) {
			// +3 for the closing ```
			// Finish current chunk
			currentChunk += "```";
			chunks.push(currentChunk);

			// Start new chunk
			currentChunk = `\`\`\`${language}\n${line}`;
		} else {
			// Add line to current chunk
			currentChunk +=
				(currentChunk.endsWith("\n") ||
				currentChunk.endsWith(`\`\`\`${language}\n`)
					? ""
					: "\n") + line;
		}
	}

	// Add the last chunk if not empty
	if (currentChunk.length > 0 && !currentChunk.endsWith("```")) {
		currentChunk += "```";
		chunks.push(currentChunk);
	}

	return chunks;
}

/**
 * Helper function to add a text segment to the current chunk or push to chunks array
 * @param text - Text segment to add
 * @param currentChunk - Current chunk being built
 * @param chunks - Array of completed chunks
 * @param chunkLength - Maximum chunk length
 * @returns Updated current chunk
 */
function addTextSegment(
	text: string,
	currentChunk: string,
	chunks: string[],
	chunkLength: number,
): string {
	// If empty text, return current chunk unchanged
	if (!text) return currentChunk;
	let segmentedChunk = currentChunk;

	// If text won't fit in current chunk
	if (segmentedChunk.length + text.length > chunkLength) {
		// Save current chunk if not empty
		if (segmentedChunk.length > 0) {
			chunks.push(segmentedChunk);
			segmentedChunk = "";
		}

		// Process the text segment using newline splitting
		const textChunks = splitByNewlines(text, chunkLength);

		// Add all but the last chunk directly to chunks array
		if (textChunks.length > 1) {
			chunks.push(...textChunks.slice(0, -1));
			segmentedChunk = textChunks[textChunks.length - 1];
		} else if (textChunks.length === 1) {
			segmentedChunk = textChunks[0];
		}
	} else {
		// Text segment fits in current chunk
		segmentedChunk += (segmentedChunk.length > 0 ? "\n" : "") + text;
	}

	return segmentedChunk;
}

/**
 * Cleans raw LLM output for Discord display
 * @param text - Raw text from LLM
 * @param botName - Optional bot name to remove from response
 * @returns Cleaned text suitable for Discord messages
 */
export function cleanLLMOutput(text: string, botName?: string): string {
	let cleanedText = text
		.replace(/\n{3,}/g, "\n\n")
		.replace(/<\|im_end\|>(\s*)$/, "")
		.replace(/<\|file_separator\|>(\s*)$/, "")
		// Remove failed emoji attempts like ":smile:", ":thumbsup:", etc.
		.replace(/\s+:[a-zA-Z0-9_]+:\s+/g, " ")
		.trim();

	if (botName) {
		const prefix = `${botName}:`;
		if (cleanedText.startsWith(prefix)) {
			cleanedText = cleanedText.slice(prefix.length);
		}
	}

	// Only remove speaker indicator if it's on the last line of the response
	return cleanedText.replace(/\n([^:]+):$/g, "");
}

/**
 * Helper to format basic input text to be more "AI"
 * @param text - Raw input text
 * @param options - Text formatting options
 * @param options.capitalizeFirst - Capitalize the first letter.
 * @param options.addPeriod - Add a period if one isn't present at the end.
 * @returns Formatted text with requested transformations
 */
export function formatText(
	text: string,
	options: {
		capitalizeFirst?: boolean;
		addPeriod?: boolean;
	} = {},
): string {
	let result = text.trim();

	if (options.capitalizeFirst && result.length > 0) {
		const firstChar = result.charAt(0);
		if (/[a-zA-Z]/.test(firstChar)) {
			result = firstChar.toUpperCase() + result.slice(1);
		}
	}

	if (options.addPeriod && result.length > 0) {
		if (!/[.,:!?]$/.test(result)) {
			result = `${result}.`;
		}
	}

	return result;
}
