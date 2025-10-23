import { sql } from "bun";
import { log } from "../src/utils/misc/logger";
import { config } from "dotenv";

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

// Configure database connection
const postgresUrl = getPostgresUrl();
process.env.DATABASE_URL = postgresUrl;

/**
 * Script to delete all data for a specific Discord server (TESTSRV_ID) from the database.
 * This is useful for testing TomoriBot setup from scratch.
 *
 * The deletion will cascade to the following tables due to ON DELETE CASCADE:
 * - tomoris
 * - tomori_configs (via tomoris)
 * - server_emojis
 * - server_stickers
 * - server_memories
 * - personalization_blacklist
 * - opt_api_keys
 * - reminders
 *
 * The error_logs table will have server_id set to NULL instead of being deleted.
 */
async function deleteTestServer() {
	const testServerId = process.env.TESTSRV_ID;

	if (!testServerId) {
		log.error("TESTSRV_ID not found in environment variables");
		process.exit(1);
	}

	log.section("🗑️ DELETE TEST SERVER SCRIPT");
	log.info(`Target Discord Server ID: ${testServerId}`);
	log.info(
		"This will DELETE ALL DATA for this server and cascade to related tables.",
	);

	// 1. Check if server exists in database
	const serverCheck = await sql`
		SELECT server_id, server_disc_id
		FROM servers
		WHERE server_disc_id = ${testServerId}
	`;

	if (serverCheck.length === 0) {
		log.info(`Server ${testServerId} not found in database. Nothing to delete.`);
		process.exit(0);
	}

	const serverInternalId = serverCheck[0].server_id;
	log.info(`Found server in database (internal ID: ${serverInternalId})`);

	// 2. Show what will be deleted
	log.section("Checking related data to be deleted...");

	const tomoriCount = await sql`
		SELECT COUNT(*) as count
		FROM tomoris
		WHERE server_id = ${serverInternalId}
	`;

	const emojiCount = await sql`
		SELECT COUNT(*) as count
		FROM server_emojis
		WHERE server_id = ${serverInternalId}
	`;

	const stickerCount = await sql`
		SELECT COUNT(*) as count
		FROM server_stickers
		WHERE server_id = ${serverInternalId}
	`;

	const memoryCount = await sql`
		SELECT COUNT(*) as count
		FROM server_memories
		WHERE server_id = ${serverInternalId}
	`;

	const blacklistCount = await sql`
		SELECT COUNT(*) as count
		FROM personalization_blacklist
		WHERE server_id = ${serverInternalId}
	`;

	const apiKeyCount = await sql`
		SELECT COUNT(*) as count
		FROM opt_api_keys
		WHERE server_id = ${serverInternalId}
	`;

	const reminderCount = await sql`
		SELECT COUNT(*) as count
		FROM reminders
		WHERE server_id = ${serverInternalId}
	`;

	const errorLogCount = await sql`
		SELECT COUNT(*) as count
		FROM error_logs
		WHERE server_id = ${serverInternalId}
	`;

	log.info(`Tomori configurations: ${tomoriCount[0].count}`);
	log.info(`Server emojis: ${emojiCount[0].count}`);
	log.info(`Server stickers: ${stickerCount[0].count}`);
	log.info(`Server memories: ${memoryCount[0].count}`);
	log.info(`Personalization blacklist entries: ${blacklistCount[0].count}`);
	log.info(`Optional API keys: ${apiKeyCount[0].count}`);
	log.info(`Reminders: ${reminderCount[0].count}`);
	log.info(
		`Error logs (will set server_id to NULL): ${errorLogCount[0].count}`,
	);

	// 3. Confirm deletion
	console.log("\nType 'DELETE SERVER' (all caps) to confirm deletion:");

	const response = await new Promise<string>((resolve) => {
		process.stdin.resume();
		process.stdin.once("data", (data) => {
			resolve(data.toString().trim());
			process.stdin.pause();
		});
	});

	if (response !== "DELETE SERVER") {
		log.info("Aborted. No data was deleted.");
		process.exit(0);
	}

	log.info("Confirmation received. Starting deletion process...");

	try {
		// 4. Delete the server (cascades to most related tables)
		const deleteResult = await sql`
			DELETE FROM servers
			WHERE server_disc_id = ${testServerId}
		`;

		log.success(`Server ${testServerId} and all related data deleted successfully!`);
		log.info(
			`${deleteResult.count} server record deleted (cascaded to related tables)`,
		);

		// 5. Verify deletion
		const verifyCheck = await sql`
			SELECT COUNT(*) as count
			FROM servers
			WHERE server_disc_id = ${testServerId}
		`;

		const remainingCount = Number(verifyCheck[0].count);

		if (remainingCount === 0) {
			log.section("✅ Deletion Complete!");
			log.info("Server has been completely removed from the database.");
			log.info("You can now test setting up TomoriBot from scratch.");
		} else {
			log.error(`Verification failed: ${remainingCount} server record(s) still exist in database!`);
		}
	} catch (error) {
		log.error("Error during deletion process:", error);
	} finally {
		process.exit(0);
	}
}

deleteTestServer();
