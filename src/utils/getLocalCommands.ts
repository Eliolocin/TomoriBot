import path from "path";
import { LocalCommand } from "../types/global";
import getAllFiles from "./getAllFiles";

const getLocalCommands = async (
	exceptions: string[] = [],
): Promise<LocalCommand[]> => {
	let localCommands: LocalCommand[] = [];

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
