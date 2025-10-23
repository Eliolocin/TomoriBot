/**
 * Review Capabilities Tool
 * Allows TomoriBot to self-reference her own capabilities and available slash commands
 * This prevents hallucinations about what she can or cannot do
 */

import path from "node:path";
import { readFileSync } from "node:fs";
import { log } from "../../utils/misc/logger";
import {
	BaseTool,
	type ToolContext,
	type ToolResult,
	type ToolParameterSchema,
} from "../../types/tool/interfaces";
import getAllFiles from "../../utils/misc/ioHelper";
import { localizer } from "../../utils/text/localizer";
import type { SlashCommandSubcommandBuilder } from "discord.js";

/**
 * Tool for reviewing TomoriBot's capabilities and available commands
 */
export class ReviewCapabilitiesTool extends BaseTool {
	name = "review_capabilities";
	description =
		"Use this function when you need to check what you can or cannot do, or when a user asks about your capabilities or available commands. This helps you provide accurate information about your features and prevents claiming you cannot do things you actually can do (like seeing images or videos). You can check either your chat capabilities (vision, search, memory, etc.) or available slash commands.";
	category = "utility" as const;

	parameters: ToolParameterSchema = {
		type: "object",
		properties: {
			capability_type: {
				type: "string",
				description:
					"The type of capabilities to review. Use 'chat' to check your conversational abilities (vision, search, memory, expressions, etc.). Use 'commands' to see all available Discord slash commands and their descriptions.",
				enum: ["chat", "commands"],
			},
		},
		required: ["capability_type"],
	};

	/**
	 * Check if review capabilities tool is available for the given provider
	 * @param _provider - LLM provider name (unused - works with all providers)
	 * @returns True - this tool works with all providers
	 */
	isAvailableFor(_provider: string): boolean {
		// This tool is available for all providers since it just reads documentation
		return true;
	}

	/**
	 * Execute capability review
	 * @param args - Arguments containing capability_type
	 * @param context - Tool execution context
	 * @returns Promise resolving to tool result with capability information
	 */
	async execute(
		args: Record<string, unknown>,
		_context: ToolContext,
	): Promise<ToolResult> {
		// 1. Validate parameters
		const validation = this.validateParameters(args);
		if (!validation.isValid) {
			return {
				success: false,
				error: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
				data: {
					status: "invalid_parameters",
					reason: `Invalid parameters: ${validation.errors?.join(", ") || `Missing required parameters: ${validation.missingParams?.join(", ")}`}`,
				},
			};
		}

		const capabilityType = args.capability_type as "chat" | "commands";

		try {
			if (capabilityType === "chat") {
				// 2. Read and return chat capabilities from markdown file
				return await this.getChatCapabilities();
			} else if (capabilityType === "commands") {
				// 3. Dynamically scan and return slash command information
				return await this.getSlashCommands();
			}

			// This should never be reached due to enum validation
			return {
				success: false,
				error: "Invalid capability type",
				data: {
					status: "invalid_capability_type",
					reason: "Capability type must be 'chat' or 'commands'",
				},
			};
		} catch (error) {
			log.error(
				`Error reviewing capabilities (type: ${capabilityType})`,
				error as Error,
			);
			return {
				success: false,
				error:
					error instanceof Error ? error.message : "Unknown error occurred",
				data: {
					status: "execution_error",
					capability_type: capabilityType,
					reason:
						error instanceof Error
							? error.message
							: "Unknown error during capability review",
				},
			};
		}
	}

	/**
	 * Read chat capabilities from the markdown documentation file
	 * @returns Promise resolving to tool result with chat capabilities
	 */
	private async getChatCapabilities(): Promise<ToolResult> {
		try {
			// 1. Construct path to chat capabilities markdown file
			const capabilitiesPath = path.join(
				process.cwd(),
				"src",
				"tools",
				"resources",
				"chatCapabilities.md",
			);

			// 2. Read the markdown file synchronously
			const capabilitiesContent = readFileSync(capabilitiesPath, "utf-8");

			log.info("Successfully retrieved chat capabilities documentation");

			// 3. Return the full markdown content
			// Note: Put content in both message and data.content for maximum compatibility
			// GoogleToolAdapter looks for data.summary/data.message when converting results
			return {
				success: true,
				message: capabilitiesContent,
				data: {
					status: "capabilities_retrieved",
					capability_type: "chat",
					content_length: capabilitiesContent.length,
					summary: capabilitiesContent, // <-- This is what GoogleToolAdapter will use!
				},
			};
		} catch (error) {
			log.error("Failed to read chat capabilities file", error as Error);

			return {
				success: false,
				error: "Failed to read chat capabilities documentation",
				message:
					"Could not access the chat capabilities documentation file. This may indicate a configuration issue.",
				data: {
					status: "file_read_error",
					capability_type: "chat",
					reason:
						error instanceof Error ? error.message : "Unknown file read error",
				},
			};
		}
	}

