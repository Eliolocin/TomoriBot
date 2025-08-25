/**
 * Command loader utility for Tomori Bot
 * Loads command modules from the commands directory structure
 */
import path from "node:path";
import { log } from "../misc/logger";
import {
	SlashCommandBuilder,
	type ApplicationCommandData,
	type Client,
	type ChatInputCommandInteraction,
	PermissionsBitField,
	InteractionContextType,
} from "discord.js";
import type { SlashCommandSubcommandBuilder } from "discord.js";
import type { UserRow, ErrorContext } from "../../types/db/schema";
import getAllFiles from "../misc/ioHelper";
import { localizer } from "../text/localizer";

/**
 * Type for the command execution function
 */
export type CommandExecuteFunction = (
	client: Client,
	interaction: ChatInputCommandInteraction,
	userData: UserRow,
	locale: string,
) => Promise<void>;

/**
 * Map structure for the command execution functions
 * First level: category name (e.g., 'config')
 * Second level: subcommand name (e.g., 'setup')
 */
export type CommandExecutionMap = Map<
	string,
	Map<string, CommandExecuteFunction>
>;

/**
 * Map for command cooldowns (category -> duration)
 */
export type CommandCooldownMap = Map<string, number>;
const GUILD_ONLY_CATEGORIES = ["config", "teach"];
const MANAGER_ONLY_CATEGORIES = ["config"];

/**
 * Loads all command modules, builds registration data and command maps
 * @returns Object containing command data for registration and execution maps
 */
export async function loadCommandData(): Promise<{
	registrationData: ApplicationCommandData[];
	executionMap: CommandExecutionMap;
	cooldownMap: CommandCooldownMap;
}> {
	// Initialize our maps
	const executionMap: CommandExecutionMap = new Map();
	const cooldownMap: CommandCooldownMap = new Map();
	// This will store our category builders (one per directory)
	const builders = new Map<string, SlashCommandBuilder>();
	let commandCount = 0;

	try {
		// 1. Get all command category directories
		const commandsPath = path.join(process.cwd(), "src", "commands");
		const categoryDirs = getAllFiles(commandsPath, true);

		// 2. Process each category directory
		for (const categoryDir of categoryDirs) {
			const categoryName = path.basename(categoryDir);
			log.info(`Processing category: ${categoryName}`);

			// 3. Create or get the SlashCommandBuilder for this category
			let categoryBuilder = builders.get(categoryName);
			if (!categoryBuilder) {
				// Initialize a new builder for this category
				// Get category description from localizations (try to find 'commands.<category>.description')
				const categoryDescription =
					localizer("en-US", `commands.${categoryName}.description`) ||
					`${categoryName} commands`; // Fallback if no localization exists

				const categoryLocalizationsMap: { [key: string]: string } = {};
				// Add Japanese localization if available
				const jaDesc = localizer("ja", `commands.${categoryName}.description`);
				if (jaDesc && jaDesc !== `commands.${categoryName}.description`) {
					categoryLocalizationsMap.ja = jaDesc;
				}

				categoryBuilder = new SlashCommandBuilder()
					.setName(categoryName)
					.setDescription(categoryDescription);

				// Apply specific settings for the 'config' command group (Rule 21)
				// Category constants defined at the top for easy maintenance

				if (GUILD_ONLY_CATEGORIES.includes(categoryName)) {
					categoryBuilder.setContexts(InteractionContextType.Guild); // Disallow use in DMs
					log.info(`Applied Guild Only Restriction to /${categoryName}`);
				}
				if (MANAGER_ONLY_CATEGORIES.includes(categoryName)) {
					categoryBuilder.setDefaultMemberPermissions(
						PermissionsBitField.Flags.ManageGuild,
					); // Require Manage Guild permission
					log.info(
						`Applied ManageGuild permission requirement to /${categoryName}`,
					);
				}

				// Add localizations if we have any
				if (Object.keys(categoryLocalizationsMap).length > 0) {
					categoryBuilder.setDescriptionLocalizations(categoryLocalizationsMap);
				}

				builders.set(categoryName, categoryBuilder);
				executionMap.set(categoryName, new Map()); // Initialize subcommand map
			}

			// 4. Get all command files in this category
			const commandFiles = getAllFiles(categoryDir);

			// 5. Process each command file
			for (const commandFile of commandFiles) {
				try {
					// Import the command module
					const commandModule = await import(commandFile);

					// Validate exports: must have configureSubcommand and execute
					if (!commandModule.configureSubcommand || !commandModule.execute) {
						log.warn(
							`Command at ${commandFile} is missing required exports (configureSubcommand or execute)`,
						);
						continue;
					}

					// Use a temporary variable to store the subcommand name
					let subcommandName = "";

					// 6. Add the subcommand to the category builder
					categoryBuilder.addSubcommand(
						(subcommand: SlashCommandSubcommandBuilder) => {
							// Call the module's configureSubcommand function and capture its result
							const configuredSubcommand =
								commandModule.configureSubcommand(subcommand);
							// Get the name that was set
							subcommandName = configuredSubcommand.name;
							
							// 7. Automatically apply description localizations
							if (subcommandName) {
								const localizationKey = `commands.${categoryName}.${subcommandName}.description`;
								
								// Build localizations map for available locales
								const subcommandLocalizationsMap: { [key: string]: string } = {};
								
								// Add Japanese localization if available
								const jaDesc = localizer("ja", localizationKey);
								if (jaDesc && jaDesc !== localizationKey) {
									subcommandLocalizationsMap.ja = jaDesc;
								}
								
								// Apply localizations if we have any
								if (Object.keys(subcommandLocalizationsMap).length > 0) {
									configuredSubcommand.setDescriptionLocalizations(subcommandLocalizationsMap);
								}
							}
							
							return configuredSubcommand;
						},
					);

					if (!subcommandName) {
						log.warn(`Subcommand in ${commandFile} did not set a name`);
						continue;
					}

					// 8. Store the execute function in the map
					executionMap
						.get(categoryName)
						?.set(subcommandName, commandModule.execute);

					// 9. Store cooldown if defined (optional feature)
					if (
						commandModule.cooldown &&
						typeof commandModule.cooldown === "number"
					) {
						cooldownMap.set(categoryName, commandModule.cooldown);
					}

					commandCount++;
					log.info(`Loaded subcommand: ${categoryName} ${subcommandName}`);
				} catch (error) {
					const context: ErrorContext = {
						errorType: "CommandLoadingError",
						metadata: {
							commandFile,
							categoryName,
						},
					};
					await log.error(
						`Failed to load command from ${commandFile}:`,
						error,
						context,
					);
				}
			}
		}

		// Convert builders to the registration data array
		const registrationData = Array.from(builders.values()).map(
			(builder) => builder.toJSON() as ApplicationCommandData, // Add 'as ApplicationCommandData'
		);

		log.success(
			`Successfully loaded ${commandCount} subcommands in ${builders.size} categories`,
		);
		return { registrationData, executionMap, cooldownMap };
	} catch (error) {
		const context: ErrorContext = {
			errorType: "CommandLoaderError",
			metadata: { stage: "initializing" },
		};
		await log.error("Error loading command data:", error, context);
		// Return empty data in case of errors to prevent crashes
		return {
			registrationData: [],
			executionMap: new Map(),
			cooldownMap: new Map(),
		};
	}
}
