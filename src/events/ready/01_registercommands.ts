import type {
	ApplicationCommand,
	ApplicationCommandData,
	Client,
} from "discord.js";
import type { LocalCommand } from "../../types/discord/global";
import areCommandsDifferent from "../../utils/commands/areCommandsDifferent";
import getApplicationCommands from "../../utils/commands/getApplicationCommands";
import getLocalCommands from "../../utils/commands/getLocalCommands";
import { log } from "../../utils/misc/logger";

/**
 * Registers, updates, or deletes Discord slash commands to match local definitions.
 * @param client - The Discord client instance.
 * @returns Promise<void>
 */
const handler = async (client: Client): Promise<void> => {
	try {
		log.section("Reading Slash Command List...");
		const localCommands = (await getLocalCommands()) as LocalCommand[];
		const applicationCommandManager = await getApplicationCommands(client);
		const localCommandNames = new Set(localCommands.map((cmd) => cmd.name));

		for (const localCommand of localCommands) {
			const { name, description, options } = localCommand;

			const existingCommand = applicationCommandManager.find(
				(cmd: ApplicationCommand) => cmd.name === name,
			);

			if (existingCommand) {
				if (localCommand.deleted) {
					await applicationCommandManager.delete(existingCommand.id);
					log.success(`Deleted command "${name}"`);
					continue;
				}

				if (areCommandsDifferent(existingCommand, localCommand)) {
					const commandData: ApplicationCommandData = {
						name,
						description,
						options,
					};

					// biome-ignore lint/style/noNonNullAssertion: Client application is guaranteed to exist in ready event
					await client.application!.commands.edit(
						existingCommand.id,
						commandData,
					);
					log.success(`Updated command "${name}"`);
				}
			} else {
				if (localCommand.deleted) {
					log.info(`Skipping command "${name}" as it's set for deletion`);
					continue;
				}

				const commandData: ApplicationCommandData = {
					name,
					description,
					options,
				};
				// biome-ignore lint/style/noNonNullAssertion: Client application is guaranteed to exist in ready event
				await client.application!.commands.create(commandData);
				log.success(`Registered command "${name}"`);
			}
		}

		// Clean up deleted commands that still exist on Discord
		for (const [id, appCommand] of applicationCommandManager) {
			if (!localCommandNames.has(appCommand.name)) {
				await applicationCommandManager.delete(id);
				log.success(
					`Deleted command "${appCommand.name}" (file missing locally)`,
				);
			}
		}

		log.success("Slash commands up to date");
	} catch (error) {
		log.error(
			`There was a slash command registration error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};

export default handler;
