import { Client, Guild, Locale } from "discord.js";
import dotenv from "dotenv";
import mongoose from "mongoose";
import initializeBot from "../src/events/guildCreate/initializeBot";

dotenv.config();

async function simulateGuildCreate() {
	try {
		// Connect to MongoDB
		await mongoose.connect(process.env.MONGODB_SRV!);
		console.log("Connected to MongoDB");

		const testServerId = process.env.TESTSRV_ID;
		if (!testServerId) {
			throw new Error("TESTSRV_ID is not defined in environment variables");
		}

		// Create minimal client and guild objects
		const client = new Client({ intents: [] });
		const mockGuild = {
			id: testServerId,
			preferredLocale: Locale.EnglishUS,
		} as Partial<Guild>;

		// Run the initialization
		await initializeBot(client, mockGuild as Guild);
		console.log("Test initialization completed");
	} catch (error) {
		console.error("Error during test:", error);
	} finally {
		await mongoose.disconnect();
		process.exit(0);
	}
}

// Run if called directly
if (require.main === module) {
	simulateGuildCreate();
}

export default simulateGuildCreate;
