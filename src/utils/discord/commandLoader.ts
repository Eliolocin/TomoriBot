/**
 * Command loader utility for Tomori Bot
 * Loads command modules from the commands directory structure
 */
import path from "node:path";
import { log } from "../misc/logger";
import type {
	ApplicationCommandData,
	Client,
	ChatInputCommandInteraction,
} from "discord.js";
import type { UserRow } from "../../types/db/schema";
import getAllFiles from "../misc/ioHelper";

/**
 * Command interface representing a Discord slash command
 */
export interface Command {
	data: ApplicationCommandData;
	category: string; // Add category field to store command category
	execute: (
		client: Client,
		interaction: ChatInputCommandInteraction,
		userData: UserRow,
	) => Promise<void>;
}

/**
 * Loads all command modules from the commands directory
 * @returns Map of command names to command objects
 */
export async function loadCommandModules(): Promise<Map<string, Command>> {
	const commandMap = new Map<string, Command>();
	let commandCount = 0;

	try {
		// 1. Get all command category directories
		const commandsPath = path.join(process.cwd(), "src", "commands");
		const categoryDirs = getAllFiles(commandsPath, true);

		// 2. Process each category directory
		for (const categoryDir of categoryDirs) {
			const categoryName = path.basename(categoryDir); // Get category name from directory
			log.info(`Loading commands from category: ${categoryName}`);

			// 3. Get all command files in this category
			const commandFiles = getAllFiles(categoryDir);

			// 4. Import each command module
			for (const commandFile of commandFiles) {
				try {
					// Dynamic import of the command module
					const commandModule = await import(commandFile);

					// Each command must export data and execute
					if (!commandModule.data || !commandModule.execute) {
						log.warn(
							`Command at ${commandFile} is missing required exports (data or execute)`,
						);
						continue;
					}

					// Extract command name from the data
					const commandName = commandModule.data.name;

					if (!commandName) {
						log.warn(
							`Command at ${commandFile} has invalid data format (missing name)`,
						);
						continue;
					}

					// Add to command map with category information
					commandMap.set(commandName, {
						data: commandModule.data,
						category: categoryName, // Store the category based on directory name
						execute: commandModule.execute,
					});

					commandCount++;
					log.info(
						`Loaded command: ${commandName} (Category: ${categoryName})`,
					);
				} catch (error) {
					log.error(`Failed to load command from ${commandFile}:`, error);
				}
			}
		}

		log.success(`Successfully loaded ${commandCount} commands`);
		return commandMap;
	} catch (error) {
		log.error("Error loading commands:", error);
		return commandMap;
	}
}
