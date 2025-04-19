import type {
	ApplicationCommand,
	ApplicationCommandData,
	ApplicationCommandOptionData,
	Client,
} from "discord.js";
import areCommandsDifferent from "../../utils/areCommandsDifferent";
import getApplicationCommands from "../../utils/getApplicationCommands";
import getLocalCommands from "../../utils/getLocalCommands";
import { log } from "../../utils/logBeautifier";

interface ExtendedLocalCommand {
	name: string;
	description: string;
	options?: ApplicationCommandOptionData[];
	deleted?: boolean;
}

/**
 * Registers, updates, or deletes Discord slash commands to match local definitions.
 * @param client - The Discord client instance.
 * @returns Promise<void>
 */
const handler = async (client: Client): Promise<void> => {
	try {
		log.section("Reading Slash Command List...");
		const localCommands = (await getLocalCommands()) as ExtendedLocalCommand[];
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
						options: options as ApplicationCommandOptionData[],
					};
					await client.application?.commands.edit(
						existingCommand.id,
						commandData,
					);
				}
			} else {
				if (localCommand.deleted) {
					log.info(`Skipping command "${name}" as it's set for deletion`);
					continue;
				}

				const commandData: ApplicationCommandData = {
					name,
					description,
					options: options as ApplicationCommandOptionData[],
				};
				await client.application?.commands.create(commandData);
				log.success(`Registered command "${name}"`);
			}
		}
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
