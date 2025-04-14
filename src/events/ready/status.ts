import { ActivityOptions, ActivityType, Client } from "discord.js";
import pkg from "../../../package.json";

const handler = async (client: Client): Promise<void> => {
	// Clear visual separator for hot reload
	console.log("\n=================");
	console.log(`[${new Date().toLocaleTimeString()}]`);
	console.log(`${client.user?.tag} is now online!`);
	console.log("=================\n");

	const status: ActivityOptions[] = [
		{
			// Add a "Playing" status with the version from package.json
			name: `v${pkg.version}`,
			type: ActivityType.Playing,
		},
		{
			name: "/help",
			type: ActivityType.Listening,
		},
		// ...existing status entries...
	];

	setInterval(() => {
		const random = Math.floor(Math.random() * status.length);
		client.user?.setActivity(status[random]);
	}, 600000);

	client.user?.setActivity(status[1]);
};

export default handler;
