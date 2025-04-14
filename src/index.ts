import {
	Client,
	GatewayIntentBits,
	IntentsBitField,
	Partials,
} from "discord.js";
import { config } from "dotenv";
import mongoose from "mongoose";
import eventHandler from "./handlers/eventHandler";

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

// First register event han// Activate Command Handler
eventHandler(client);

// Connect to MongoDB
const mongoUri = process.env.MONGODB_SRV;
if (!mongoUri) {
	throw new Error(
		"MongoDB connection string is not defined in environment variables",
	);
}
mongoose
	.connect(mongoUri)
	.then(() => {
		console.log("Connected to MongoDB!");
	})
	.catch((err) => {
		console.error("MongoDB connection error:", err);
	});

// Login Bot using Discord Token
client.login(process.env.DISCORD_TOKEN);
