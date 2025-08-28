import type { ErrorContext } from "@/types/db/schema";
import { sql } from "bun"; // Import bun sql

/**
 * Standard color scheme for both console logs and embeds
 */
export enum ColorCode {
	INFO = "#3498DB", // Cyan color (36)
	SUCCESS = "#2ECC71", // Green color (32)
	WARN = "#F1C40F", // Yellow color (33)
	ERROR = "#E74C3C", // Red color (31)
	SECTION = "#E066FF", // Purple color (35)
}

/**
 * Determines if non-essential logs should be shown based on environment
 */
const isProduction = process.env.RUN_ENV === 'production';

/**
 * Logging utility for formatted info, success, error, warning, and section messages.
 */
export const log = {
	info: (msg: string) => {
		if (!isProduction) {
			console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`);
		}
	},
	success: (msg: string) => {
		if (!isProduction) {
			console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`);
		}
	},
	warn: (msg: string, err?: unknown) => {
		if (!isProduction) {
			console.log(`\x1b[33m[WARNING]\x1b[0m ${msg}`);
			if (err) {
				console.log(
					err instanceof Error ? (err.stack ?? err.message) : String(err),
				);
			}
		}
	},
	/**
	 * Logs an error message to the console and attempts to insert it into the database.
	 * @param msg - The primary error message to log.
	 * @param err - The actual Error object or unknown error data (optional).
	 * @param context - Optional context containing IDs and metadata for DB logging.
	 */
	error: async (
		msg: string,
		err?: unknown,
		context?: ErrorContext,
	): Promise<void> => {
		// 1. Log to console (as before)
		console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
		const errorDetails =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		console.error(errorDetails);

		// 2. Prepare data for database insertion
		const errorMessage = err instanceof Error ? err.message : String(err);
		const stackTrace = err instanceof Error ? err.stack : null;

		const dbPayload = {
			tomori_id: context?.tomoriId ?? null,
			user_id: context?.userId ?? null,
			server_id: context?.serverId ?? null,
			error_type: context?.errorType ?? "GenericError",
			error_message: `${msg} - ${errorMessage}`, // Combine primary message with error details
			stack_trace: stackTrace,
			// Ensure metadata is stringified JSON for the DB insert
			error_metadata: context?.metadata
				? JSON.stringify(context.metadata)
				: null,
		};

		// 3. Attempt to insert into the database
		try {
			await sql`
                INSERT INTO error_logs (
                    tomori_id, user_id, server_id,
                    error_type, error_message, stack_trace, error_metadata
                ) VALUES (
                    ${dbPayload.tomori_id}, ${dbPayload.user_id}, ${dbPayload.server_id},
                    ${dbPayload.error_type}, ${dbPayload.error_message}, ${dbPayload.stack_trace},
                    ${dbPayload.error_metadata}::jsonb -- Explicit cast to JSONB
                )
            `;
			// Optional: Log DB insertion success (maybe too verbose)
			// console.log("\x1b[32m[DB LOG]\x1b[0m Error successfully logged to database.");
		} catch (dbError) {
			// Log DB insertion failure to console ONLY to avoid infinite loops
			console.error(
				"\x1b[31m[DB LOG ERROR]\x1b[0m Failed to log error to database:",
			);
			console.error(
				dbError instanceof Error
					? (dbError.stack ?? dbError.message)
					: String(dbError),
			);
			console.error("Original error payload:", dbPayload);
		}
	},
	section: (msg: string) => console.log(`\n\x1b[35m=== ${msg} ===\x1b[0m`),
};
