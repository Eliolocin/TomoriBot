import { $ } from "bun";
import { log } from "../src/utils/misc/logger";
import { config } from "dotenv";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

config();

// Construct DATABASE_URL from individual env vars if not provided
if (!process.env.DATABASE_URL) {
	const host = process.env.POSTGRES_HOST || "localhost";
	const port = process.env.POSTGRES_PORT || "5432";
	const user = process.env.POSTGRES_USER || "postgres";
	const password = process.env.POSTGRES_PASSWORD;
	const database = process.env.POSTGRES_DB || "tomodb";

	if (!password) {
		log.error("POSTGRES_PASSWORD environment variable not found!");
		process.exit(1);
	}

	process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}:${port}/${database}`;
	log.info(`Constructed DATABASE_URL for connection`);
}

/**
 * Backs up the PostgreSQL database using pg_dump utility.
 * Creates timestamped backup files in the backups/ directory.
 *
 * The backup file will be named: tomoribot_backup_YYYY-MM-DD_HH-MM-SS.sql
 *
 * @returns {Promise<void>}
 */
async function backupDatabase(): Promise<void> {
	log.section("📦 DATABASE BACKUP SCRIPT");

	// 1. Ensure backups directory exists
	const backupsDir = join(process.cwd(), "backups");
	if (!existsSync(backupsDir)) {
		mkdirSync(backupsDir, { recursive: true });
		log.info(`Created backups directory: ${backupsDir}`);
	}

	// 2. Generate timestamp for backup filename
	const timestamp = new Date()
		.toISOString()
		.replace(/:/g, "-")
		.replace(/\..+/, "")
		.replace("T", "_");

	const backupFilename = `tomoribot_backup_${timestamp}.sql`;
	const backupPath = join(backupsDir, backupFilename);

	// 3. Parse database connection from environment
	let dbUrl = process.env.DATABASE_URL;

	// If DATABASE_URL not found, construct from individual Postgres variables
	if (!dbUrl) {
		const { POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = process.env;

		if (!POSTGRES_HOST || !POSTGRES_PORT || !POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
			log.error("Database connection not configured!");
			log.info("Please ensure your .env file contains either:");
			log.info("  1. DATABASE_URL (e.g., postgresql://user:pass@host:port/dbname)");
			log.info("  OR");
			log.info("  2. Individual variables: POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB");
			process.exit(1);
		}

		// Construct DATABASE_URL from individual variables
		dbUrl = `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`;
		log.info("Constructed DATABASE_URL from individual Postgres variables");
	}

	log.info(`Backup will be saved to: ${backupPath}`);
	log.info("Starting pg_dump...");

	try {
		// 4. Execute pg_dump command
		// Use DATABASE_URL directly - pg_dump supports postgresql:// URLs
		await $`pg_dump ${dbUrl} -f ${backupPath}`;

		log.success(`✅ Database backup completed successfully!`);
		log.info(`Backup file: ${backupFilename}`);
		log.info(`Full path: ${backupPath}`);
	} catch (error) {
		log.error("❌ Backup failed!");

		if (error instanceof Error) {
			log.error(error.message);
		}

		// Check if pg_dump is available
		try {
			await $`pg_dump --version`;
		} catch {
			log.error("pg_dump command not found!");
			log.info("Please install PostgreSQL command-line tools:");
			log.info("  - Windows: Install PostgreSQL from https://www.postgresql.org/download/windows/");
			log.info("  - macOS: brew install postgresql");
			log.info("  - Linux: sudo apt-get install postgresql-client");
		}

		process.exit(1);
	}
}

backupDatabase();
