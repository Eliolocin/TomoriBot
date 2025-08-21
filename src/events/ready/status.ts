import { type ActivityOptions, ActivityType, type Client } from "discord.js";
import pkg from "../../../package.json";
import { log } from "../../utils/misc/logger";
import { getMCPManager } from "../../utils/mcp/mcpManager";

// Cycle delay in milliseconds (300000ms = 5 minutes)
const CYCLE_DELAY = 300000;

/**
 * Sets the bot's status and logs startup information.
 * Waits for MCP initialization to complete before finalizing startup.
 * @param client - The Discord client instance.
 * @returns Promise<void>
 */
const handler = async (client: Client): Promise<void> => {
	log.section(`Launching ${client.user?.tag} on Discord...`);

	// Wait for MCP initialization to complete before finalizing startup
	const mcpManager = getMCPManager();
	
	// Wait for MCP manager to be ready (with a reasonable timeout)
	const mcpTimeout = 10000; // 10 seconds timeout
	const startTime = Date.now();
	
	while (!mcpManager.isReady() && (Date.now() - startTime) < mcpTimeout) {
		await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms between checks
	}

	if (mcpManager.isReady()) {
		const connectedCount = mcpManager.getConnectedServerCount();
		log.info(`MCP systems ready with ${connectedCount} server(s) connected`);
	} else {
		log.warn("MCP initialization timeout - proceeding with startup anyway");
	}

	log.success(`${client.user?.tag} up and running!`);

	log.section("Listening for error and info logs...");
	log.info(`Time started: [${new Date().toLocaleTimeString()}]`);

	const status: ActivityOptions[] = [
		{
			name: `v${pkg.version}`,
			type: ActivityType.Playing,
		},
		{
			name: "/help",
			type: ActivityType.Listening,
		},
		{
			name: "myself get refactored (again)",
			type: ActivityType.Watching,
		},
	];

	setInterval(() => {
		if (client.user && status.length > 0) {
			const random = Math.floor(Math.random() * status.length);
			client.user.setActivity(status[random]);
		}
	}, CYCLE_DELAY);

	// Set initial activity
	if (client.user && status.length > 1) {
		client.user.setActivity(status[0]);
	}
};

export default handler;
