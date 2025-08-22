/**
 * Google Tool Adapter
 * Converts generic tools to Google's function declaration format and back
 */

import { Type, type CallableTool } from "@google/genai";
import { AttachmentBuilder } from "discord.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../utils/misc/logger";
import type {
	Tool,
	MCPCapableToolAdapter,
	ToolResult,
} from "../../types/tool/interfaces";
import { getMCPManager } from "../../utils/mcp/mcpManager";

/**
 * Google-specific function declaration format
 */
interface GoogleFunctionDeclaration extends Record<string, unknown> {
	name: string;
	description: string;
	parameters: {
		type: typeof Type.OBJECT;
		properties: Record<
			string,
			{
				type:
					| typeof Type.STRING
					| typeof Type.NUMBER
					| typeof Type.BOOLEAN
					| typeof Type.ARRAY
					| typeof Type.OBJECT;
				description: string;
				enum?: string[];
				items?: {
					type:
						| typeof Type.STRING
						| typeof Type.NUMBER
						| typeof Type.BOOLEAN
						| typeof Type.OBJECT;
				};
			}
		>;
		required: string[];
	};
}

/**
 * Google tool adapter implementation with MCP capabilities
 */
export class GoogleToolAdapter implements MCPCapableToolAdapter {
	private static instance: GoogleToolAdapter;

	/**
	 * Get singleton instance
	 */
	static getInstance(): GoogleToolAdapter {
		if (!GoogleToolAdapter.instance) {
			GoogleToolAdapter.instance = new GoogleToolAdapter();
		}
		return GoogleToolAdapter.instance;
	}

	/**
	 * Get the provider name this adapter supports
	 * @returns Provider identifier
	 */
	getProviderName(): string {
		return "google";
	}

	/**
	 * Convert a generic tool to Google's function declaration format
	 * @param tool - The generic tool to convert
	 * @returns Google-specific function declaration
	 */
	convertTool(tool: Tool): Record<string, unknown> {
		try {
			// Convert parameter schema to Google format
			const googleProperties: Record<
				string,
				{
					type:
						| typeof Type.STRING
						| typeof Type.NUMBER
						| typeof Type.BOOLEAN
						| typeof Type.ARRAY
						| typeof Type.OBJECT;
					description: string;
					enum?: string[];
					items?: {
						type:
							| typeof Type.STRING
							| typeof Type.NUMBER
							| typeof Type.BOOLEAN
							| typeof Type.OBJECT;
					};
				}
			> = {};

			for (const [paramName, paramSchema] of Object.entries(
				tool.parameters.properties,
			)) {
				googleProperties[paramName] = {
					type: this.convertParameterType(
						paramSchema.type as
							| "string"
							| "number"
							| "boolean"
							| "array"
							| "object",
					),
					description: paramSchema.description,
				};

				// Add enum if specified
				if (paramSchema.enum) {
					googleProperties[paramName].enum = paramSchema.enum;
				}

				// Add items for array type
				if (paramSchema.type === "array" && paramSchema.items) {
					const itemType = this.convertParameterType(
						paramSchema.items.type as
							| "string"
							| "number"
							| "boolean"
							| "object",
					);
					googleProperties[paramName].items = {
						type: itemType as
							| typeof Type.STRING
							| typeof Type.NUMBER
							| typeof Type.BOOLEAN
							| typeof Type.OBJECT,
					};
				}
			}

			const googleFunction: GoogleFunctionDeclaration = {
				name: tool.name,
				description: tool.description,
				parameters: {
					type: Type.OBJECT,
					properties: googleProperties,
					required: tool.parameters.required,
				},
			};

			log.info(
				`Converted tool '${tool.name}' (${tool.category}) to Google format with ${Object.keys(googleProperties).length} parameters`,
			);

			return googleFunction;
		} catch (error) {
			log.error(
				`Failed to convert tool '${tool.name}' (${tool.category}) to Google format`,
				error as Error,
			);
			throw error;
		}
	}

