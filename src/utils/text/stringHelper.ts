import { HumanizerDegree } from "@/types/db/schema";
/**
 * Creates a regex pattern for splitting sentences while preserving common abbreviations.
 *
 * This function generates a regex that splits on periods and Japanese periods (。) but avoids
 * splitting on common abbreviations, numbered lists, and other period-containing patterns.
 *
 * @returns A RegExp that can be used to split text into sentences
 */
function createSentenceSplitRegex(): RegExp {
	// 1. Common title abbreviations
	const titles = ["mr", "mrs", "ms", "dr", "prof", "rev", "fr", "sr", "jr"];

	// 2. Business and organization abbreviations
	const business = ["inc", "ltd", "co", "corp", "llc", "vs"];

	// 3. Common Latin abbreviations (with and without middle periods)
	const latin = ["etc", "e\\.g", "eg", "i\\.e", "ie", "cf", "viz", "ibid"];

	// 4. Academic degrees and titles
	const academic = ["phd", "md", "ba", "ma", "bs", "ms", "jd", "dds"];

	// 5. Geographic and governmental
	const geographic = ["us", "uk", "usa", "ussr", "eu"];

	// 6. Address and location abbreviations
	const address = ["st", "ave", "blvd", "rd", "ln", "ct", "pl", "dr"];

	// 7. Reference and document abbreviations
	const reference = ["no", "vol", "fig", "ref", "pp", "p", "ch", "sec"];

	// 8. Month abbreviations
	const months = [
		"jan",
		"feb",
		"mar",
		"apr",
		"may",
		"jun",
		"jul",
		"aug",
		"sep",
		"oct",
		"nov",
		"dec",
	];

	// 9. Day abbreviations
	const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

	// 10. Combine all abbreviations into one array
	const allAbbreviations = [
		...titles,
		...business,
		...latin,
		...academic,
		...geographic,
		...address,
		...reference,
		...months,
		...days,
	];

	// 11. Create the abbreviations pattern (word boundary + abbreviation)
	const abbreviationsPattern = `\\b(?:${allAbbreviations.join("|")})`;

	// 12. Pattern for acronyms with periods (e.g., H.I.F., A.I.M.)
	const acronymPattern = "(?:[A-Z]\\.[A-Z]\\.(?:[A-Z]\\.)*)";

	// 13. Complete negative lookbehind pattern: abbreviations OR digits OR acronyms
	const negativeLookbehind = `(?<!(?:${abbreviationsPattern}|\\d|${acronymPattern}))`;

	// 14. Split on regular periods (.) with whitespace/end OR Japanese periods (。)
	const sentenceEnd = "(?:\\.|。(?=\\s|$)|。)";

	// 15. Return the complete regex with case-insensitive flag
	return new RegExp(`${negativeLookbehind}${sentenceEnd}`, "i");
}

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
 * @param humanizerDegree - Controls how aggressive text chunking should be (0-3)
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

	// 2. Find all code blocks and emojis first to treat them as atomic units
	const blocks: Array<{
		content: string;
		type:
			| "text"
			| "code"
			| "emoji"
			| "url"
			| "quoted"
			| "parenthesized"
			| "japanese_quoted"
			| "markdown_bold"
			| "markdown_italic"
			| "markdown_strikethrough"
			| "markdown_inline_code"
			| "markdown_link";
		start: number;
		end: number;
	}> = [];

	// 2a. First pass: Find code blocks
	const codeBlockRegex = /```(?:(\w+)\n)?([\s\S]*?)```/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: Separate match assignment from null check
	while ((match = codeBlockRegex.exec(inputText)) !== null) {
		// Add text segment before the code block
		if (match.index > lastIndex) {
			blocks.push({
				content: inputText.substring(lastIndex, match.index),
				type: "text",
				start: lastIndex,
				end: match.index,
			});
		}
		// Add the code block itself
		blocks.push({
			content: match[0],
			type: "code",
			start: match.index,
			end: match.index + match[0].length,
		});
		lastIndex = match.index + match[0].length;
	}

	// Add any remaining text after the last code block
	if (lastIndex < inputText.length) {
		blocks.push({
			content: inputText.substring(lastIndex),
			type: "text",
			start: lastIndex,
			end: inputText.length,
		});
	}

	// 2a-2. Second pass: Find URLs in text blocks and treat them as atomic units
	const urlProcessedBlocks: typeof blocks = [];
	
	for (const block of blocks) {
		if (block.type !== "text") {
			// Keep non-text blocks (code blocks) as is
			urlProcessedBlocks.push(block);
			continue;
		}

		const textContent = block.content;
		const urlRegex = /(https?|ftps?):\/\/[^\s<>\[\](){}'"]+/g;
		
		let textLastIndex = 0;
		let urlMatch: RegExpExecArray | null;
		
		// Find all URLs in this text block
		// biome-ignore lint/suspicious/noAssignInExpressions: Separate URL match assignment from null check
		while ((urlMatch = urlRegex.exec(textContent)) !== null) {
			// Add text before URL if any
			if (urlMatch.index > textLastIndex) {
				urlProcessedBlocks.push({
					content: textContent.substring(textLastIndex, urlMatch.index),
					type: "text",
					start: block.start + textLastIndex,
					end: block.start + urlMatch.index,
				});
			}
			
			// Add the URL as an atomic unit
			urlProcessedBlocks.push({
				content: urlMatch[0],
				type: "url",
				start: block.start + urlMatch.index,
				end: block.start + urlMatch.index + urlMatch[0].length,
			});
			
			textLastIndex = urlMatch.index + urlMatch[0].length;
		}
		
		// Add any remaining text after the last URL
		if (textLastIndex < textContent.length) {
			urlProcessedBlocks.push({
				content: textContent.substring(textLastIndex),
				type: "text",
				start: block.start + textLastIndex,
				end: block.start + textContent.length,
			});
		}
	}

	// 2b. Third pass: Split text blocks to find quotes and parentheses
	const quotedBlocks: typeof blocks = [];

	// Process each text block to find quotes and parentheses
	for (const block of urlProcessedBlocks) {
		if (block.type !== "text") {
			// Keep non-text blocks as is
			quotedBlocks.push(block);
			continue;
		}

		const textContent = block.content;
		const foundSemanticBlocks: Array<{
			start: number;
			end: number;
			content: string;
			type:
				| "quoted"
				| "parenthesized"
				| "japanese_quoted"
				| "markdown_bold"
				| "markdown_italic"
				| "markdown_strikethrough"
				| "markdown_inline_code"
				| "markdown_link";
		}> = [];
		let searchIndex = 0;

		// Find all semantic blocks (quotes, parentheses, markdown) in this text block
		while (searchIndex < textContent.length) {
			const quotedString = findQuotedString(textContent, searchIndex);
			const parenthesized = findBalancedParentheses(textContent, searchIndex);
			const japaneseQuoted = findJapaneseQuotedString(textContent, searchIndex);

			// Markdown formatting
			const markdownBold = findMarkdownBold(textContent, searchIndex);
			const markdownItalic = findMarkdownItalic(textContent, searchIndex);
			const markdownStrike = findMarkdownStrikethrough(
				textContent,
				searchIndex,
			);
			const markdownInlineCode = findMarkdownInlineCode(
				textContent,
				searchIndex,
			);
			const markdownLink = findMarkdownLink(textContent, searchIndex);

			// Find the earliest occurring semantic block
			const candidates = [
				quotedString ? { ...quotedString, type: "quoted" as const } : null,
				parenthesized
					? { ...parenthesized, type: "parenthesized" as const }
					: null,
				japaneseQuoted
					? { ...japaneseQuoted, type: "japanese_quoted" as const }
					: null,
				markdownBold,
				markdownItalic,
				markdownStrike,
				markdownInlineCode,
				markdownLink,
			].filter(
				(candidate): candidate is NonNullable<typeof candidate> =>
					candidate !== null,
			);

			if (candidates.length === 0) break;

			// Sort by start position and take the first one
			const earliest = candidates.sort((a, b) => a.start - b.start)[0];
			foundSemanticBlocks.push(earliest);
			searchIndex = earliest.end;
		}

		// Split the text block around the found semantic blocks
		if (foundSemanticBlocks.length === 0) {
			// No semantic blocks found, keep the text block as is
			quotedBlocks.push(block);
		} else {
			let currentIndex = 0;

			for (const semanticBlock of foundSemanticBlocks) {
				// Add text before the semantic block if any
				if (semanticBlock.start > currentIndex) {
					quotedBlocks.push({
						content: textContent.substring(currentIndex, semanticBlock.start),
						type: "text",
						start: block.start + currentIndex,
						end: block.start + semanticBlock.start,
					});
				}

				// Add the semantic block as its own block
				quotedBlocks.push({
					content: semanticBlock.content,
					type: semanticBlock.type,
					start: block.start + semanticBlock.start,
					end: block.start + semanticBlock.end,
				});

				currentIndex = semanticBlock.end;
			}

			// Add any remaining text after the last semantic block
			if (currentIndex < textContent.length) {
				quotedBlocks.push({
					content: textContent.substring(currentIndex),
					type: "text",
					start: block.start + currentIndex,
					end: block.start + textContent.length,
				});
			}
		}
	}

	// 2c. Third pass: Split remaining text blocks to separate emojis
	const emojiPattern = /<(a?):([^:]+):([^>]+)>/g;
	const processedBlocks: typeof blocks = [];

	// Process each text block to find emojis
	for (const block of quotedBlocks) {
		if (block.type !== "text") {
			// Keep code blocks, quotes, parentheses, and Japanese quotes as is
			processedBlocks.push(block);
			continue;
		}

		// Reset for emoji matching within this text block
		const textContent = block.content;
		lastIndex = 0;
		let emojiMatch: RegExpExecArray | null;

		// biome-ignore lint/suspicious/noAssignInExpressions: Separate emoji match assignment from null check
		while ((emojiMatch = emojiPattern.exec(textContent)) !== null) {
			// Add text before emoji if any
			if (emojiMatch.index > lastIndex) {
				processedBlocks.push({
					content: textContent.substring(lastIndex, emojiMatch.index),
					type: "text",
					start: block.start + lastIndex,
					end: block.start + emojiMatch.index,
				});
			}

			// Add the emoji as an atomic unit
			processedBlocks.push({
				content: emojiMatch[0],
				type: "emoji",
				start: block.start + emojiMatch.index,
				end: block.start + emojiMatch.index + emojiMatch[0].length,
			});

			lastIndex = emojiMatch.index + emojiMatch[0].length;
		}

		// Add remaining text after the last emoji
		if (lastIndex < textContent.length) {
			processedBlocks.push({
				content: textContent.substring(lastIndex),
				type: "text",
				start: block.start + lastIndex,
				end: block.start + textContent.length,
			});
		}
	}

	// 3. Merge semantic blocks with adjacent text blocks for natural flow
	// This allows quotes/parentheses to flow with surrounding text while preserving atomicity
	const mergedBlocks: typeof processedBlocks = [];
	let i = 0;

	while (i < processedBlocks.length) {
		const currentBlock = processedBlocks[i];

		if (
			currentBlock.type === "quoted" ||
			currentBlock.type === "parenthesized" ||
			currentBlock.type === "japanese_quoted" ||
			currentBlock.type === "markdown_bold" ||
			currentBlock.type === "markdown_italic" ||
			currentBlock.type === "markdown_strikethrough" ||
			currentBlock.type === "markdown_inline_code" ||
			currentBlock.type === "markdown_link"
		) {
			// Found semantic block - look for adjacent text blocks to merge
			let mergedContent = "";
			let hasContent = false;

			// Check for preceding text block
			if (
				i > 0 &&
				processedBlocks[i - 1].type === "text" &&
				mergedBlocks.length > 0 &&
				mergedBlocks[mergedBlocks.length - 1].type === "text"
			) {
				// Remove the previous text block and include its content
				const prevBlock = mergedBlocks.pop();
				if (prevBlock) {
					mergedContent += prevBlock.content;
					hasContent = true;
				}
			}
			// Add the semantic block content
			mergedContent += currentBlock.content;
			hasContent = true;

			// Check for following text block
			if (
				i + 1 < processedBlocks.length &&
				processedBlocks[i + 1].type === "text"
			) {
				mergedContent += processedBlocks[i + 1].content;
				i++; // Skip the next text block as we've consumed it
			}

			if (hasContent) {
				mergedBlocks.push({
					...currentBlock,
					type: "text", // Convert to text type for natural flow
					content: mergedContent,
				});
			}
		} else {
			// Non-semantic block, keep as-is
			mergedBlocks.push(currentBlock);
		}

		i++;
	}

	// 4. Process all blocks in order
	let currentChunk = "";

	for (const block of mergedBlocks) {
		// Handle each block type appropriately
		switch (block.type) {
			case "code":
				// 3a. Handle Code Blocks - same as before
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
					// Code block fits, add it to current chunk
					currentChunk += (currentChunk.length > 0 ? "\n" : "") + block.content;
				}
				break;

			case "emoji":
				// 3b. Handle Emojis - always treated as their own chunk
				// First, save any current chunk
				if (currentChunk.length > 0) {
					chunkedMessages.push(currentChunk);
					currentChunk = "";
				}

				// Add emoji as its own standalone chunk
				chunkedMessages.push(block.content);
				break;

			case "url":
				// 3c. Handle URLs - treat as atomic units like code blocks
				if (currentChunk.length + block.content.length > chunkLength) {
					// Finish current chunk if it has content
					if (currentChunk.length > 0) {
						chunkedMessages.push(currentChunk);
						currentChunk = "";
					}
					// URLs are atomic and shouldn't be split, add as new chunk
					chunkedMessages.push(block.content);
				} else {
					// URL fits, add it to current chunk with appropriate spacing
					currentChunk += (currentChunk.length > 0 && !currentChunk.endsWith(" ") ? " " : "") + block.content;
				}
				break;

			// Semantic blocks (quoted, parenthesized, japanese_quoted) are now merged with text blocks above

			case "text": {
				// 3c. Handle Text - based on humanizer degree
				const textToAdd = block.content.trim();
				if (!textToAdd) continue; // Skip empty text

				if (humanizerDegree < HumanizerDegree.HEAVY) {
					// 3c-i. Break at newlines, keep punctuation
					const paragraphs = textToAdd.split(/\n+/);

					for (const paragraph of paragraphs) {
						if (!paragraph.trim()) continue;
						chunkedMessages.push(paragraph);
					}
				} else if (humanizerDegree >= HumanizerDegree.HEAVY) {
					// 3c-ii. Humanizer Degree 3+: Break at newlines AND sentence endings
					const paragraphs = textToAdd.split(/\n+/);

					for (let paragraph of paragraphs) {
						if (!paragraph.trim()) continue;

						//chunkedMessages.push(paragraph);
						// Compensate for ... period deletion by adding one more period
						// Replace exactly three periods with four periods when they aren't part of a longer sequence
						paragraph = paragraph.replace(/\.{3}(?!\.)(?!\d)/g, "....");

						// Remove all commas from the text
						// paragraph = paragraph.replace(/,/g, ""); Already in humanizer

						// Split on periods at end of sentences but skip common abbreviations and numbered lists like "1.", "2.", etc.
						// Also handles Japanese period (。) as a sentence boundary
						const sentences = paragraph.split(createSentenceSplitRegex());

						// Then split by sentence endings but keep the punctuation
						// This looks for punctuation followed by end of string

						//const sentences = paragraph.split(/(?<=[.])(?=\s|$)/);

						/*

						for (const sentence of sentences) {
							const trimmedSentence = sentence.trim();
							if (!trimmedSentence) continue;

							// Add this processed sentence as its own chunk
							chunkedMessages.push(trimmedSentence);
						}*/

						for (let sentence of sentences) {
							sentence = sentence.trim();
							if (!sentence) continue;

							// Process ending punctuation
							let processedSentence = sentence;
							// Ensure we don't shorten "..." to ".." here.
							// Only remove a trailing period if it's a single period, not part of an ellipsis.
							if (
								(sentence.endsWith(".") || sentence.endsWith("。")) &&
								!sentence.endsWith("...")
							) {
								// MODIFIED LINE
								processedSentence = sentence.slice(0, -1).trim();
							}

							if (!processedSentence) continue;

							if (currentChunk.length > 0) {
								chunkedMessages.push(currentChunk);
								currentChunk = "";
							}

							chunkedMessages.push(processedSentence);
						}
					}
				} else {
					// 3c-iii. Low or no humanization, use normal text chunking
					currentChunk = addTextSegment(
						textToAdd,
						currentChunk,
						chunkedMessages,
						chunkLength,
					);
				}
				break;
			}
		}
	}

	// 4. Add the final remaining chunk if not empty
	if (currentChunk.length > 0) {
		chunkedMessages.push(currentChunk);
	}

	// 5. Handle edge case: input text was non-empty but resulted in zero chunks
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
 * @param emojiStrings - Array of properly formatted Discord emoji strings
 * @returns Cleaned text suitable for Discord messages
 */
