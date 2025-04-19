import {
	Client,
	GatewayIntentBits,
	IntentsBitField,
	Partials,
} from "discord.js";
import { config } from "dotenv";
import { sql } from "bun";
import { log } from "./utils/logBeautifier";
import path from "node:path";
import eventHandler from "./handlers/eventHandler";
import { localizer } from "./utils/textLocalizer";

config();

const client = new Client({
	intents: [
		// Intents required by the Discord Bot
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildPresences,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.GuildMessageReactions,
	],
	partials: [Partials.Channel, Partials.Message],
});

log.section("Initializing Database...");

// Check database connection and then initialize PostgreSQL schema if needed
const schemaPath = path.join(import.meta.dir, "db", "schema.sql");

await sql
	.file(schemaPath)
	.then(() => {
		log.success("PostgreSQL database schema verified");
	})
	.catch((err) => {
		log.error("PostgreSQL database schema verification error", err);
		process.exit(1);
	});

const seedPath = path.join(import.meta.dir, "db", "seed.sql");
await sql
	.file(seedPath)
	.then(() => {
		log.success("PostgreSQL database seed verified");
	})
	.catch((err) => {
		log.error("PostgreSQL database seed verification error", err);
		process.exit(1);
	});

// Starts the event handler, which also runs important 'ready' functions
// such as registering or updating of commands upon startup
eventHandler(client);

///////////// TO BE REMOVED ////////////////
import mongoose from "mongoose";
// Connect to MongoDB
const mongoUri = process.env.MONGODB_SRV;
if (!mongoUri) {
	throw new Error(
		"MongoDB connection string is not defined in environment variables",
	);
}
mongoose.connect(mongoUri);
///////////// TO BE REMOVED ////////////////

// Login Bot using Discord Token
client.login(process.env.DISCORD_TOKEN);
