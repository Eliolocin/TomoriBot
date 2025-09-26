import { Client, GatewayIntentBits, Partials } from "discord.js";
import { config } from "dotenv";
import { sql } from "bun";
import { log } from "./utils/misc/logger";
import path from "node:path";
import eventHandler from "./handlers/eventHandler";
import { initializeLocalizer } from "./utils/text/localizer";

config();

/**
 * Get PostgreSQL connection URL from environment variables
 * Supports both POSTGRES_URL and component-based configuration
 */
function getPostgresUrl(): string {
	// If POSTGRES_URL is provided, use it directly (backwards compatibility)
	if (process.env.POSTGRES_URL) {
		return process.env.POSTGRES_URL;
	}

	// Otherwise, build URL from components
	const host = process.env.POSTGRES_HOST || "localhost";
	const port = process.env.POSTGRES_PORT || "5432";
	const user = process.env.POSTGRES_USER || "postgres";
	const password = process.env.POSTGRES_PASSWORD;
	const database = process.env.POSTGRES_DB || "tomodb";

	if (!password) {
		throw new Error(
			"Database password must be provided via POSTGRES_PASSWORD or POSTGRES_URL",
		);
	}

	return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

const postgresUrl = getPostgresUrl();

const dbUrl = new URL(postgresUrl);

process.env.DATABASE_URL = postgresUrl;

const dbHost = dbUrl.hostname;
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

/**
 * Handle Discord client errors to prevent crashes from malformed error objects
 */
client.on("error", (error) => {
	log.error("Discord client error occurred", error);
});

client.on("shardError", (error) => {
	log.error("Discord WebSocket shard error occurred", error);
});

/**
 * Handle process-level uncaught errors to prevent crashes
 */
process.on("uncaughtException", (error) => {
	log.error("Uncaught exception occurred", error);
	// Don't exit process for WebSocket errors - let Discord.js reconnect
	if (error.message?.includes("error is not an Object")) {
		log.warn("WebSocket error caught - Discord.js will attempt to reconnect");
		return;
	}
	process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
	log.error("Unhandled promise rejection", reason, {
		errorType: "UnhandledPromiseRejection",
		metadata: { promise: promise.toString() },
	});
});

log.section("Initializing Database...");

// Small delay in development to reduce hot-reload conflicts
if (process.env.NODE_ENV !== "production") {
	await new Promise((resolve) => setTimeout(resolve, 500));
}

/**
 * Initialize database schema and seed data with retry logic for development hot-reloading
 * @param maxRetries - Maximum number of retry attempts
 * @param delayMs - Delay between retries in milliseconds
 */
async function initializeDatabase(
	maxRetries = 3,
	delayMs = 1000,
): Promise<void> {
	const schemaPath = path.join(import.meta.dir, "db", "schema.sql");
	const seedPath = path.join(import.meta.dir, "db", "seed.sql");

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			// Initialize schema
			await sql.file(schemaPath);
			log.success("PostgreSQL database schema verified");

			// Initialize seed data
			await sql.file(seedPath);
			log.success("PostgreSQL database seed verified");

			return; // Success - exit retry loop
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);

			// Check if this is a concurrency error that might resolve with retry
			const isConcurrencyError =
				errorMessage.includes("tuple concurrently updated") ||
				errorMessage.includes("could not serialize access") ||
				errorMessage.includes("deadlock detected");

			if (isConcurrencyError && attempt < maxRetries) {
				log.warn(
					`Database initialization attempt ${attempt} failed due to concurrency (retrying in ${delayMs}ms): ${errorMessage}`,
				);
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			} else {
				// Non-retryable error or max retries exceeded
				log.error(
					`PostgreSQL database initialization failed after ${attempt} attempts:`,
					err,
				);
				process.exit(1);
			}
		}
	}
}

await initializeDatabase();

// Clean up expired cooldowns on startup (development alternative to pg_cron)
log.section("Cleaning up expired cooldowns...");
try {
	const { cleanupExpiredCooldowns } = await import(
		"./utils/db/cooldownsCleanup"
	);
	const cleanupResult = await cleanupExpiredCooldowns();
	if (cleanupResult.success) {
		log.success(
			`Cooldowns cleanup completed: ${cleanupResult.deletedCount} expired entries removed`,
		);
	} else {
		log.warn(`Cooldowns cleanup failed: ${cleanupResult.error}`);
	}
} catch (error) {
	log.warn("Error during startup cooldowns cleanup:", error);
	// Non-critical error - continue startup
}

// Attempt to set up pg_cron for production environments (non-critical)
if (!postgresUrl) {
	log.warn("POSTGRES_URL not found in .env. Skipping cron job scheduling.");
} else {
	try {
		if (!dbHost || Number.isNaN(dbPort)) {
			throw new Error(
				`Could not parse hostname or port from POSTGRES_URL: ${postgresUrl}`,
			);
		}

		// 1. First check if the pg_cron extension is available
		const [extensionCheck] = await sql`
			SELECT EXISTS (
				SELECT 1 FROM pg_available_extensions 
				WHERE name = 'pg_cron'
			) as available
		`;

		if (!extensionCheck?.available) {
			log.warn(
				"pg_cron extension not available - using startup cleanup method",
			);
		} else {
			// 2. Enable pg_cron extension
			await sql`CREATE EXTENSION IF NOT EXISTS pg_cron;`;

			// 3. Schedule the cleanup function
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
		}
	} catch (err) {
		log.info(
			`pg_cron setup failed (non-critical): ${err instanceof Error ? err.message : err}`,
		);
		log.info("Cooldown cleanup will be handled by startup method instead");
	}
}

// Initialize modular tool system
log.section("Initializing Tool Registry...");
try {
	const { initializeTools } = await import("./tools/toolInitializer");
	initializeTools();
	log.success("Tool registry initialized successfully");
} catch (error) {
	log.error("Failed to initialize tool registry", error as Error);
	process.exit(1);
}

// Initialize localization
log.section("Initializing Locales...");
await initializeLocalizer();

// Starts the event handler, which also runs important 'ready' functions
// such as registering or updating of commands upon startup
eventHandler(client);

// Initialize reminder timer system (fallback for when pg_cron is not available)
log.section("Initializing Reminder System...");
try {
	const { initializeReminderTimer } = await import("./timers/reminderTimer");

	// Start reminder timer after client is ready
	client.once("clientReady", () => {
		initializeReminderTimer(client);
		log.success("Reminder system initialized with fallback polling");
	});
} catch (error) {
	log.error("Failed to initialize reminder system", error as Error);
	// Non-critical error - reminders won't work but bot can still function
}

// Login Bot using Discord Token
client.login(process.env.DISCORD_TOKEN);