	/**
	 * Dynamically scan the commands directory and generate slash command documentation
	 * @returns Promise resolving to tool result with slash commands
	 */
	private async getSlashCommands(): Promise<ToolResult> {
		try {
			// 1. Build path to commands directory
			const commandsPath = path.join(process.cwd(), "src", "commands");

			// 2. Get all category directories
			const categoryDirs = getAllFiles(commandsPath, true);

			// 3. Build markdown documentation
			let commandsMarkdown = "# TomoriBot Slash Commands\n\n";
			commandsMarkdown +=
				"Here are all available slash commands organized by category. All commands use the format `/{category} {subcommand}`.\n\n";

			let totalCommands = 0;

			// 4. Process each category directory
			for (const categoryDir of categoryDirs) {
				const categoryName = path.basename(categoryDir);

				// 5. Get category description from localizations
				const categoryDescription =
					localizer("en-US", `commands.${categoryName}.description`) ||
					`${categoryName} commands`;

				commandsMarkdown += `## /${categoryName}\n`;
				commandsMarkdown += `${categoryDescription}\n\n`;

				// 6. Get all command files in this category
				const commandFiles = getAllFiles(categoryDir).filter((file) =>
					file.endsWith(".ts"),
				);

				// 7. Process each command file
				for (const commandFile of commandFiles) {
					try {
						// 8. Import the command module
						const commandModule = await import(commandFile);

						// 9. Validate exports
						if (!commandModule.configureSubcommand) {
							continue;
						}

						// 10. Create a mock subcommand builder to extract command details
						const mockBuilder: {
							name: string;
							description: string;
							setName: (name: string) => typeof mockBuilder;
							setDescription: (desc: string) => typeof mockBuilder;
							addStringOption: () => typeof mockBuilder;
							addIntegerOption: () => typeof mockBuilder;
							addBooleanOption: () => typeof mockBuilder;
							addUserOption: () => typeof mockBuilder;
							addChannelOption: () => typeof mockBuilder;
							addRoleOption: () => typeof mockBuilder;
							addMentionableOption: () => typeof mockBuilder;
							addNumberOption: () => typeof mockBuilder;
							addAttachmentOption: () => typeof mockBuilder;
						} = {
							name: "",
							description: "",
							setName: function (name: string) {
								this.name = name;
								return this;
							},
							setDescription: function (desc: string) {
								this.description = desc;
								return this;
							},
							addStringOption: function () {
								return this;
							},
							addIntegerOption: function () {
								return this;
							},
							addBooleanOption: function () {
								return this;
							},
							addUserOption: function () {
								return this;
							},
							addChannelOption: function () {
								return this;
							},
							addRoleOption: function () {
								return this;
							},
							addMentionableOption: function () {
								return this;
							},
							addNumberOption: function () {
								return this;
							},
							addAttachmentOption: function () {
								return this;
							},
						};

						// 11. Call configureSubcommand to populate the mock builder
						commandModule.configureSubcommand(
							mockBuilder as unknown as SlashCommandSubcommandBuilder,
						);

						// 12. Extract command information
						const subcommandName = mockBuilder.name;
						const subcommandDescription = mockBuilder.description;

						if (subcommandName && subcommandDescription) {
							commandsMarkdown += `- **/${categoryName} ${subcommandName}** - ${subcommandDescription}\n`;
							totalCommands++;
						}
					} catch (_error) {
						// Skip files that fail to import (might be helpers or non-command files)
						log.warn(
							`Skipped command file during capability scan: ${commandFile}`,
						);
					}
				}

				commandsMarkdown += "\n";
			}

			// 13. Add footer with command count
			commandsMarkdown += `---\n\n**Total Commands**: ${totalCommands} slash commands across ${categoryDirs.length} categories\n`;

			log.success(
				`Successfully generated slash command documentation: ${totalCommands} commands`,
			);

			// 14. Return the generated markdown
			// Note: Put content in both message and data.summary for maximum compatibility
			// GoogleToolAdapter looks for data.summary/data.message when converting results
			return {
				success: true,
				message: commandsMarkdown,
				data: {
					status: "commands_retrieved",
					capability_type: "commands",
					total_commands: totalCommands,
					total_categories: categoryDirs.length,
					summary: commandsMarkdown, // <-- This is what GoogleToolAdapter will use!
				},
			};
		} catch (error) {
			log.error(
				"Failed to generate slash commands documentation",
				error as Error,
			);

			return {
				success: false,
				error: "Failed to scan and generate slash commands documentation",
				message:
					"Could not scan the commands directory to generate slash command information. This may indicate a file system or permissions issue.",
				data: {
					status: "command_scan_error",
					capability_type: "commands",
					reason:
						error instanceof Error
							? error.message
							: "Unknown command scanning error",
				},
			};
		}
	}
}
