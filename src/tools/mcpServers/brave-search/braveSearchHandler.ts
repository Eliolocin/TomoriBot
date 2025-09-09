/**
 * Brave Search MCP Server Behavior Handler
 * Provider-agnostic logic for handling Brave Search MCP server responses
 * Extracted from googleToolAdapter.ts for modular, provider-independent usage
 */

import { AttachmentBuilder } from "discord.js";
import { log } from "../../../utils/misc/logger";
import type {
	MCPServerBehaviorHandler,
	MCPExecutionContext,
	MCPServerResponse,
	TypedMCPToolResult,
} from "../../../types/tool/mcpTypes";
import { MCPTypeGuards } from "../../../types/tool/mcpTypes";

/**
 * Brave Search MCP Server Behavior Handler
 * Handles all Brave Search specific logic including image processing,
 * web search enhancements, and parameter overrides
 */
export class BraveSearchHandler implements MCPServerBehaviorHandler {
	public readonly serverName = "brave-search";

	/**
	 * Supported Brave Search functions
	 */
	private readonly SUPPORTED_FUNCTIONS = [
		"brave_web_search",
		"brave_image_search",
		"brave_video_search",
		"brave_news_search",
		"brave_local_search",
		"brave_summarizer",
	];

	/**
	 * Default parameter overrides for Brave Search functions
	 */
	private readonly PARAMETER_OVERRIDES: Record<
		string,
		Record<string, unknown>
	> = {
		brave_web_search: {
			count: 20, // Limit to 20 articles
			summary: true,
			safesearch: "off", // Always disable safe search
		},
		brave_local_search: {
			safesearch: "off", // Disable safe search for local results too
		},
		brave_image_search: {
			count: 6, // Limit to 6 images
			safesearch: "off", // Disable safe search for images
		},
		brave_video_search: {
			count: 5, // Limit to 5 videos
			safesearch: "off", // Disable safe search for videos
		},
		brave_news_search: {
			safesearch: "off", // Disable safe search for news
		},
	};

	/**
	 * Check if this handler supports a specific function
	 * @param functionName - Function name to check
	 * @returns True if this handler supports the function
	 */
	public supportsFunction(functionName: string): boolean {
		return this.SUPPORTED_FUNCTIONS.includes(functionName);
	}

	/**
	 * Apply parameter overrides for Brave Search functions
	 * @param functionName - Name of the function
	 * @param originalArgs - Original arguments from the AI
	 * @returns Modified arguments with overrides applied
	 */
	public applyParameterOverrides(
		functionName: string,
		originalArgs: Record<string, unknown>,
	): {
		modifiedArgs: Record<string, unknown>;
		overridesApplied: string[];
	} {
		// Clone the original args to avoid mutation
		const modifiedArgs = { ...originalArgs };
		const overridesApplied: string[] = [];

		// Apply overrides if function has them configured
		const overrides = this.PARAMETER_OVERRIDES[functionName];
		if (overrides) {
			for (const [paramName, forcedValue] of Object.entries(overrides)) {
				const originalValue = modifiedArgs[paramName];
				modifiedArgs[paramName] = forcedValue;

				// Log when we override a parameter
				if (originalValue !== forcedValue) {
					overridesApplied.push(
						`${paramName}: ${originalValue} → ${forcedValue}`,
					);
				}
			}

			if (overridesApplied.length > 0) {
				log.info(
					`Applied Brave Search parameter overrides for ${functionName}: ${overridesApplied.join(", ")}`,
				);
			}
		}

		return { modifiedArgs, overridesApplied };
	}