	/**
	 * Convert tool result back to Google-specific format
	 * This is used when the tool execution result needs to be fed back to Gemini
	 * @param result - The generic tool result
	 * @returns Google-specific result format (Part object)
	 */
	convertResult(result: ToolResult): Record<string, unknown> {
		try {
			// Google expects a Part object with text content
			if (result.success) {
				// Successful execution - provide meaningful result text
				let resultText = result.message || "Tool executed successfully";

				if (result.data && typeof result.data === "object") {
					const data = result.data as Record<string, unknown>;

					// Format the result based on the data structure
					if (data.summary && typeof data.summary === "string") {
						resultText = data.summary;
					} else if (data.message && typeof data.message === "string") {
						resultText = data.message;
					} else if (
						data.selectionReason &&
						typeof data.selectionReason === "string"
					) {
						resultText = data.selectionReason;
					} else {
						// Include relevant data in the result text
						const relevantData = this.extractRelevantData(data);
						if (relevantData) {
							resultText = `${resultText}\n\nResult: ${relevantData}`;
						}
					}
				}

				return {
					text: resultText,
				};
			}

			// Failed execution - provide error information
			const errorText =
				result.message || result.error || "Tool execution failed";

			return {
				text: `Error: ${errorText}`,
			};
		} catch (error) {
			log.error(
				`Failed to convert tool result to Google format (success: ${result.success}, hasData: ${!!result.data})`,
				error as Error,
			);

			return {
				text: "Error: Failed to process tool result",
			};
		}
	}

	/**
	 * Convert multiple tools to Google's tools array format
	 * @param tools - Array of generic tools
	 * @returns Google tools configuration
	 */
	convertToolsArray(tools: Tool[]): Array<Record<string, unknown>> {
		if (tools.length === 0) {
			return [];
		}

		try {
			// Convert each tool to Google function declaration
			const functionDeclarations = tools.map((tool) => this.convertTool(tool));

			// Google expects tools in this specific format
			return [
				{
					functionDeclarations: functionDeclarations,
				},
			];
		} catch (error) {
			log.error(
				`Failed to convert tools array to Google format (${tools.length} tools: ${tools.map((t) => t.name).join(", ")})`,
				error as Error,
			);
			return [];
		}
	}

	/**
	 * Get all available tools (built-in + MCP) in provider-specific format
	 * Implementation of MCPCapableToolAdapter interface
	 * @param builtInTools - Array of built-in tools
	 * @returns Combined provider-specific tools configuration
	 */
	async getAllToolsInProviderFormat(
		builtInTools: Tool[],
	): Promise<Array<Record<string, unknown>>> {
		return this.getAllToolsInGoogleFormat(builtInTools);
	}

	/**
	 * Get all available tools (built-in + MCP) in Google tools format
	 * This provides a unified interface for the provider to get all tools
	 * @param builtInTools - Array of built-in tools
	 * @returns Combined Google tools configuration with both built-in and MCP tools
	 */
	async getAllToolsInGoogleFormat(
		builtInTools: Tool[],
	): Promise<Array<Record<string, unknown>>> {
		try {
			// Start with built-in tools
			const allFunctionDeclarations: Record<string, unknown>[] = [];

			// Convert built-in tools
			if (builtInTools.length > 0) {
				const builtInDeclarations = builtInTools.map((tool) =>
					this.convertTool(tool),
				);
				allFunctionDeclarations.push(...builtInDeclarations);
				log.info(
					`Converted ${builtInTools.length} built-in tools to Google format`,
				);
			}

			// Add MCP tools if available
			const mcpManager = getMCPManager();
			if (mcpManager.isReady()) {
				const mcpTools = mcpManager.getMCPTools();

				for (const mcpTool of mcpTools) {
					try {
						const geminiTool = await mcpTool.tool();
						if (geminiTool.functionDeclarations) {
							allFunctionDeclarations.push(...geminiTool.functionDeclarations);
						}
					} catch (error) {
						log.warn(
							"Failed to extract functions from MCP tool:",
							error as Error,
						);
					}
				}

				if (mcpTools.length > 0) {
					log.info(`Added ${mcpTools.length} MCP tools to Google format`);
				}
			}

			// Return in Google's expected format
			if (allFunctionDeclarations.length === 0) {
				return [];
			}

			return [
				{
					functionDeclarations: allFunctionDeclarations,
				},
			];
		} catch (error) {
			log.error("Failed to get all tools in Google format:", error as Error);
			// Return just built-in tools as fallback
			return this.convertToolsArray(builtInTools);
		}
	}

