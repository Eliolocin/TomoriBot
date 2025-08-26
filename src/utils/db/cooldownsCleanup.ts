import { sql } from "bun";
import { log } from "../misc/logger";

/**
 * Result of cooldowns cleanup operation
 */
export interface CooldownsCleanupResult {
	success: boolean;
	deletedCount: number;
	error?: string;
}

/**
 * Cleans up expired cooldowns from the database.
 * In development environments, this can be used as an alternative to pg_cron.
 * Uses the PostgreSQL function cleanup_expired_cooldowns() defined in schema.sql.
 * @returns Promise<CooldownsCleanupResult> - Result of the cleanup operation
 */
export async function cleanupExpiredCooldowns(): Promise<CooldownsCleanupResult> {
	try {
		log.info("Starting cooldowns cleanup...");

		// Call the PostgreSQL function that handles cleanup logic
		const [result] = await sql`
			SELECT cleanup_expired_cooldowns() as deleted_count
		`;

		const deletedCount = Number(result?.deleted_count || 0);

		if (deletedCount > 0) {
			log.info(`Successfully cleaned up ${deletedCount} expired cooldowns`);
		} else {
			log.info("No expired cooldowns found to clean up");
		}

		return {
			success: true,
			deletedCount,
		};
	} catch (error) {
		log.error("Error cleaning up expired cooldowns:", error);
		return {
			success: false,
			deletedCount: 0,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Clears ALL cooldowns from the database.
 * WARNING: This is a destructive operation that removes all cooldown records.
 * Use only in development environments or when you explicitly need to reset all cooldowns.
 * @returns Promise<CooldownsCleanupResult> - Result of the cleanup operation
 */
export async function clearAllCooldowns(): Promise<CooldownsCleanupResult> {
	try {
		log.warn("Clearing ALL cooldowns from database...");

		// Use DELETE with RETURNING to get count of deleted rows
		const deletedRows = await sql`
			DELETE FROM cooldowns
			RETURNING *
		`;

		const deletedCount = deletedRows.length;

		log.warn(`Successfully cleared ${deletedCount} cooldown records from database`);

		return {
			success: true,
			deletedCount,
		};
	} catch (error) {
		log.error("Error clearing all cooldowns:", error);
		return {
			success: false,
			deletedCount: 0,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}