import path from "node:path";
import fs from "node:fs"; // Use node:fs for existsSync
import type {
	Client,
	// Import specific event argument types if needed later for type guards
} from "discord.js";
import type { EventArg, EventFunction } from "../types/discord/global"; // Rule 14
import getAllFiles from "../utils/misc/ioHelper";
import { log } from "../utils/misc/logger"; // Rule 18

/**
 * Sets up all event listeners for the Discord client by dynamically importing event modules.
 * Maps specific Discord events to handler folders.
 * @param client - The Discord client instance.
 */
const setupEventListeners = (client: Client): void => {
	log.section("Starting Event Listeners Setup..."); // Rule 18
	const eventsBasePath = path.join(__dirname, "..", "events");

	// 1. Define mappings from Discord event names to our handler folder names
	// Why: This allows multiple events to trigger handlers in the same folder.
	const eventFolderMap: Record<string, string> = {
		// Existing events
		voiceStateUpdate: "voiceStateUpdate",
		presenceUpdate: "presenceUpdate",
		guildCreate: "guildCreate",
		guildMemberAdd: "guildMemberAdd",
		interactionCreate: "interactionCreate",
		messageCreate: "messageCreate",
		clientReady: "clientReady",
		// New mappings for consolidated handlers
		emojiCreate: "guildEmojisUpdate", // Map emoji events to one folder
		emojiDelete: "guildEmojisUpdate",
		emojiUpdate: "guildEmojisUpdate",
		stickerCreate: "guildStickersUpdate", // Map sticker events to one folder
		stickerDelete: "guildStickersUpdate",
		stickerUpdate: "guildStickersUpdate",
	};

	// 2. Get all unique handler folder names that we expect to exist
	const uniqueHandlerFolders = [...new Set(Object.values(eventFolderMap))];

	// 3. Verify handler folders exist (optional but good practice)
	for (const folderName of uniqueHandlerFolders) {
		const folderPath = path.join(eventsBasePath, folderName);
		if (!fs.existsSync(folderPath)) {
			// Use fs.existsSync
			log.warn(`Handler folder not found, skipping: ${folderName}`);
			// We'll still try to attach listeners, but they might fail if folder is missing
		}
	}

	// 4. Iterate through the defined mappings to attach listeners
	for (const [eventName, handlerFolderName] of Object.entries(eventFolderMap)) {
		const handlerFolderPath = path.join(eventsBasePath, handlerFolderName);

		try {
			// 5. Check if the target handler folder exists before proceeding
			if (!fs.existsSync(handlerFolderPath)) {
				// log.warn(`Handler folder ${handlerFolderName} not found for event ${eventName}. Skipping listener setup.`);
				continue; // Skip attaching listener if handler folder is missing
			}

			// 6. Get all handler files within the mapped folder
			const eventFiles = getAllFiles(handlerFolderPath); // Rule 2: Uses our helper which uses node:fs
			if (eventFiles.length === 0) {
				// log.warn(`No handler files found in ${handlerFolderName} for event ${eventName}.`);
				continue; // Skip if no files in the folder
			}
			eventFiles.sort((a, b) => a.localeCompare(b)); // Ensure consistent order

			// 7. Attach the listener using the actual Discord eventName
			client.on(eventName, async (...args: EventArg[]) => {
				// log.info(`Event triggered: ${eventName} -> Handling with ${handlerFolderName}`); // Optional debug log

				// 8. Execute all handlers found in the mapped folder
				for (const eventFile of eventFiles) {
					try {
						const eventModule = await import(eventFile);
						// Assume default export is the handler function
						const eventFunction: EventFunction = eventModule.default;

						if (typeof eventFunction === "function") {
							// Pass client and all event arguments using spread syntax
							await eventFunction(client, ...args);
						} else {
							log.warn(`Default export in ${eventFile} is not a function.`);
						}
					} catch (importError) {
						// Log error during import or execution (Rule 22)
						log.error(
							`Failed to import or execute event file: ${eventFile} for event ${eventName}`,
							importError,
							{
								errorType: "EventHandlerError",
								metadata: { eventName, eventFile },
							},
						);
					}
				}
			});
			log.success(
				`Mapped "${eventName}" listener to "${handlerFolderName}" handlers`,
			); // Rule 18
		} catch (error) {
			// Log error during the setup phase for a specific listener (Rule 22)
			log.error(
				`Error setting up listener for event ${eventName} with handler ${handlerFolderName}`,
				error,
				{
					errorType: "EventHandlerSetupError",
					metadata: { eventName, handlerFolderName },
				},
			);
		}
	}
	log.section("Event Listeners Setup Complete."); // Rule 18
};

export default setupEventListeners;
