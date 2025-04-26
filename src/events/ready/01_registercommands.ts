import { REST, Routes } from "discord.js";
import { log } from "../../utils/misc/logger";
import { loadCommandModules } from "../../utils/discord/commandLoader";

/**
 * Event handler for registering commands when the bot is ready
 */
export default async (): Promise<void> => {
	try {
		log.section("Registering application commands");

		const { DISCORD_TOKEN, TOMORI_ID, TESTSRV_ID } = process.env;
		if (!DISCORD_TOKEN || !TOMORI_ID) {
			log.error(
				"Missing required environment variables for command registration",
			);
			return;
		}

		// Load all command modules
		const commandModules = await loadCommandModules();

		if (commandModules.size === 0) {
			log.warn("No commands found to register");
			return;
		}

		// Extract command data for registration
		const commandData = Array.from(commandModules.values()).map(
			(cmd) => cmd.data,
		);
		log.info(`Preparing to register ${commandData.length} commands`);

		// Initialize REST API for command registration
		const rest = new REST().setToken(DISCORD_TOKEN);

		// Determine if we're in development (register to dev guild only) or production (register globally)
		const isDev = process.env.RUN_ENV === "development";

		if (isDev && TESTSRV_ID) {
			// Register to development guild for faster testing
			log.info(`Registering commands to development guild: ${TESTSRV_ID}`);

			try {
				await rest.put(Routes.applicationGuildCommands(TOMORI_ID, TESTSRV_ID), {
					body: commandData,
				});
				log.success(
					`Successfully registered ${commandData.length} commands to development guild`,
				);
			} catch (error) {
				log.error("Failed to register commands to development guild:", error);
			}
		} else {
			// Register globally (takes up to an hour to update)
			log.info("Registering commands globally");

			try {
				await rest.put(Routes.applicationCommands(TOMORI_ID), {
					body: commandData,
				});
				log.success(
					`Successfully registered ${commandData.length} commands globally`,
				);
			} catch (error) {
				log.error("Failed to register commands globally:", error);
			}
		}
	} catch (error) {
		log.error("Error during command registration:", error);
	}
};
