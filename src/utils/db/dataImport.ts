import { sql } from "bun";
import { log } from "../misc/logger";
import {
	EXPORT_VERSION,
	personalExportSchema,
	serverExportSchema,
	type PersonalExportData,
	type ServerExportData,
	type ImportResult,
} from "../../types/db/dataExport";
import { validateMemoryContent } from "./memoryLimits";
import { validateTomoriConfigFields } from "./sqlSecurity";

/**
 * Imports personal user data, replacing existing personal memories
 * @param userDiscId - Discord user ID to import data for
 * @param importData - The validated personal export data to import
 * @returns ImportResult indicating success or failure
 */
export async function importPersonalData(
	userDiscId: string,
	importData: PersonalExportData,
): Promise<ImportResult> {
	try {
		// 1. Validate memory content length for each memory
		for (const memory of importData.personal_memories) {
			const validation = validateMemoryContent(memory);
			if (!validation.isValid) {
				return {
					success: false,
					error: `Invalid memory content: ${validation.error}`,
				};
			}
		}

		// 2. Format personal_memories as PostgreSQL array literal
		const memoriesArrayLiteral = `{${importData.personal_memories
			.map((item: string) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;

		// 3. Update user data using UPSERT pattern
		const updateResult = await sql`
			INSERT INTO users (
				user_disc_id,
				user_nickname,
				language_pref,
				personal_memories
			) VALUES (
				${userDiscId},
				${importData.user_nickname},
				${importData.language_pref},
				${memoriesArrayLiteral}::text[]
			)
			ON CONFLICT (user_disc_id) DO UPDATE
			SET
				user_nickname = EXCLUDED.user_nickname,
				language_pref = EXCLUDED.language_pref,
				personal_memories = EXCLUDED.personal_memories
			RETURNING *
		`;

		if (!updateResult.length) {
			return {
				success: false,
				error: "Failed to update user data in database",
			};
		}

		return {
			success: true,
			itemsImported: {
				memoriesCount: importData.personal_memories.length,
			},
		};
	} catch (error) {
		log.error(`Error importing personal data for user ${userDiscId}:`, error);
		return {
			success: false,
			error: "Failed to import personal data",
		};
	}
}

/**
 * Imports server data, replacing configuration and server memories
 * @param serverDiscId - Discord server ID to import data for
 * @param importData - The validated server export data to import
 * @returns ImportResult indicating success or failure
 */
export async function importServerData(
	serverDiscId: string,
	importData: ServerExportData,
): Promise<ImportResult> {
	try {
		// 1. Get internal server ID and tomori ID
		const serverRows = await sql`
			SELECT s.server_id, t.tomori_id
			FROM servers s
			JOIN tomoris t ON s.server_id = t.server_id
			WHERE s.server_disc_id = ${serverDiscId}
			LIMIT 1
		`;

		if (!serverRows.length) {
			return {
				success: false,
				error: "Server not found in database. Please run /config setup first.",
			};
		}

		const serverId = serverRows[0].server_id;
		const tomoriId = serverRows[0].tomori_id;

		// 2. Validate all server memories
		for (const memory of importData.server_memories) {
			const validation = validateMemoryContent(memory);
			if (!validation.isValid) {
				return {
					success: false,
					error: `Invalid server memory content: ${validation.error}`,
				};
			}
		}

		// 3. Validate config field names for security
		const configFields = Object.keys(importData.config);
		try {
			validateTomoriConfigFields(configFields);
		} catch (error) {
			log.error("Config field validation failed during import:", error);
			return {
				success: false,
				error: "Invalid configuration fields in import data",
			};
		}

		// 4. Update tomori configuration
		await sql`
			UPDATE tomori_configs
			SET
				llm_temperature = ${importData.config.llm_temperature},
				humanizer_degree = ${importData.config.humanizer_degree},
				timezone_offset = ${importData.config.timezone_offset},
				server_memteaching_enabled = ${importData.config.server_memteaching_enabled},
				attribute_memteaching_enabled = ${importData.config.attribute_memteaching_enabled},
				sampledialogue_memteaching_enabled = ${importData.config.sampledialogue_memteaching_enabled},
				self_teaching_enabled = ${importData.config.self_teaching_enabled},
				web_search_enabled = ${importData.config.web_search_enabled},
				personal_memories_enabled = ${importData.config.personal_memories_enabled},
				emoji_usage_enabled = ${importData.config.emoji_usage_enabled},
				sticker_usage_enabled = ${importData.config.sticker_usage_enabled}
			WHERE tomori_id = ${tomoriId}
		`;

		// 5. Replace server memories
		await replaceServerMemories(serverId, importData.server_memories);

		return {
			success: true,
			itemsImported: {
				memoriesCount: importData.server_memories.length,
				configFieldsCount: configFields.length,
			},
		};
	} catch (error) {
		log.error(
			`Error importing server data for server ${serverDiscId}:`,
			error,
		);
		return {
			success: false,
			error: "Failed to import server data",
		};
	}
}

/**
 * Replaces all server memories for a given server
 * Deletes existing memories and inserts new ones
 * @param serverId - Internal server ID
 * @param memories - Array of memory content strings to insert
 */
async function replaceServerMemories(
	serverId: number,
	memories: string[],
): Promise<void> {
	// 1. Delete all existing server memories
	await sql`
		DELETE FROM server_memories
		WHERE server_id = ${serverId}
	`;

	// 2. Insert new server memories if any exist
	if (memories.length === 0) {
		return; // No memories to insert
	}

	// 3. Get a user ID to attribute the memories to (use the first user we find for this server)
	// This is required by the schema but not semantically important for imported data
	const userRows = await sql`
		SELECT u.user_id
		FROM users u
		LIMIT 1
	`;

	if (!userRows.length) {
		throw new Error(
			"No users found in database. Cannot attribute server memories.",
		);
	}

	const userId = userRows[0].user_id;

	// 4. Insert all new memories
	for (const content of memories) {
		await sql`
			INSERT INTO server_memories (server_id, user_id, content)
			VALUES (${serverId}, ${userId}, ${content})
		`;
	}

	log.info(
		`Replaced ${memories.length} server memories for server_id ${serverId}`,
	);
}

/**
 * Validates and parses an import file
 * @param jsonData - The parsed JSON data from the import file
 * @returns Validation result with parsed data or error message
 */
export function validateImportFile(jsonData: unknown): {
	valid: boolean;
	type?: "personal" | "server";
	data?: PersonalExportData | ServerExportData;
	error?: string;
} {
	// 1. Check if data is an object
	if (typeof jsonData !== "object" || jsonData === null) {
		return {
			valid: false,
			error: "Import file must contain a valid JSON object",
		};
	}

	// 2. Check version compatibility
	const version = (jsonData as { version?: string }).version;
	if (version !== EXPORT_VERSION) {
		return {
			valid: false,
			error: `Incompatible import version. Expected ${EXPORT_VERSION}, got ${version || "unknown"}`,
		};
	}

	// 3. Determine type and validate accordingly
	const type = (jsonData as { type?: string }).type;

	if (type === "personal") {
		const validated = personalExportSchema.safeParse(jsonData);
		if (!validated.success) {
			log.error("Personal import validation failed:", validated.error);
			return {
				valid: false,
				error: "Invalid personal import file format",
			};
		}
		return {
			valid: true,
			type: "personal",
			data: validated.data.data,
		};
	}

	if (type === "server") {
		const validated = serverExportSchema.safeParse(jsonData);
		if (!validated.success) {
			log.error("Server import validation failed:", validated.error);
			return {
				valid: false,
				error: "Invalid server import file format",
			};
		}
		return {
			valid: true,
			type: "server",
			data: validated.data.data,
		};
	}

	return {
		valid: false,
		error: `Unknown import type: ${type}. Must be "personal" or "server"`,
	};
}
