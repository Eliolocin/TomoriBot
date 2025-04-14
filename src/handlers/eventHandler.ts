import path from "path";
import { Client, Presence, VoiceState } from "discord.js";
import { EventFunction } from "../types/global";
import getAllFiles from "../utils/getAllFiles";

const handleEvent = (client: Client): void => {
	const eventFolders = getAllFiles(path.join(__dirname, "..", "events"), true);

	for (const eventFolder of eventFolders) {
		const eventFiles = getAllFiles(eventFolder);
		eventFiles.sort((a, b) => a.localeCompare(b));

		const eventName = eventFolder.replace(/\\/g, "/").split("/").pop();

		if (!eventName) continue;

		switch (eventName) {
			case "voiceStateUpdate":
				client.on(
					eventName,
					async (oldState: VoiceState, newState: VoiceState) => {
						for (const eventFile of eventFiles) {
							const eventModule = await import(eventFile);
							const eventFunction: EventFunction = eventModule.default;
							if (typeof eventFunction === "function") {
								await eventFunction(client, oldState, newState);
							}
						}
					},
				);
				break;

			case "presenceUpdate":
				client.on(
					eventName,
					async (oldPresence: Presence | null, newPresence: Presence) => {
						for (const eventFile of eventFiles) {
							const eventModule = await import(eventFile);
							const eventFunction: EventFunction = eventModule.default;
							if (typeof eventFunction === "function") {
								await eventFunction(client, oldPresence, newPresence);
							}
						}
					},
				);
				break;

			default:
				client.on(eventName, async (arg: any) => {
					for (const eventFile of eventFiles) {
						try {
							const eventModule = await import(eventFile);
							const eventFunction: EventFunction = eventModule.default;
							if (typeof eventFunction === "function") {
								await eventFunction(client, arg);
							} else {
								console.error(
									`Event file ${eventFile} does not export a default function`,
								);
							}
						} catch (error) {
							console.error(`Error loading event file ${eventFile}:`, error);
						}
					}
				});
		}
	}
};

export default handleEvent;
