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
 * Logging utility for formatted info, success, error, warning, and section messages.
 */
export const log = {
	info: (msg: string) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
	success: (msg: string) => console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`),
	warn: (msg: string, err?: unknown) => {
		console.log(`\x1b[33m[WARNING]\x1b[0m ${msg}`);
		if (err) {
			console.log(
				err instanceof Error ? (err.stack ?? err.message) : String(err),
			);
		}
	},
	error: (msg: string, err?: unknown) => {
		console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
		if (err) {
			console.error(
				err instanceof Error ? (err.stack ?? err.message) : String(err),
			);
		}
	},
	section: (msg: string) => console.log(`\n\x1b[35m=== ${msg} ===\x1b[0m`),
};
