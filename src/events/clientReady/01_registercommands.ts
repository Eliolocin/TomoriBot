import { REST, Routes } from "discord.js";
import { log } from "../../utils/misc/logger";
import { loadCommandData } from "../../utils/discord/commandLoader";
import type { ErrorContext } from "../../types/db/schema";

/**
 * Event handler for registering commands when the bot is ready
 */
export default async (): Promise<void> => {
	try {
		log.section("Registering application commands");

		const { DISCORD_TOKEN, TOMORI_ID, TESTSRV_ID } = process.env;
		if (!DISCORD_TOKEN || !TOMORI_ID) {
			const context: ErrorContext = {
				errorType: "CommandRegistrationError",
				metadata: { stage: "environment" },
			};
			await log.error(
				"Missing required environment variables for command registration",
				new Error("DISCORD_TOKEN or TOMORI_ID not found"),
				context,
			);
			return;
		}

		// Load command data using our new function
		const { registrationData } = await loadCommandData();

		if (registrationData.length === 0) {
			log.warn("No commands found to register");
			return;
		}

		log.info(
			`Preparing to register ${registrationData.length} top-level commands`,
		);

		// Initialize REST API for command registration
		const rest = new REST().setToken(DISCORD_TOKEN);

		// Determine if we're in development (register to dev guild only) or production (register globally)
		const isDev = process.env.RUN_ENV === "development";

		if (isDev && TESTSRV_ID) {
			// Register to development guild for faster testing
			log.info(`Registering commands to development guild: ${TESTSRV_ID}`);

			try {
				await rest.put(Routes.applicationGuildCommands(TOMORI_ID, TESTSRV_ID), {
					body: registrationData,
				});
				log.success(
					`Successfully registered ${registrationData.length} commands to development guild`,
				);
			} catch (error) {
				const context: ErrorContext = {
					errorType: "CommandRegistrationError",
					metadata: {
						scope: "guild",
						guildId: TESTSRV_ID,
					},
				};
				await log.error(
					"Failed to register commands to development guild:",
					error,
					context,
				);
			}
		} else {
			// Register globally (takes up to an hour to update)
			log.info("Registering commands globally");

			try {
				await rest.put(Routes.applicationCommands(TOMORI_ID), {
					body: registrationData,
				});
				log.success(
					`Successfully registered ${registrationData.length} commands globally`,
				);
			} catch (error) {
				const context: ErrorContext = {
					errorType: "CommandRegistrationError",
					metadata: { scope: "global" },
				};
				await log.error(
					"Failed to register commands globally:",
					error,
					context,
				);
			}
		}
	} catch (error) {
		const context: ErrorContext = {
			errorType: "CommandRegistrationError",
			metadata: { stage: "initialization" },
		};
		await log.error(
			"Error during command registration process:",
			error,
			context,
		);
	}
};
