import type { ApplicationCommand, Client, Collection } from "discord.js";

/**
 * Fetches all application commands registered with the Discord client.
 * @param client - The Discord client instance.
 * @returns A promise resolving to a collection of application commands.
 * @throws If the client application is not initialized.
 */
const getApplicationCommands = async (
	client: Client,
): Promise<Collection<string, ApplicationCommand>> => {
	if (!client.application) {
		throw new Error("Client application is not initialized.");
	}
	return await client.application.commands.fetch();
};

export default getApplicationCommands;
