import path from "node:path";
import type {
	Client,
	Presence,
	VoiceState,
	Guild,
	GuildMember,
	Interaction,
	Message,
} from "discord.js";
import type { EventFunction } from "../types/discord/global";
import getAllFiles from "../utils/misc/getAllFiles";
import { log } from "../utils/misc/logger";

/**
 * Sets up all event listeners for the Discord client by dynamically importing event modules.
 * @param client - The Discord client instance.
 */
const setupEventListeners = (client: Client): void => {
	log.section("Starting Event Listeners...");
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
								if (oldPresence !== null) {
									await eventFunction(client, oldPresence, newPresence);
								}
							}
						}
					},
				);
				break;

			case "guildCreate":
				client.on(eventName, async (guild: Guild) => {
					for (const eventFile of eventFiles) {
						const eventModule = await import(eventFile);
						const eventFunction: EventFunction = eventModule.default;
						if (typeof eventFunction === "function") {
							await eventFunction(client, guild);
						}
					}
				});
				break;

			case "guildMemberAdd":
				client.on(eventName, async (member: GuildMember) => {
					for (const eventFile of eventFiles) {
						const eventModule = await import(eventFile);
						const eventFunction: EventFunction = eventModule.default;
						if (typeof eventFunction === "function") {
							await eventFunction(client, member);
						}
					}
				});
				break;

			case "interactionCreate":
				client.on(eventName, async (interaction: Interaction) => {
					for (const eventFile of eventFiles) {
						const eventModule = await import(eventFile);
						const eventFunction: EventFunction = eventModule.default;
						if (typeof eventFunction === "function") {
							await eventFunction(client, interaction);
						}
					}
				});
				break;

			case "messageCreate":
				client.on(eventName, async (message: Message) => {
					for (const eventFile of eventFiles) {
						const eventModule = await import(eventFile);
						const eventFunction: EventFunction = eventModule.default;
						if (typeof eventFunction === "function") {
							await eventFunction(client, message);
						}
					}
				});
				break;

			case "ready":
				client.on(eventName, async () => {
					for (const eventFile of eventFiles) {
						const eventModule = await import(eventFile);
						const eventFunction: EventFunction = eventModule.default;
						if (typeof eventFunction === "function") {
							await eventFunction(client);
						}
					}
				});
				break;

			default:
				break;
		}
		log.success(`"${eventName}" listener ready`);
	}
};

export default setupEventListeners;
