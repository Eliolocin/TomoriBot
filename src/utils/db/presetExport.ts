/**
 * Preset Export Utilities
 * Handles exporting TomoriBot personality data from the database
 */

import { sql } from "bun";
import { log } from "../misc/logger";
import {
	PRESET_EXPORT_VERSION,
	presetExportSchema,
	type PresetExport,
	type ExportResult,
} from "../../types/preset/presetExport";

/**
 * Exports TomoriBot preset personality data for a given server
 * Queries data from both tomoris and tomori_configs tables
 * @param serverDiscId - Discord server ID to export preset for
 * @returns ExportResult containing the exported preset data or error
 */
export async function exportPresetData(
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
				error: "commands.preset.export.error_no_server_data",
			};
		}

		const serverId = serverRows[0].server_id;

		// 2. Query personality data from tomoris and tomori_configs tables
		const presetRows = await sql`
			SELECT
				t.tomori_nickname,
				t.attribute_list,
				t.sample_dialogues_in,
				t.sample_dialogues_out,
				tc.trigger_words
			FROM tomoris t
			JOIN tomori_configs tc ON t.tomori_id = tc.tomori_id
			WHERE t.server_id = ${serverId}
			LIMIT 1
		`;

		if (!presetRows.length) {
			return {
				success: false,
				error: "commands.preset.export.error_no_preset_data",
			};
		}

		const presetData = presetRows[0];

		// 3. Build export object with metadata
		const exportData: PresetExport = {
			version: PRESET_EXPORT_VERSION,
			type: "preset",
			exported_at: new Date().toISOString(),
			data: {
				tomori_nickname: presetData.tomori_nickname,
				attribute_list: presetData.attribute_list || [],
				sample_dialogues_in: presetData.sample_dialogues_in || [],
				sample_dialogues_out: presetData.sample_dialogues_out || [],
				trigger_words: presetData.trigger_words || [],
			},
		};

		// 4. Validate export data structure
		const validated = presetExportSchema.safeParse(exportData);
		if (!validated.success) {
			log.error(
				`Preset export validation failed for server ${serverDiscId}:`,
				validated.error,
			);
			return {
				success: false,
				error: "commands.preset.export.error_validation_failed",
			};
		}

		log.success(
			`Successfully exported preset for server ${serverDiscId}: ${presetData.tomori_nickname}`,
		);

		return {
			success: true,
			data: validated.data,
		};
	} catch (error) {
		log.error(
			`Error exporting preset data for server ${serverDiscId}:`,
			error,
		);
		return {
			success: false,
			error: "commands.preset.export.error_export_failed",
		};
	}
}
