import { Client, GatewayIntentBits, Partials } from "discord.js";
import { config } from "dotenv";
import { sql } from "bun";
import { log } from "./utils/misc/logger";
import path from "node:path";
import eventHandler from "./handlers/eventHandler";
import { initializeLocalizer } from "./utils/text/localizer";

config();

// Schedule Cron Job (using parsed POSTGRES_URL)
const postgresUrl = process.env.POSTGRES_URL;

// biome-ignore lint/style/noNonNullAssertion: <explanation>
const dbUrl = new URL(process.env.POSTGRES_URL!);
const dbHost = dbUrl.hostname;
// Ensure port is parsed as integer, provide default if missing
const dbPort = Number.parseInt(dbUrl.port || "5432", 10);

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
		GatewayIntentBits.GuildExpressions,
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

if (!postgresUrl) {
	log.warn("POSTGRES_URL not found in .env. Skipping cron job scheduling.");
} else {
	try {
		if (!dbHost || Number.isNaN(dbPort)) {
			throw new Error(
				`Could not parse hostname or port from POSTGRES_URL: ${postgresUrl}`,
			);
		}

		// 1. First ensure the pg_cron extension is enabled
		await sql`CREATE EXTENSION IF NOT EXISTS pg_cron;`;

		// 2. Then schedule the cleanup function
		// Parse the URL to extract hostname and port
		await sql`
			INSERT INTO cron.job (schedule, command, nodename, nodeport, database, username)
			VALUES (
				'0 * * * *', -- Run at the start of every hour
				'SELECT cleanup_expired_cooldowns();',
				${dbHost},          -- Use parsed hostname
				${dbPort},          -- Use parsed port
				current_database(), -- Still use SQL functions for these
				current_user
			)
			ON CONFLICT (command, database, username, nodename, nodeport)
			DO UPDATE SET schedule = EXCLUDED.schedule; -- Update schedule if job already exists
		`;
		log.success(
			`pg_cron job for cooldown cleanup scheduled/verified for ${dbHost}:${dbPort}`,
		);
	} catch (err) {
		const context = {
			errorType: "StartupError",
			metadata: {
				stage: "CronJobSetup",
				dbHost,
				dbPort,
			},
		};
		await log.error(
			"Failed to schedule pg_cron job for cooldown cleanup",
			err,
			context,
		);
		// Decide if this is critical enough to exit, or just log the error
		// process.exit(1);
	}
}

// Initialize localization first
log.section("Initializing Locales...");
await initializeLocalizer();

// Starts the event handler, which also runs important 'ready' functions
// such as registering or updating of commands upon startup
eventHandler(client);

// Login Bot using Discord Token
client.login(process.env.DISCORD_TOKEN);
