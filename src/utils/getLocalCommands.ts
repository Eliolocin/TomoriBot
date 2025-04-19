import path from "node:path";
import type { LocalCommand } from "../types/global";
import getAllFiles from "./getAllFiles";

/**
 * Loads all local command modules from the slash_commands directory.
 * @param exceptions - An array of command names to exclude.
 * @returns A promise resolving to an array of local command objects.
 */
const getLocalCommands = async (
	exceptions: string[] = [],
): Promise<LocalCommand[]> => {
	const localCommands: LocalCommand[] = [];

	const commandCategories = getAllFiles(
		path.join(__dirname, "..", "slash_commands"),
		true,
	);

	for (const commandCategory of commandCategories) {
		const commandFiles = getAllFiles(commandCategory);

		for (const commandFile of commandFiles) {
			const commandModule = await import(commandFile);
			const commandObject = commandModule.default;

			if (exceptions.includes(commandObject.name)) {
				continue;
			}

			localCommands.push(commandObject);
		}
	}

	return localCommands;
};

export default getLocalCommands;
