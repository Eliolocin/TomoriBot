import { type ActivityOptions, ActivityType, type Client } from "discord.js";
import pkg from "../../../package.json";
import { log } from "../../utils/misc/logger";

const CYCLE_DELAY = 300000;
/**
 * Sets the bot's status and logs startup information.
 * @param client - The Discord client instance.
 * @returns Promise<void>
 */
const handler = async (client: Client): Promise<void> => {
	log.section(`Launching ${client.user?.tag} on Discord...`);
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
		const random = Math.floor(Math.random() * status.length);
		client.user?.setActivity(status[random]);
	}, CYCLE_DELAY);

	client.user?.setActivity(status[1]);
};

export default handler;