export function cleanLLMOutput(
	text: string,
	botName?: string,
	emojiStrings?: string[],
	emojiUsageEnabled = true, // New parameter, defaults to true
): string {
	// 1. Basic whitespace and separator cleanup
	if (text.startsWith("```") || text.endsWith("```")) return text;
	let cleanedText = text
		.replace(/\n{3,}/g, "\n\n")
		.replace(/<\|im_end\|>(\s*)$/, "")
		.replace(/<\|file_separator\|>(\s*)$/, "") // Old Gemini bug when using inline markers
		// Replace bold/italic markers around angle brackets that can break emoji syntax
		.replace(/\*\*<(.*?)>\*\*/g, "<$1>") // Bold **<emoji>**
		.replace(/\*<(.*?)>\*/g, "<$1>") // Italic *<emoji>*
		.replace(/<([a-zA-Z0-9_]+)>[\s\S]*?<\/\1>/g, "")
		.replace(new RegExp(`^${botName ? botName : "Tomori"}:\\s*`, "i"), "") // Remove bot name prefix from start of text
		.trim();

	// 2. Emoji handling, only if we have a list of valid emojis
	if (emojiUsageEnabled === false)
		cleanedText = cleanedText.replace(/<(a?):[^:]+:[^>]+>/g, "");
	else if (emojiStrings && emojiStrings.length > 0) {
		// 2.1 Build a set of exact valid emoji strings
		const validEmojiSet = new Set(emojiStrings);

		// 2.1.5 Normalize any malformed emoji tags
		// like "<_name:id>" or "<(Name:id>"
		// to proper "<:name:id>"
		cleanedText = cleanedText.replace(
			/<[^:>\s]*:([A-Za-z0-9_]+):(\d+)>/g,
			"<:$1:$2>",
		);

		// 2.2 Build a map from emoji name → its correct full format
		const emojiNameMap = new Map<string, string>();
		for (const emoji of emojiStrings) {
			// This matches anything inside <> that contains at least one colon
			// Could be <:name:id>, <a:name:id>, or any malformed variant
			// const EMOJI_ATTEMPT_PATTERN = /<(a?):?([^:>]+):?([^>]*)>/g;
			const m = emoji.match(/<(a?):([^:]+):([^>]+)>/);
			if (m) {
				const [, , name] = m;
				emojiNameMap.set(name, emoji);
			}
		}

		// 2.3 Protect valid emojis by replacing them with placeholders
		const preserved = new Map<string, string>();
		let placeholderCount = 0;
		for (const emoji of validEmojiSet) {
			const key = `__EMOJI_PLACEHOLDER_${placeholderCount++}__`;
			cleanedText = cleanedText.replace(
				new RegExp(escapeRegExp(emoji), "g"),
				key,
			);
			preserved.set(key, emoji);
		}

		// 2.4 Replace any :name: occurrences with the correct emoji
		for (const [name, full] of emojiNameMap.entries()) {
			const pattern = new RegExp(
				`(?<!<[^>]*)\\s*:${escapeRegExp(name)}:\\s*`,
				"g",
			);
			cleanedText = cleanedText.replace(pattern, ` ${full} `);
		}

		// 2.4.5 Handle empty‐ID emoji attempts like `<:name:>`
		cleanedText = cleanedText.replace(
			/<(a?):([^:>]+):?>/g, // match `<:name:>` or `<a:name:>`
			(_match, _animated, name) => {
				const canonical = emojiNameMap.get(name); // look up `:name:` in your map
				return canonical ?? ""; // replace with correct emoji or drop it
			},
		);

		// 2.5 Correct or drop any remaining <...> emoji attempts
		cleanedText = cleanedText.replace(
			/<(a?):([^:>]+):([^>]+)>/g,
			(_match, animated, name, id) => {
				const full = `<${animated}:${name}:${id}>`;
				// a) exact valid → keep
				if (validEmojiSet.has(full)) return full;
				// b) name match → use canonical
				const canonical = emojiNameMap.get(name);
				if (canonical) return canonical;
				// c) unknown → remove
				return "";
			},
		);

		// 2.6 Restore preserved valid emojis
		for (const [key, emoji] of preserved.entries()) {
			cleanedText = cleanedText.replace(
				new RegExp(escapeRegExp(key), "g"),
				emoji,
			);
		}
	}

	// 3. Remove bot name prefix if present
	if (botName) {
		const prefix = `${botName}:`;
		if (cleanedText.startsWith(prefix)) {
			cleanedText = cleanedText.slice(prefix.length);
		}
	}

	// 4. Final generic cleanup for any stray :name: patterns
	cleanedText = cleanedText.replace(/\s+:[a-zA-Z0-9_]+:\s+/g, " ");

	// 5. Remove trailing speaker indicator
	return cleanedText.replace(/\n([^:]+):$/, "");
}

