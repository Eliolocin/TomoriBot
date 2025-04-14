import {
	ApplicationCommand,
	ApplicationCommandData,
	ApplicationCommandOptionData,
	Client,
} from "discord.js";
import areCommandsDifferent from "../../utils/areCommandsDifferent";
import getApplicationCommands from "../../utils/getApplicationCommands";
import getLocalCommands from "../../utils/getLocalCommands";

interface ExtendedLocalCommand {
	name: string;
	description: string;
	options?: ApplicationCommandOptionData[];
	deleted?: boolean;
}

const handler = async (client: Client): Promise<void> => {
	const testServer = process.env.JACKO_ID as string;

	try {
		const localCommands = (await getLocalCommands()) as ExtendedLocalCommand[];
		const applicationCommandManager = await getApplicationCommands(
			client,
			testServer,
		);

		for (const localCommand of localCommands) {
			const { name, description, options } = localCommand;

			const existingCommand = applicationCommandManager.find(
				(cmd: ApplicationCommand) => cmd.name === name,
			);

			if (existingCommand) {
				if (localCommand.deleted) {
					await applicationCommandManager.delete(existingCommand.id);
					console.log(`(Deleted command "${name}")`);
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
					console.log(
						`(Skipping registering command "${name}" as it's set to be deleted)`,
					);
					continue;
				}

				const commandData: ApplicationCommandData = {
					name,
					description,
					options: options as ApplicationCommandOptionData[],
				};
				await client.application?.commands.create(commandData);
				console.log(`(Registered command "${name}")`);
			}
		}
	} catch (error) {
		console.log(
			`There was a slash command registration error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};

export default handler;
