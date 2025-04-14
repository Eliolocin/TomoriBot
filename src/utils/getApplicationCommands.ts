import { ApplicationCommand, Client, Collection } from "discord.js";

const getApplicationCommands = async (
	client: Client,
	guildId?: string,
): Promise<Collection<string, ApplicationCommand>> => {
	let applicationCommands: Collection<string, ApplicationCommand>;

	applicationCommands = await client.application!.commands.fetch();

	// Setting commands for only ONE server (in most cases, the testServer)
	if (guildId) {
		// const guild = await client.guilds.fetch(guildId);
		// applicationCommands = guild.commands;
	} else {
		// applicationCommands = await client.application!.commands;
	}

	// await applicationCommands.fetch();
	return applicationCommands;
};

export default getApplicationCommands;