	/**
	 * Process MCP function result before returning to LLM
	 * @param functionName - Name of the executed function
	 * @param mcpResult - Raw result from MCP server
	 * @param context - Execution context with Discord channel access
	 * @param args - Function arguments used
	 * @returns Processed tool result
	 */
	public async processResult(
		functionName: string,
		mcpResult: MCPServerResponse,
		context: MCPExecutionContext,
		args: Record<string, unknown>,
	): Promise<TypedMCPToolResult> {
		try {
			// Handle Brave Image Search with automatic Discord attachment sending
			if (functionName === "brave_image_search") {
				return await this.processBraveImageSearch(mcpResult, context, args);
			}

			// Handle Brave Web Search with fetch capability reminder
			if (functionName === "brave_web_search") {
				return await this.processBraveWebSearch(mcpResult, args);
			}

			// Handle other Brave Search functions with standard processing
			return this.processStandardBraveResult(
				functionName,
				mcpResult,
				context,
				args,
			);
		} catch (error) {
			log.error(`Failed to process ${functionName} result:`, error as Error);
			return {
				success: false,
				message: "Failed to process Brave Search result",
				error: error instanceof Error ? error.message : String(error),
				data: {
					source: "mcp",
					functionName,
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: Date.now() - context.executionStartTime,
					status: "failed",
				},
			};
		}
	}

	/**
	 * Process Brave Image Search results by extracting image URLs and sending as Discord attachments
	 * @param mcpResult - The raw MCP result from brave_image_search
	 * @param context - Execution context containing Discord channel
	 * @param args - The modified arguments used for the search (contains query)
	 * @returns Promise<TypedMCPToolResult> - Simplified result for the LLM
	 */
	private async processBraveImageSearch(
		mcpResult: MCPServerResponse,
		context: MCPExecutionContext,
		args: Record<string, unknown>,
	): Promise<TypedMCPToolResult> {
		try {
			const imageUrls = MCPTypeGuards.extractImageUrls(mcpResult);

			log.info(`Total image URLs extracted: ${imageUrls.length}`);

			if (imageUrls.length > 0) {
				// Create Discord attachments from image URLs
				const attachments: AttachmentBuilder[] = [];
				const failedUrls: string[] = [];

				for (let i = 0; i < imageUrls.length; i++) {
					try {
						const imageUrl = imageUrls[i];
						const attachment = new AttachmentBuilder(imageUrl, {
							name: `image_${i + 1}.jpg`, // Generic filename since we don't know the actual extension
						});
						attachments.push(attachment);
						log.info(`Prepared Discord attachment for image: ${imageUrl}`);
					} catch (attachmentError) {
						failedUrls.push(imageUrls[i]);
						log.warn(
							`Failed to create attachment for URL: ${imageUrls[i]}`,
							attachmentError as Error,
						);
					}
				}

				// Send attachments to Discord channel
				if (attachments.length > 0 && context.channel) {
					try {
						await context.channel.send({
							files: attachments,
							// content: `Found ${imageCount} image${imageCount !== 1 ? "s" : ""}:`,
						});
						log.success(
							`Sent ${attachments.length} image attachments to Discord`,
						);
					} catch (sendError) {
						log.error(
							"Failed to send image attachments to Discord:",
							sendError as Error,
						);
						// Fall back message if Discord sending fails
						const queryTerm = args.query || "images";
						return {
							success: false,
							message: `Found ${imageUrls.length} ${queryTerm} images, but failed to send them to Discord due to a technical error.`,
							data: {
								source: "mcp",
								functionName: "brave_image_search",
								serverName: this.serverName,
								rawResult: this.cleanImageSearchResult(mcpResult),
								executionTime: Date.now() - context.executionStartTime,
								imagesSent: 0,
								status: "failed",
								error: "Discord send failed",
							},
						};
					}
				}

				// Return simplified response to LLM - no URLs or image data to prevent duplicate processing
				const queryTerm = args.query || "images";
				const completionMessage = `Found and sent ${attachments.length} ${queryTerm} images directly to Discord. The images are now displayed for the user.`;

				return {
					success: true,
					message: completionMessage,
					data: {
						source: "mcp",
						functionName: "brave_image_search",
						serverName: this.serverName,
						rawResult: this.cleanImageSearchResult(mcpResult),
						executionTime: Date.now() - context.executionStartTime,
						imagesSent: attachments.length,
						status: "completed_and_sent",
						completionMessage: completionMessage,
						// Deliberately not including imageUrls or rawResult to prevent duplicate sending
					},
				};
			} else {
				const queryTerm = args.query || "images";
				return {
					success: false,
					message: `Sorry, I couldn't find any ${queryTerm} images to show you.`,
					data: {
						source: "mcp",
						functionName: "brave_image_search",
						serverName: this.serverName,
						rawResult: mcpResult,
						executionTime: Date.now() - context.executionStartTime,
						imagesSent: 0,
						status: "completed",
					},
				};
			}
		} catch (error) {
			log.error("Error processing brave_image_search result:", error as Error);
			return {
				success: false,
				message: "Failed to process image search results",
				error: error instanceof Error ? error.message : String(error),
				data: {
					source: "mcp",
					functionName: "brave_image_search",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: Date.now() - context.executionStartTime,
					status: "failed",
				},
			};
		}
	}