	/**
	 * Check if a function name belongs to an MCP tool
	 * @param functionName - Name of the function to check
	 * @returns Promise<boolean> - True if this is an MCP tool function
	 */
	async isMCPFunction(functionName: string): Promise<boolean> {
		try {
			const mcpManager = getMCPManager();
			if (!mcpManager.isReady()) {
				return false;
			}

			const mcpTools = mcpManager.getMCPTools();
			for (const mcpTool of mcpTools) {
				try {
					const geminiTool = await mcpTool.tool();
					const mcpFunctionNames =
						geminiTool.functionDeclarations?.map((f: any) => f.name) || [];
					if (mcpFunctionNames.includes(functionName)) {
						return true;
					}
				} catch (error) {
					log.warn("Error checking MCP tool functions:", error as Error);
				}
			}

			return false;
		} catch (error) {
			log.error("Error checking if function is MCP:", error as Error);
			return false;
		}
	}

	/**
	 * Execute an MCP tool function
	 * @param functionName - Name of the MCP function to execute
	 * @param args - Arguments for the function
	 * @param context - Tool execution context for Discord operations
	 * @returns Promise<ToolResult> - Standardized tool result
	 */
	async executeMCPFunction(
		functionName: string,
		args: Record<string, unknown>,
		context?: any,
	): Promise<ToolResult> {
		try {
			const mcpManager = getMCPManager();
			if (!mcpManager.isReady()) {
				return {
					success: false,
					message: "MCP manager not ready",
					error: "MCP servers not initialized",
				};
			}

			// Apply parameter overrides based on function name
			const modifiedArgs = this.applyParameterOverrides(functionName, args);

			// Find the MCP tool that provides this function
			const mcpTools = mcpManager.getMCPTools();
			for (const mcpTool of mcpTools) {
				try {
					const geminiTool = await mcpTool.tool();
					const mcpFunctionNames =
						geminiTool.functionDeclarations?.map((f: any) => f.name) || [];

					if (mcpFunctionNames.includes(functionName)) {
						// Execute the MCP function with modified args
						log.info(
							`Executing MCP function: ${functionName} with enforced parameters`,
						);
						const mcpResult = await mcpTool.callTool([
							{ name: functionName, args: modifiedArgs },
						]);

						// Convert MCP result to our standard ToolResult format
						if (mcpResult && mcpResult.length > 0) {
							const firstResult = mcpResult[0];

							// Special handling for brave_image_search
							if (functionName === "brave_image_search" && context?.channel) {
								return await this.processBraveImageSearch(
									firstResult,
									context,
									modifiedArgs,
								);
							}

							// Special handling for brave_web_search
							if (functionName === "brave_web_search") {
								return await this.processBraveWebSearch(
									firstResult,
									modifiedArgs,
								);
							}

							// Handle different MCP result formats
							if (firstResult.text) {
								return {
									success: true,
									message: firstResult.text,
									data: {
										source: "mcp",
										functionName,
										rawResult: firstResult,
									},
								};
							} else if (firstResult.isError) {
								return {
									success: false,
									message: firstResult.text || "MCP function execution failed",
									error: firstResult.text || "Unknown MCP error",
								};
							} else {
								// Fallback for unknown result formats
								return {
									success: true,
									message: "MCP function executed successfully",
									data: {
										source: "mcp",
										functionName,
										rawResult: firstResult,
									},
								};
							}
						} else {
							return {
								success: false,
								message: "MCP function returned no results",
								error: "Empty MCP response",
							};
						}
					}
				} catch (error) {
					log.warn(
						`Error executing MCP function '${functionName}':`,
						error as Error,
					);
				}
			}

			return {
				success: false,
				message: `MCP function '${functionName}' not found`,
				error: "Function not available in any connected MCP server",
			};
		} catch (error) {
			log.error(
				`Failed to execute MCP function '${functionName}':`,
				error as Error,
			);
			return {
				success: false,
				message: "MCP function execution failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Process Brave Image Search results by extracting image URLs and sending as Discord attachments
	 * @param mcpResult - The raw MCP result from brave_image_search
	 * @param context - Tool execution context containing Discord channel
	 * @param args - The modified arguments used for the search (contains query)
	 * @returns Promise<ToolResult> - Simplified result for the LLM
	 */
	private async processBraveImageSearch(
		mcpResult: any,
		context: any,
		args: Record<string, unknown>,
	): Promise<ToolResult> {
		try {
			let imageUrls: string[] = [];
			let imageCount = 0;

			// Extract image URLs from text objects in the MCP result
			// Try multiple possible structures since MCP result format may vary

			const contentArrays = [
				mcpResult.functionResponse?.response?.content, // Brave Search actual structure
				mcpResult.content, // Original expected structure
				mcpResult.response?.content, // Alternative structure
				mcpResult.data, // Direct data array
				mcpResult, // Direct array at top level
			].filter((arr) => Array.isArray(arr));

			log.info(
				`Found ${contentArrays.length} potential content arrays to process`,
			);

			for (const contentArray of contentArrays) {
				for (const item of contentArray) {
					// Handle text objects with JSON data
					if (item && item.type === "text" && item.text) {
						try {
							// Parse the JSON text to extract image_url
							const imageData = JSON.parse(item.text);
							if (
								imageData.image_url &&
								typeof imageData.image_url === "string"
							) {
								imageUrls.push(imageData.image_url);
								imageCount++;
								log.info(
									`Extracted image URL from text: ${imageData.image_url}`,
								);
							}
						} catch (parseError) {
							// Skip malformed JSON objects
							log.warn(
								"Failed to parse image data from text object:",
								parseError as Error,
							);
						}
					}
					// Handle image objects that might have URLs in metadata
					else if (item && item.type === "image") {
						// Look for URL in common metadata locations
						const possibleUrls = [
							item.url,
							item.image_url,
							item.source_url,
							item.original_url,
							item.src,
						].filter((url) => url && typeof url === "string");

						for (const url of possibleUrls) {
							imageUrls.push(url);
							imageCount++;
							log.info(`Extracted image URL from image object: ${url}`);
						}

						// If no URL found in metadata, we might need to reconstruct from the base64
						// For now, just log this case
						if (possibleUrls.length === 0) {
							log.warn(
								"Found image object with no accessible URL - contains only base64 data",
							);
						}
					}
				}
			}

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
				if (attachments.length > 0) {
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
							message: `Found ${imageCount} ${queryTerm} images, but failed to send them to Discord due to a technical error.`,
							data: {
								source: "mcp",
								functionName: "brave_image_search",
								imageCount,
								error: "Discord send failed",
							},
						};
					}
				}

				// Return simplified response to LLM - no URLs to prevent duplicate sending
				const queryTerm = args.query || "images";
				const completionMessage = `Found and sent ${attachments.length} ${queryTerm} images directly to Discord. The images are now displayed for the user.`;

				return {
					success: true,
					message: completionMessage,
					data: {
						source: "mcp",
						functionName: "brave_image_search",
						imagesSent: attachments.length,
						status: "completed_and_sent",
						completionMessage: completionMessage, // Add the completion message here
						// Deliberately not including imageUrls to prevent duplicate sending
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
						imagesSent: 0,
					},
				};
			}
		} catch (error) {
			log.error("Error processing brave_image_search result:", error as Error);
			return {
				success: false,
				message: "Failed to process image search results",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Process Brave Web Search results by adding fetch capability reminder
	 * @param mcpResult - The raw MCP result from brave_web_search
	 * @param args - The modified arguments used for the search (contains query)
	 * @returns Promise<ToolResult> - Enhanced result with fetch capability reminder
	 */
	private async processBraveWebSearch(
		mcpResult: any,
		args: Record<string, unknown>,
	): Promise<ToolResult> {
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
			const urlPattern = /https?:\/\/[^\s\)]+/g;
			const foundUrls = originalText.match(urlPattern) || [];
			const urlCount = foundUrls.length;

			// Create an enhanced response that includes fetch capability reminder
			const queryTerm = args.query || "search";
			const fetchReminder =
				urlCount > 0
					? `\n\n[AGENT REMINDER] You have access to the "fetch" function call to retrieve and analyze the full content of any of these ${urlCount} web URLs. If any given information snippet is not enough, use the function to retrieve more details about a specific webpage, use fetch(url="[URL]") to get the complete page content for deeper analysis.`
					: `\n\n[AGENT REMINDER] You have access to the "fetch" function call to retrieve and analyze the full content of any web URL the user needs. Use fetch(url="[URL]") when more detailed webpage content is needed.`;

			const enhancedMessage = originalText + fetchReminder;

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
					originalResult: mcpResult,
					urlsFound: urlCount,
					fetchCapabilityReminder: true,
					agentInstructions: fetchReminder.trim(), // Add the actual reminder text here
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
					rawResult: mcpResult,
				},
			};
		}
	}

	/**
	 * Apply parameter overrides for specific MCP functions
	 * This allows us to enforce certain parameter values regardless of what the AI requests
	 * @param functionName - Name of the MCP function
	 * @param originalArgs - Original arguments from the AI
	 * @returns Modified arguments with enforced parameters
	 */
	private applyParameterOverrides(
		functionName: string,
		originalArgs: Record<string, unknown>,
	): Record<string, unknown> {
		// Clone the original args to avoid mutation
		const modifiedArgs = { ...originalArgs };

		// Define parameter overrides for specific functions
		const parameterOverrides: Record<string, Record<string, unknown>> = {
			// Brave Search overrides
			brave_web_search: {
				count: 20, // Limit to articles
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
				safesearch: "off", // Disable safe search for videos
			},
			// Add more function overrides here as needed
		};

		// Apply overrides if function has them configured
		const overrides = parameterOverrides[functionName];
		if (overrides) {
			let overridesApplied: string[] = [];

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
					`Applied parameter overrides for ${functionName}: ${overridesApplied.join(", ")}`,
				);
			}
		}

		return modifiedArgs;
	}

	// Private helper methods

	/**
	 * Convert generic parameter type to Google Type enum
	 * @param genericType - Generic parameter type
	 * @returns Google Type enum value
	 */
	private convertParameterType(
		genericType: "string" | "number" | "boolean" | "array" | "object",
	):
		| typeof Type.STRING
		| typeof Type.NUMBER
		| typeof Type.BOOLEAN
		| typeof Type.ARRAY
		| typeof Type.OBJECT {
		switch (genericType) {
			case "string":
				return Type.STRING;
			case "number":
				return Type.NUMBER;
			case "boolean":
				return Type.BOOLEAN;
			case "array":
				return Type.ARRAY;
			case "object":
				return Type.OBJECT;
			default:
				// Default to string for unknown types
				log.warn(
					`Unknown parameter type: ${genericType}, defaulting to STRING`,
				);
				return Type.STRING;
		}
	}

	/**
	 * Extract relevant data from tool result for Google response
	 * @param data - Tool result data object
	 * @returns Formatted string with relevant information
	 */
	private extractRelevantData(data: Record<string, unknown>): string | null {
		try {
			const relevantFields = [
				"summary",
				"preview",
				"selectionReason",
				"query",
				"resultLength",
			];
			const extractedData: Record<string, unknown> = {};

			for (const field of relevantFields) {
				if (data[field] !== undefined && data[field] !== null) {
					extractedData[field] = data[field];
				}
			}

			if (Object.keys(extractedData).length === 0) {
				return null;
			}

			// Format as readable text
			const entries = Object.entries(extractedData)
				.map(([key, value]) => `${key}: ${String(value)}`)
				.join(", ");

			return entries.length > 200 ? `${entries.substring(0, 200)}...` : entries;
		} catch (error) {
			log.warn(
				"Failed to extract relevant data from tool result",
				error as Error,
			);
			return null;
		}
	}

	/**
	 * Validate that a tool can be converted to Google format
	 * @param tool - Tool to validate
	 * @returns True if tool is compatible with Google format
	 */
	validateToolCompatibility(tool: Tool): boolean {
		try {
			// Check required properties
			if (!tool.name || !tool.description || !tool.parameters) {
				return false;
			}

			// Check parameter schema structure
			if (
				!tool.parameters.properties ||
				!Array.isArray(tool.parameters.required)
			) {
				return false;
			}

			// Check parameter types are supported
			for (const paramSchema of Object.values(tool.parameters.properties)) {
				const supportedTypes = [
					"string",
					"number",
					"boolean",
					"array",
					"object",
				];
				if (!supportedTypes.includes(paramSchema.type)) {
					return false;
				}
			}

			return true;
		} catch (error) {
			log.warn(
				`Tool compatibility validation failed for '${tool.name}'`,
				error as Error,
			);
			return false;
		}
	}
}

// Export convenience function for getting the adapter instance
export function getGoogleToolAdapter(): GoogleToolAdapter {
	return GoogleToolAdapter.getInstance();
}
