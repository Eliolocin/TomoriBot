/**
 * Preset Import Utilities
 * Handles importing and validating TomoriBot personality data
 */

import { sql } from "bun";
import { log } from "../misc/logger";
import {
	PRESET_EXPORT_VERSION,
	presetExportSchema,
	type PresetExportData,
	type ImportResult,
	type ValidationResult,
} from "../../types/preset/presetExport";
import {
	validateMemoryContent,
	validateAttributeAndDialogue,
} from "./memoryLimits";
import { validateTomoriConfigFields } from "./sqlSecurity";

/**
 * Imports TomoriBot preset personality data, replacing existing personality
 * @param serverDiscId - Discord server ID to import preset for
 * @param importData - The validated preset export data to import
 * @returns ImportResult indicating success or failure with item counts
 */
export async function importPresetData(
	serverDiscId: string,
	importData: PresetExportData,
): Promise<ImportResult> {
	try {
		// 1. Validate all array content for security
		// Use appropriate validation for each content type:
		// - Attributes: Use sample dialogue validation (2000 char limit) for long personality descriptions
		// - Sample dialogues: Use sample dialogue validation (2000 char limit)
		// - Trigger words: Use regular memory validation (256 char limit)

		// Check attribute_list (use 2000 char limit for detailed personality descriptions)
		for (const attribute of importData.attribute_list) {
			const validation = validateAttributeAndDialogue(attribute);
			if (!validation.isValid) {
				return {
					success: false,
					error: `commands.preset.import.error_invalid_attribute|${validation.error}`,
				};
			}
		}

		// Check sample_dialogues_in (uses higher limit for sample dialogues)
		for (const dialogue of importData.sample_dialogues_in) {
			const validation = validateAttributeAndDialogue(dialogue);
			if (!validation.isValid) {
				return {
					success: false,
					error: `commands.preset.import.error_invalid_dialogue_in|${validation.error}`,
				};
			}
		}

		// Check sample_dialogues_out (uses higher limit for sample dialogues)
		for (const dialogue of importData.sample_dialogues_out) {
			const validation = validateAttributeAndDialogue(dialogue);
			if (!validation.isValid) {
				return {
					success: false,
					error: `commands.preset.import.error_invalid_dialogue_out|${validation.error}`,
				};
			}
		}

		// Check trigger_words
		for (const triggerWord of importData.trigger_words) {
			const validation = validateMemoryContent(triggerWord);
			if (!validation.isValid) {
				return {
					success: false,
					error: `commands.preset.import.error_invalid_trigger_word|${validation.error}`,
				};
			}
		}

		// 2. Validate sample dialogues arrays match in length
		if (
			importData.sample_dialogues_in.length !==
			importData.sample_dialogues_out.length
		) {
			return {
				success: false,
				error: "commands.preset.import.error_dialogue_mismatch",
			};
		}

		// 3. Validate trigger_words field for SQL security
		try {
			validateTomoriConfigFields(["trigger_words"]);
		} catch (error) {
			log.error("Config field validation failed during preset import:", error);
			return {
				success: false,
				error: "commands.preset.import.error_invalid_config",
			};
		}

		// 4. Get internal server ID and tomori ID
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
				error: "commands.preset.import.error_no_server_data",
			};
		}

		const serverId = serverRows[0].server_id;
		const tomoriId = serverRows[0].tomori_id;

		// 5. Format arrays as PostgreSQL array literals for safe insertion
		const attributeArrayLiteral = `{${importData.attribute_list
			.map((item: string) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;

		const dialoguesInArrayLiteral = `{${importData.sample_dialogues_in
			.map((item: string) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;

		const dialoguesOutArrayLiteral = `{${importData.sample_dialogues_out
			.map((item: string) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;

		const triggerWordsArrayLiteral = `{${importData.trigger_words
			.map((item: string) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;

		// 6. Update tomoris table with personality data
		await sql`
			UPDATE tomoris
			SET
				tomori_nickname = ${importData.tomori_nickname},
				attribute_list = ${attributeArrayLiteral}::text[],
				sample_dialogues_in = ${dialoguesInArrayLiteral}::text[],
				sample_dialogues_out = ${dialoguesOutArrayLiteral}::text[]
			WHERE server_id = ${serverId}
		`;

		// 7. Update tomori_configs table with trigger words
		await sql`
			UPDATE tomori_configs
			SET
				trigger_words = ${triggerWordsArrayLiteral}::text[]
			WHERE tomori_id = ${tomoriId}
		`;

		log.success(
			`Successfully imported preset for server ${serverDiscId}: ${importData.tomori_nickname}`,
		);

		return {
			success: true,
			itemsImported: {
				nickname: importData.tomori_nickname,
				attributeCount: importData.attribute_list.length,
				dialogueCount: importData.sample_dialogues_in.length,
				triggerWordCount: importData.trigger_words.length,
			},
		};
	} catch (error) {
		log.error(
			`Error importing preset data for server ${serverDiscId}:`,
			error,
		);
		return {
			success: false,
			error: "commands.preset.import.error_import_failed",
		};
	}
}

/**
 * Validates and parses a preset import file
 * @param jsonData - The parsed JSON data from the PNG metadata
 * @returns Validation result with parsed data or error message
 */
export function validatePresetFile(jsonData: unknown): ValidationResult {
	// 1. Check if data is an object
	if (typeof jsonData !== "object" || jsonData === null) {
		return {
			valid: false,
			error: "commands.preset.import.error_not_json",
		};
	}

	// 2. Check version compatibility
	const version = (jsonData as { version?: string }).version;
	if (version !== PRESET_EXPORT_VERSION) {
		return {
			valid: false,
			error: `commands.preset.import.error_incompatible_version|${PRESET_EXPORT_VERSION}|${version || "unknown"}`,
		};
	}

	// 3. Check type field
	const type = (jsonData as { type?: string }).type;
	if (type !== "preset") {
		return {
			valid: false,
			error: `commands.preset.import.error_invalid_type|${type}`,
		};
	}

	// 4. Validate with Zod schema
	const validated = presetExportSchema.safeParse(jsonData);
	if (!validated.success) {
		log.error("Preset import validation failed:", validated.error);
		return {
			valid: false,
			error: "commands.preset.import.error_invalid_format",
		};
	}

	return {
		valid: true,
		data: validated.data.data,
	};
}