/** Helper to escape special RegExp characters in a string */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Universal URL detection and protection function
 * Detects all URLs regardless of surrounding context (angle brackets, markdown, raw)
 * and replaces them with placeholders to protect from chunking and humanization
 * @param text - Text that may contain URLs
 * @returns Object with text containing placeholders and array of original URLs
 */
function detectAndProtectURLs(text: string): {
	protectedText: string;
	urls: string[];
} {
	const urls: string[] = [];
	
	// Universal URL regex: matches http(s), ftp(s) protocols
	// Stops at whitespace and common delimiters: <>[](){} and quotes
	// Handles trailing punctuation that's likely not part of the URL
	const urlRegex = /(https?|ftps?):\/\/[^\s<>\[\](){}'"]+/g;
	
	const protectedText = text.replace(urlRegex, (match) => {
		// Handle trailing punctuation that's likely not part of the URL
		// Common sentence endings: period, comma, semicolon at the very end
		let url = match;
		let trailingPunct = '';
		
		// Check if URL ends with punctuation that should be excluded
		const trailingPunctRegex = /[.,;]$/;
		if (trailingPunctRegex.test(url)) {
			trailingPunct = url.slice(-1);
			url = url.slice(0, -1);
		}
		
		urls.push(url);
		return `__URL_${urls.length - 1}__${trailingPunct}`;
	});
	
	return { protectedText, urls };
}

/**
 * Restore URLs from placeholders back to their original form
 * @param text - Text containing URL placeholders
 * @param urls - Array of original URLs
 * @returns Text with URLs restored
 */
function restoreURLsFromPlaceholders(text: string, urls: string[]): string {
	let restoredText = text;
	
	// Restore in reverse order to avoid index issues
	for (let i = urls.length - 1; i >= 0; i--) {
		const placeholder = `__URL_${i}__`;
		restoredText = restoredText.replace(new RegExp(escapeRegExp(placeholder), 'g'), urls[i]);
	}
	
	return restoredText;
}

/**
 * Helper function to find balanced parentheses in text
 * @param text - Text to search for parentheses
 * @param startIndex - Index to start searching from
 * @returns Object with start, end indices and content, or null if no balanced pair found
 */
function findBalancedParentheses(
	text: string,
	startIndex = 0,
): { start: number; end: number; content: string } | null {
	const openIndex = text.indexOf("(", startIndex);
	if (openIndex === -1) return null;

	let depth = 0;
	let closeIndex = -1;

	// Start scanning from the opening parenthesis
	for (let i = openIndex; i < text.length; i++) {
		if (text[i] === "(") {
			depth++;
		} else if (text[i] === ")") {
			depth--;
			if (depth === 0) {
				closeIndex = i;
				break;
			}
		}
	}

	if (closeIndex === -1) return null; // No matching closing parenthesis

	return {
		start: openIndex,
		end: closeIndex + 1,
		content: text.substring(openIndex, closeIndex + 1),
	};
}

/**
 * Helper function to find quoted strings with escape handling
 * @param text - Text to search for quotes
 * @param startIndex - Index to start searching from
 * @returns Object with start, end indices and content, or null if no complete quoted string found
 */
function findQuotedString(
	text: string,
	startIndex = 0,
): { start: number; end: number; content: string } | null {
	const openIndex = text.indexOf('"', startIndex);
	if (openIndex === -1) return null;

	let i = openIndex + 1;
	while (i < text.length) {
		if (text[i] === '"') {
			// Found closing quote
			return {
				start: openIndex,
				end: i + 1,
				content: text.substring(openIndex, i + 1),
			};
		} else if (text[i] === "\\") {
			// Skip escaped character
			i += 2;
		} else {
			i++;
		}
	}

	return null; // No matching closing quote
}

/**
 * Helper function to find Japanese quoted strings
 * @param text - Text to search for Japanese quotes
 * @param startIndex - Index to start searching from
 * @returns Object with start, end indices and content, or null if no complete quoted string found
 */
function findJapaneseQuotedString(
	text: string,
	startIndex = 0,
): { start: number; end: number; content: string } | null {
	const openIndex = text.indexOf("「", startIndex);
	if (openIndex === -1) return null;

	const closeIndex = text.indexOf("」", openIndex + 1);
	if (closeIndex === -1) return null;

	return {
		start: openIndex,
		end: closeIndex + 1,
		content: text.substring(openIndex, closeIndex + 1),
	};
}

/**
 * Helper function to find markdown bold text (**text** or __text__)
 * Prioritizes ** over __ when both are present
 */
function findMarkdownBold(
	text: string,
	startIndex = 0,
): {
	start: number;
	end: number;
	content: string;
	type: "markdown_bold";
} | null {
	// Look for **text** first (higher priority)
	const doubleStar = text.indexOf("**", startIndex);
	if (doubleStar !== -1) {
		const closing = text.indexOf("**", doubleStar + 2);
		if (closing !== -1) {
			return {
				start: doubleStar,
				end: closing + 2,
				content: text.substring(doubleStar, closing + 2),
				type: "markdown_bold",
			};
		}
	}

	// Look for __text__ as fallback
	const doubleUnderscore = text.indexOf("__", startIndex);
	if (doubleUnderscore !== -1) {
		const closing = text.indexOf("__", doubleUnderscore + 2);
		if (closing !== -1) {
			return {
				start: doubleUnderscore,
				end: closing + 2,
				content: text.substring(doubleUnderscore, closing + 2),
				type: "markdown_bold",
			};
		}
	}

	return null;
}

/**
 * Helper function to find markdown italic text (*text* or _text_)
 * Avoids conflicts with bold markers
 */
function findMarkdownItalic(
	text: string,
	startIndex = 0,
): {
	start: number;
	end: number;
	content: string;
	type: "markdown_italic";
} | null {
	// Look for *text* (avoiding ** bold markers)
	let singleStar = text.indexOf("*", startIndex);
	while (singleStar !== -1) {
		// Skip if part of ** bold marker
		if (singleStar > 0 && text[singleStar - 1] === "*") {
			singleStar = text.indexOf("*", singleStar + 1);
			continue;
		}
		if (singleStar < text.length - 1 && text[singleStar + 1] === "*") {
			singleStar = text.indexOf("*", singleStar + 2);
			continue;
		}

		// Find closing *
		const closing = text.indexOf("*", singleStar + 1);
		if (closing !== -1 && text[closing + 1] !== "*") {
			return {
				start: singleStar,
				end: closing + 1,
				content: text.substring(singleStar, closing + 1),
				type: "markdown_italic",
			};
		}
		singleStar = text.indexOf("*", singleStar + 1);
	}

	// Look for _text_ (avoiding __ bold markers)
	let singleUnderscore = text.indexOf("_", startIndex);
	while (singleUnderscore !== -1) {
		// Skip if part of __ bold marker
		if (singleUnderscore > 0 && text[singleUnderscore - 1] === "_") {
			singleUnderscore = text.indexOf("_", singleUnderscore + 1);
			continue;
		}
		if (
			singleUnderscore < text.length - 1 &&
			text[singleUnderscore + 1] === "_"
		) {
			singleUnderscore = text.indexOf("_", singleUnderscore + 2);
			continue;
		}

		// Find closing _
		const closing = text.indexOf("_", singleUnderscore + 1);
		if (closing !== -1 && text[closing + 1] !== "_") {
			return {
				start: singleUnderscore,
				end: closing + 1,
				content: text.substring(singleUnderscore, closing + 1),
				type: "markdown_italic",
			};
		}
		singleUnderscore = text.indexOf("_", singleUnderscore + 1);
	}

	return null;
}

/**
 * Helper function to find markdown strikethrough text (~~text~~)
 */
function findMarkdownStrikethrough(
	text: string,
	startIndex = 0,
): {
	start: number;
	end: number;
	content: string;
	type: "markdown_strikethrough";
} | null {
	const opening = text.indexOf("~~", startIndex);
	if (opening === -1) return null;

	const closing = text.indexOf("~~", opening + 2);
	if (closing === -1) return null;

	return {
		start: opening,
		end: closing + 2,
		content: text.substring(opening, closing + 2),
		type: "markdown_strikethrough",
	};
}

/**
 * Helper function to find markdown inline code (`text`)
 * Excludes code blocks (```)
 */
function findMarkdownInlineCode(
	text: string,
	startIndex = 0,
): {
	start: number;
	end: number;
	content: string;
	type: "markdown_inline_code";
} | null {
	let opening = text.indexOf("`", startIndex);
	while (opening !== -1) {
		// Skip if part of code block
		if (
			(opening > 1 && text.substring(opening - 2, opening) === "``") ||
			(opening < text.length - 2 &&
				text.substring(opening + 1, opening + 3) === "``")
		) {
			opening = text.indexOf("`", opening + 1);
			continue;
		}

		// Find closing `
		const closing = text.indexOf("`", opening + 1);
		if (closing !== -1) {
			// Make sure closing isn't part of code block either
			if (
				(closing > 1 && text.substring(closing - 2, closing) === "``") ||
				(closing < text.length - 2 &&
					text.substring(closing + 1, closing + 3) === "``")
			) {
				opening = text.indexOf("`", opening + 1);
				continue;
			}

			return {
				start: opening,
				end: closing + 1,
				content: text.substring(opening, closing + 1),
				type: "markdown_inline_code",
			};
		}
		opening = text.indexOf("`", opening + 1);
	}

	return null;
}

/**
 * Helper function to find markdown links ([text](url))
 */
function findMarkdownLink(
	text: string,
	startIndex = 0,
): {
	start: number;
	end: number;
	content: string;
	type: "markdown_link";
} | null {
	const openBracket = text.indexOf("[", startIndex);
	if (openBracket === -1) return null;

	const closeBracket = text.indexOf("]", openBracket + 1);
	if (closeBracket === -1) return null;

	// Check for immediately following (url)
	if (closeBracket + 1 >= text.length || text[closeBracket + 1] !== "(")
		return null;

	const closeParen = text.indexOf(")", closeBracket + 2);
	if (closeParen === -1) return null;

	return {
		start: openBracket,
		end: closeParen + 1,
		content: text.substring(openBracket, closeParen + 1),
		type: "markdown_link",
	};
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
	// 1. First, protect all URLs from any transformations
	const { protectedText: urlProtectedText, urls } = detectAndProtectURLs(text);
	
	// 2. Store code blocks and replace with placeholders
	const codeBlocks: string[] = [];
	const inlineCode: string[] = [];
	const senderStrings: string[] = [];

	// 3. Replace code blocks (```) with placeholders
	let processedText = urlProtectedText.replace(/```[\s\S]*?```/g, (match) => {
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
	// 5. Apply lowercase transformation to text outside code blocks,
	//    now including hyphenated words like "E-ew" or "D-don't" as single words
	processedText = processedText.replace(
		/\b([A-Za-z][A-Za-z'-]*)\b/g,
		(word) => {
			// 5.1 Check for all-uppercase acronyms (allow hyphens in acronyms if needed)
			const isAcronym = /^[A-Z](?:[A-Z'-]*[A-Z])?$/.test(word);
			// 5.2 Check for known internet expressions (lowercased set)
			const isInternet = INTERNET_EXPRESSIONS.has(word.toLowerCase());
			// 5.3 Preserve standalone single letters (e.g., "I", "B", "F" except "A" eg. "A book")
			const isSingleLetter = word.length === 1 && word !== "A";
			// If it's an acronym, internet expression, or single letter, leave it;
			// otherwise lowercase the whole hyphenated or single word.
			return isAcronym || isInternet || isSingleLetter
				? word
				: word.toLowerCase();
		},
	);

	// 6. Remove commas and semicolons but keep question marks and exclamation points
	processedText = processedText.replace(/[;,]/g, ""); // Remove periods, commas, semicolons, colons

	// 7. Fix potential issues with multiple punctuation
	//processedText = processedText.replace(/([?!])+/g, "$1"); // Replace multiple ???? or !!!! with single one

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

	// Last step: restore all protected URLs
	return restoreURLsFromPlaceholders(processedText, urls);
}

/**
 * Formats a boolean value into a user-friendly string ("Enabled" or "Disabled").
 * @param value - The boolean value to format.
 * @returns "Enabled" if true, "Disabled" if false.
 */
export function formatBoolean(value: boolean): string {
	return value ? "`Enabled`" : "`Disabled`";
}
