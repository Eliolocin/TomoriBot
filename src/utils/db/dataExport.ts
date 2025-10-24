import { sql } from "bun";
import { log } from "../misc/logger";
import {
	EXPORT_VERSION,
	personalExportSchema,
	serverExportSchema,
	type PersonalExport,
	type ServerExport,
	type ExportResult,
} from "../../types/db/dataExport";

/**
 * Exports personal user data (nickname, language preference, memories)
 * @param userDiscId - Discord user ID to export data for
 * @returns ExportResult containing the exported data or error
 */
export async function exportPersonalData(
	userDiscId: string,
): Promise<ExportResult> {
	try {
		// 1. Query user data from database
		const rows = await sql`
			SELECT user_nickname, language_pref, personal_memories
			FROM users
			WHERE user_disc_id = ${userDiscId}
			LIMIT 1
		`;

		if (!rows.length) {
			return {
				success: false,
				error: "commands.data.export.error_no_user_data",
			};
		}

		const userData = rows[0];

		// 2. Build export object
		const exportData: PersonalExport = {
			version: EXPORT_VERSION,
			type: "personal",
			exported_at: new Date().toISOString(),
			data: {
				user_nickname: userData.user_nickname,
				language_pref: userData.language_pref,
				personal_memories: userData.personal_memories || [],
			},
		};

		// 3. Validate export data structure
		const validated = personalExportSchema.safeParse(exportData);
		if (!validated.success) {
			log.error(
				`Personal export validation failed for user ${userDiscId}:`,
				validated.error,
			);
			return {
				success: false,
				error: "commands.data.export.error_validation_failed",
			};
		}

		return {
			success: true,
			data: validated.data,
		};
	} catch (error) {
		log.error(`Error exporting personal data for user ${userDiscId}:`, error);
		return {
			success: false,
			error: "commands.data.export.error_export_failed",
		};
	}
}

/**
 * Exports server data (configuration and server memories)
 * @param serverDiscId - Discord server ID to export data for
 * @returns ExportResult containing the exported data or error
 */
export async function exportServerData(
	serverDiscId: string,
): Promise<ExportResult> {
	try {
		// 1. Get internal server ID
		const serverRows = await sql`
			SELECT server_id
			FROM servers
			WHERE server_disc_id = ${serverDiscId}
			LIMIT 1
		`;

		if (!serverRows.length) {
			return {
				success: false,
				error: "commands.data.export.error_no_server_data",
			};
		}

		const serverId = serverRows[0].server_id;

		// 2. Get tomori configuration
		const configRows = await sql`
			SELECT
				tc.llm_temperature,
				tc.humanizer_degree,
				tc.timezone_offset,
				tc.server_memteaching_enabled,
				tc.attribute_memteaching_enabled,
				tc.sampledialogue_memteaching_enabled,
				tc.self_teaching_enabled,
				tc.web_search_enabled,
				tc.personal_memories_enabled,
				tc.emoji_usage_enabled,
				tc.sticker_usage_enabled
			FROM tomori_configs tc
			JOIN tomoris t ON tc.tomori_id = t.tomori_id
			WHERE t.server_id = ${serverId}
			LIMIT 1
		`;

		if (!configRows.length) {
			return {
				success: false,
				error: "commands.data.export.error_no_server_config",
			};
		}

		const configData = configRows[0];

		// 3. Get server memories
		const memoryRows = await sql`
			SELECT content
			FROM server_memories
			WHERE server_id = ${serverId}
			ORDER BY created_at DESC
		`;

		const serverMemories = memoryRows.map((row: { content: string }) => row.content);

		// 4. Build export object
		const exportData: ServerExport = {
			version: EXPORT_VERSION,
			type: "server",
			exported_at: new Date().toISOString(),
			data: {
				config: {
					llm_temperature: configData.llm_temperature,
					humanizer_degree: configData.humanizer_degree,
					timezone_offset: configData.timezone_offset,
					server_memteaching_enabled: configData.server_memteaching_enabled,
					attribute_memteaching_enabled: configData.attribute_memteaching_enabled,
					sampledialogue_memteaching_enabled:
						configData.sampledialogue_memteaching_enabled,
					self_teaching_enabled: configData.self_teaching_enabled,
					web_search_enabled: configData.web_search_enabled,
					personal_memories_enabled: configData.personal_memories_enabled,
					emoji_usage_enabled: configData.emoji_usage_enabled,
					sticker_usage_enabled: configData.sticker_usage_enabled,
				},
				server_memories: serverMemories,
			},
		};

		// 5. Validate export data structure
		const validated = serverExportSchema.safeParse(exportData);
		if (!validated.success) {
			log.error(
				`Server export validation failed for server ${serverDiscId}:`,
				validated.error,
			);
			return {
				success: false,
				error: "commands.data.export.error_validation_failed",
			};
		}

		return {
			success: true,
			data: validated.data,
		};
	} catch (error) {
		log.error(`Error exporting server data for server ${serverDiscId}:`, error);
		return {
			success: false,
			error: "commands.data.export.error_export_failed",
		};
	}
}