	/**
	 * Process Brave Web Search results by adding fetch capability reminder
	 * @param mcpResult - The raw MCP result from brave_web_search
	 * @param args - The modified arguments used for the search (contains query)
	 * @returns Promise<TypedMCPToolResult> - Enhanced result with fetch capability reminder
	 */
	private async processBraveWebSearch(
		mcpResult: MCPServerResponse,
		_args: Record<string, unknown>,
	): Promise<TypedMCPToolResult> {
		try {
			// Extract the original search result text
			let originalText = "";
			if (mcpResult.text) {
				originalText = mcpResult.text;
			} else if (mcpResult.functionResponse?.response?.text) {
				originalText = mcpResult.functionResponse.response.text;
			} else {
				// Fallback: try to stringify the result
				originalText = JSON.stringify(mcpResult, null, 2);
			}

			// Extract URLs from the search results to count them
			const urlPattern = /https?:\/\/[^\s)]+/g;
			const foundUrls = originalText.match(urlPattern) || [];
			const urlCount = foundUrls.length;

			// Create an enhanced response that includes fetch capability reminder
			const fetchReminder =
				urlCount > 0
					? `\n\n[AGENT REMINDER] You have access to the "fetch" function call to retrieve and analyze the full content of any of these ${urlCount} web URLs. If any given information snippet is not enough, use the function to retrieve more details about a specific webpage, use fetch(url="[URL]") to get the complete page content for deeper analysis.`
					: `\n\n[AGENT REMINDER] You have access to the "fetch" function call to retrieve and analyze the full content of any web URL the user needs. Use fetch(url="[URL]") when more detailed webpage content is needed.`;

			const enhancedMessage = originalText;

			// Log the enhanced message that TomoriBot will receive
			log.info(
				`Enhanced web search response for TomoriBot: ${enhancedMessage.substring(0, 200)}...`,
			);
			log.info(`Fetch capability reminder appended - Found ${urlCount} URLs`);

			return {
				success: true,
				message: enhancedMessage,
				data: {
					source: "mcp",
					functionName: "brave_web_search",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					urlsFound: urlCount,
					fetchCapabilityReminder: true,
					agentInstructions: fetchReminder.trim(),
					status: "completed",
				},
			};
		} catch (error) {
			log.error("Error processing brave_web_search result:", error as Error);
			// Fall back to original behavior
			return {
				success: true,
				message: mcpResult.text || "Web search completed successfully",
				data: {
					source: "mcp",
					functionName: "brave_web_search",
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: 0, // Will be set by caller
					status: "completed",
				},
			};
		}
	}

	/**
	 * Process standard Brave Search results (video, news, local, summarizer)
	 * @param functionName - Name of the executed function
	 * @param mcpResult - Raw result from MCP server
	 * @param context - Execution context
	 * @param args - Function arguments used
	 * @returns Promise<TypedMCPToolResult> - Standard processed result
	 */
	private processStandardBraveResult(
		functionName: string,
		mcpResult: MCPServerResponse,
		context: MCPExecutionContext,
		_args: Record<string, unknown>,
	): TypedMCPToolResult {
		try {
			// Extract result text from various possible locations in MCP response
			let resultText = "";
			if (mcpResult.text) {
				resultText = mcpResult.text;
			} else if (mcpResult.functionResponse?.response?.text) {
				resultText = mcpResult.functionResponse.response.text;
			} else {
				// Fallback: try to stringify the result
				resultText = JSON.stringify(mcpResult, null, 2);
			}

			// Check if this is an error result
			if (mcpResult.isError) {
				return {
					success: false,
					message: resultText || `${functionName} execution failed`,
					error: resultText || "Unknown MCP error",
					data: {
						source: "mcp",
						functionName,
						serverName: this.serverName,
						rawResult: mcpResult,
						executionTime: Date.now() - context.executionStartTime,
						status: "failed",
					},
				};
			}

			// Successful execution
			return {
				success: true,
				message: resultText || `${functionName} executed successfully`,
				data: {
					source: "mcp",
					functionName,
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: Date.now() - context.executionStartTime,
					status: "completed",
				},
			};
		} catch (error) {
			log.error(
				`Error processing standard Brave result for ${functionName}:`,
				error as Error,
			);
			return {
				success: false,
				message: `Failed to process ${functionName} result`,
				error: error instanceof Error ? error.message : String(error),
				data: {
					source: "mcp",
					functionName,
					serverName: this.serverName,
					rawResult: mcpResult,
					executionTime: Date.now() - context.executionStartTime,
					status: "failed",
				},
			};
		}
	}

	/**
	 * Clean image search result by removing image data and URLs
	 * This reduces token usage and prevents duplicate image processing by the LLM
	 * @param mcpResult - Raw MCP result from brave_image_search
	 * @returns Cleaned result with image data removed
	 */
	private cleanImageSearchResult(
		mcpResult: MCPServerResponse,
	): Record<string, unknown> {
		try {
			// Create a deep copy to avoid mutating the original
			const cleanedResult = JSON.parse(JSON.stringify(mcpResult));

			// Remove image data from various possible locations
			const contentArrays = [
				cleanedResult.functionResponse?.response?.content,
				cleanedResult.content,
				cleanedResult.response?.content,
				cleanedResult.data,
			].filter(Array.isArray);

			for (const contentArray of contentArrays) {
				for (let i = contentArray.length - 1; i >= 0; i--) {
					const item = contentArray[i];

					// Remove text objects containing image data (JSON with image_url)
					if (item && item.type === "text" && item.text) {
						try {
							const parsedText = JSON.parse(item.text);
							if (parsedText.image_url || parsedText.thumbnail_url) {
								// Replace with summary instead of removing entirely
								contentArray[i] = {
									type: "text",
									text: "[Image data removed - already sent to Discord]",
								};
							}
						} catch {
							// Not JSON, keep as is
						}
					}

					// Remove image objects entirely
					else if (item && item.type === "image") {
						contentArray.splice(i, 1);
					}
				}
			}

			// Add summary of what was processed
			if (cleanedResult.functionResponse?.response) {
				cleanedResult.functionResponse.response.summary =
					"Image search completed - images have been sent to Discord channel";
			} else if (cleanedResult.response) {
				cleanedResult.response.summary =
					"Image search completed - images have been sent to Discord channel";
			} else {
				cleanedResult.summary =
					"Image search completed - images have been sent to Discord channel";
			}

			return cleanedResult;
		} catch (error) {
			log.warn("Failed to clean image search result:", error as Error);
			// Return minimal result if cleaning fails
			return {
				// summary: "Image search completed - images have been sent to Discord channel",
				imageDataRemoved: true,
			};
		}
	}
}

/**
 * Export convenience function for getting the handler instance
 */
export function getBraveSearchHandler(): BraveSearchHandler {
	return new BraveSearchHandler();
}
