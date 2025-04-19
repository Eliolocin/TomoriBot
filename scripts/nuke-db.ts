import { sql } from "bun";
import { log } from "../src/utils/logBeautifier";
import { config } from "dotenv";

config();

const tables = [
	"error_logs",
	"personalization_blacklist",
	"tomori_configs",
	"tomori_presets",
	"tomori_emojis",
	"tomoris",
	"users",
	"llms",
	"servers",
];

async function nukeDatabase() {
	log.section("⚠️ DATABASE DESTRUCTION SCRIPT ⚠️");
	log.info(
		"This will DELETE ALL TABLES and DATA in the connected PostgreSQL database.",
	);
	log.info(`Tables to be dropped: ${tables.join(", ")}`);

	console.log("\nType 'NUKE DATABASE' (all caps) to confirm deletion:");

	const response = await new Promise<string>((resolve) => {
		process.stdin.resume();
		process.stdin.once("data", (data) => {
			resolve(data.toString().trim());
			process.stdin.pause();
		});
	});

	if (response !== "NUKE DATABASE") {
		log.info("Aborted. Your database is safe.");
		process.exit(0);
	}

	log.info("Confirmation received. Starting database nuke process...");

	try {
		// Disable foreign key checks temporarily
		await sql`SET session_replication_role = 'replica';`;

		// Drop each table
		for (const table of tables) {
			try {
				await sql`DROP TABLE IF EXISTS ${sql(table)} CASCADE;`;
				log.success(`Dropped table: ${table}`);
			} catch (err) {
				log.error(`Failed to drop table ${table}:`, err);
			}
		}

		// Re-enable foreign key checks
		await sql`SET session_replication_role = 'origin';`;

		log.section("Database successfully nuked! 💣");
		log.info("You can now run the schema script to recreate empty tables.");
	} catch (error) {
		log.error("Error during database nuke process:", error);
	} finally {
		process.exit(0);
	}
}

nukeDatabase();
