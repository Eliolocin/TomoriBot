import { sql } from "bun";
import { log } from "../src/utils/misc/logger";
import { config } from "dotenv";

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
 * Validates that database connection environment variables are set.
 * Supports both DATABASE_URL and individual Postgres variables.
 */
function validateDatabaseConfig(): void {
	const { DATABASE_URL, POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = process.env;

	// Check if either DATABASE_URL or all individual variables are set
	const hasDatabaseUrl = !!DATABASE_URL;
	const hasIndividualVars = POSTGRES_HOST && POSTGRES_PORT && POSTGRES_USER && POSTGRES_PASSWORD && POSTGRES_DB;

	if (!hasDatabaseUrl && !hasIndividualVars) {
		log.error("Database connection not configured!");
		log.info("Please ensure your .env file contains either:");
		log.info("  1. DATABASE_URL (e.g., postgresql://user:pass@host:port/dbname)");
		log.info("  OR");
		log.info("  2. Individual variables: POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB");
		process.exit(1);
	}

	if (hasIndividualVars && !hasDatabaseUrl) {
		log.info("Using individual Postgres variables for database connection");
	}
}

/**
 * Migration script to fix user data retention on account deletion.
 *
 * This migration changes several tables to preserve community data when users
 * delete their accounts. Changes from CASCADE to SET NULL ensure that:
 * - Server memories outlive their creators
 * - Reminders persist even if creator leaves
 * - Personalization opt-outs persist across account recreation
 *
 * Tables affected:
 * - server_memories: user_id becomes nullable with SET NULL constraint
 * - reminders: created_by_user_id becomes nullable with SET NULL constraint
 * - personalization_blacklist: Changes from user_id (FK) to user_disc_id (TEXT)
 *
 * IMPORTANT: Run `bun run backup-db` before executing this migration!
 *
 * @returns {Promise<void>}
 */
async function migrateNullableUserId(): Promise<void> {
	// Validate database configuration before starting
	validateDatabaseConfig();

	log.section("🔄 DATABASE MIGRATION: User Data Retention");
	log.info("This migration will modify the following tables:");
	log.info("  1. server_memories: Make user_id nullable (SET NULL on delete)");
	log.info("  2. reminders: Make created_by_user_id nullable (SET NULL on delete)");
	log.info("  3. personalization_blacklist: Change user_id to user_disc_id (persist opt-outs)");
	log.info("");
	log.info("Impact: Community data and privacy preferences persist when users delete accounts.");
	log.info("");
	log.warn("⚠️  IMPORTANT: Ensure you have a database backup before proceeding!");
	log.info("Run: bun run backup-db");
	log.info("");

	console.log("Type 'MIGRATE' (all caps) to confirm migration:");

	const response = await new Promise<string>((resolve) => {
		process.stdin.resume();
		process.stdin.once("data", (data) => {
			resolve(data.toString().trim());
			process.stdin.pause();
		});
	});

	if (response !== "MIGRATE") {
		log.info("Migration aborted. Database unchanged.");
		process.exit(0);
	}

	log.info("Confirmation received. Starting migration...");
	log.info("");

	try {
		// === Part 1: server_memories table ===
		log.info("");
		log.info("=== Migrating server_memories table ===");

		// 1. Make server_memories.user_id nullable
		log.info("Step 1a: Making server_memories.user_id nullable...");
		await sql`
			ALTER TABLE server_memories
			ALTER COLUMN user_id DROP NOT NULL;
		`;
		log.success("✅ server_memories.user_id is now nullable");

		// 2. Drop existing CASCADE constraint on server_memories
		log.info("Step 1b: Dropping old CASCADE constraint on server_memories...");
		await sql`
			ALTER TABLE server_memories
			DROP CONSTRAINT IF EXISTS server_memories_user_id_fkey;
		`;
		log.success("✅ Old server_memories constraint dropped");

		// 3. Add new SET NULL constraint on server_memories
		log.info("Step 1c: Adding new SET NULL constraint on server_memories...");
		await sql`
			ALTER TABLE server_memories
			ADD CONSTRAINT server_memories_user_id_fkey
			FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL;
		`;
		log.success("✅ New server_memories constraint added (ON DELETE SET NULL)");

		// 4. Add comment on server_memories
		log.info("Step 1d: Adding documentation comment on server_memories...");
		await sql`
			COMMENT ON COLUMN server_memories.user_id IS
			'Creator of this server memory (nullable - set to NULL if user deleted)';
		`;
		log.success("✅ server_memories documentation comment added");

		// === Part 2: reminders table ===
		log.info("");
		log.info("=== Migrating reminders table ===");

		// 5. Make reminders.created_by_user_id nullable
		log.info("Step 2a: Making reminders.created_by_user_id nullable...");
		await sql`
			ALTER TABLE reminders
			ALTER COLUMN created_by_user_id DROP NOT NULL;
		`;
		log.success("✅ reminders.created_by_user_id is now nullable");

		// 6. Drop existing CASCADE constraint on reminders
		log.info("Step 2b: Dropping old CASCADE constraint on reminders...");
		await sql`
			ALTER TABLE reminders
			DROP CONSTRAINT IF EXISTS reminders_created_by_user_id_fkey;
		`;
		log.success("✅ Old reminders constraint dropped");

		// 7. Add new SET NULL constraint on reminders
		log.info("Step 2c: Adding new SET NULL constraint on reminders...");
		await sql`
			ALTER TABLE reminders
			ADD CONSTRAINT reminders_created_by_user_id_fkey
			FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL;
		`;
		log.success("✅ New reminders constraint added (ON DELETE SET NULL)");

		// 8. Add comment on reminders
		log.info("Step 2d: Adding documentation comment on reminders...");
		await sql`
			COMMENT ON COLUMN reminders.created_by_user_id IS
			'User who created this reminder (nullable - set to NULL if user deleted)';
		`;
		log.success("✅ reminders documentation comment added");

		// === Part 3: personalization_blacklist table ===
		log.info("");
		log.info("=== Migrating personalization_blacklist table ===");

		// 9. Migrate existing data from user_id to user_disc_id
		log.info("Step 3a: Adding user_disc_id column to personalization_blacklist...");
		await sql`
			ALTER TABLE personalization_blacklist
			ADD COLUMN IF NOT EXISTS user_disc_id TEXT;
		`;
		log.success("✅ user_disc_id column added");

		// 10. Populate user_disc_id from users table
		log.info("Step 3b: Migrating existing data to user_disc_id...");
		await sql`
			UPDATE personalization_blacklist pb
			SET user_disc_id = u.user_disc_id
			FROM users u
			WHERE pb.user_id = u.user_id AND pb.user_disc_id IS NULL;
		`;
		log.success("✅ Existing data migrated to user_disc_id");

		// 11. Drop the old PRIMARY KEY constraint
		log.info("Step 3c: Dropping old PRIMARY KEY constraint...");
		await sql`
			ALTER TABLE personalization_blacklist
			DROP CONSTRAINT IF EXISTS personalization_blacklist_pkey;
		`;
		log.success("✅ Old PRIMARY KEY constraint dropped");

		// 12. Drop the old foreign key constraint on user_id
		log.info("Step 3d: Dropping old foreign key constraint on user_id...");
		await sql`
			ALTER TABLE personalization_blacklist
			DROP CONSTRAINT IF EXISTS personalization_blacklist_user_id_fkey;
		`;
		log.success("✅ Old user_id foreign key constraint dropped");

		// 13. Make user_disc_id NOT NULL
		log.info("Step 3e: Making user_disc_id NOT NULL...");
		await sql`
			ALTER TABLE personalization_blacklist
			ALTER COLUMN user_disc_id SET NOT NULL;
		`;
		log.success("✅ user_disc_id is now NOT NULL");

		// 14. Drop the old user_id column
		log.info("Step 3f: Dropping old user_id column...");
		await sql`
			ALTER TABLE personalization_blacklist
			DROP COLUMN IF EXISTS user_id;
		`;
		log.success("✅ Old user_id column dropped");

		// 15. Add new PRIMARY KEY on (server_id, user_disc_id)
		log.info("Step 3g: Adding new PRIMARY KEY constraint...");
		await sql`
			ALTER TABLE personalization_blacklist
			ADD PRIMARY KEY (server_id, user_disc_id);
		`;
		log.success("✅ New PRIMARY KEY constraint added (server_id, user_disc_id)");

		// 16. Add comment on personalization_blacklist
		log.info("Step 3h: Adding documentation comment on personalization_blacklist...");
		await sql`
			COMMENT ON COLUMN personalization_blacklist.user_disc_id IS
			'Discord ID of user who opted out (persists even if user deletes account)';
		`;
		log.success("✅ personalization_blacklist documentation comment added");

		log.info("");
		log.section("✅ Migration completed successfully!");
		log.info("Community data and privacy preferences will now persist when users delete accounts.");
	} catch (error) {
		log.error("❌ Migration failed!");
		log.error("Error details:", error);
		log.info("");
		log.warn("⚠️  Database may be in an inconsistent state!");
		log.info("To restore from backup:");
		log.info("  1. Find your backup file in backups/ directory");
		log.info("  2. Run: psql [DATABASE_URL] < backups/tomoribot_backup_[timestamp].sql");
		process.exit(1);
	} finally {
		process.exit(0);
	}
}

migrateNullableUserId();
