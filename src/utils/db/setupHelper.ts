import { sql } from "bun";
import type { Guild } from "discord.js";
import { log } from "../misc/logger";
import type { SetupConfig, SetupResult } from "../../types/db/schema";
import { setupConfigSchema, setupResultSchema } from "../../types/db/schema";

/**
 * Sets up a new server with Tomori in a single atomic transaction.
 * Creates server record, Tomori instance, config, and registers all server emojis.
 *
 * @param guild - The Discord guild to setup
 * @param config - Configuration data for server setup
 * @returns All database rows created during setup
 * @throws If validation fails or any part of the setup transaction fails
 */
export async function setupServer(
	guild: Guild,
	config: SetupConfig,
): Promise<SetupResult> {
	// Validate input config - critical operation so we use Zod (Rule 3, Rule 5)
	const validConfig = setupConfigSchema.parse(config);

	log.section("Starting server setup transaction");

	try {
		// Start transaction for atomicity (Rule 15)
		const result = await sql.transaction(async (tx) => {
			// Use Gemini 2.5 Flash as default
			const [defaultLlm] = await tx`
				SELECT llm_id FROM llms 
				WHERE llm_codename = 'gemini-2.5-flash-preview-04-17'
				LIMIT 1
			`;

			/*
			// Get default LLM ID - for now we use the first available one
			const [defaultLlm] = await tx`
				SELECT llm_id FROM llms 
				ORDER BY llm_id 
				LIMIT 1
			`;
			*/

			const defaultTriggers = ["tomori", "tomo", "ともり", "トモリ"];

			// 1. Create or update server record with RETURNING (Rule 15)
			const [server] = await tx`
				INSERT INTO servers (server_disc_id)
				VALUES (${validConfig.serverId})
				ON CONFLICT (server_disc_id) DO UPDATE
				SET server_disc_id = EXCLUDED.server_disc_id
				RETURNING *
			`;

			// 2. Create Tomori instance with preset
			const [tomori] = await tx`
				INSERT INTO tomoris (
					server_id,
					tomori_nickname,
					attribute_list,
					sample_dialogues_in,
					sample_dialogues_out
				)
				VALUES (
					${server.server_id},
					${validConfig.tomoriName},
					(SELECT preset_attribute_list FROM tomori_presets WHERE tomori_preset_id = ${validConfig.presetId}),
					(SELECT preset_sample_dialogues_in FROM tomori_presets WHERE tomori_preset_id = ${validConfig.presetId}),
					(SELECT preset_sample_dialogues_out FROM tomori_presets WHERE tomori_preset_id = ${validConfig.presetId})
				)
				RETURNING *
			`;

			// 3. Create Tomori config with LLM settings
			// Use the most explicit PostgreSQL syntax for array handling
			const autochArrayLiteral =
				validConfig.autochChannels.length > 0
					? `{${validConfig.autochChannels.map((c) => c.replace(/(["\\])/g, "\\$1")).join(",")}}`
					: "{}";

			// Format trigger words as PostgreSQL array
			const triggerWordsArrayLiteral = `{${defaultTriggers.map((t) => `"${t.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;

			const [config] = await tx`
				INSERT INTO tomori_configs (
					tomori_id,
					llm_id,
					api_key,
					trigger_words,
					autoch_disc_ids,
					autoch_threshold,
					humanizer_enabled
				)
				VALUES (
					${tomori.tomori_id},
					${defaultLlm.llm_id},
					${validConfig.encryptedApiKey},
					${triggerWordsArrayLiteral}::text[],
					${autochArrayLiteral}::text[],
					${validConfig.autochThreshold},
					${validConfig.humanizer}
				)
				RETURNING *
			`;

			// 4. Register guild emojis in bulk insert (Rule 16)
			const emojiValues = Array.from(guild.emojis.cache.values()).map((e) => ({
				emoji_disc_id: e.id,
				emoji_name: e.name ?? "",
				emotion_key: "unset", // Add the emotion_key field
				is_animated: e.animated || false, // Track if emoji is animated
			}));

			const emojis = [];
			for (const {
				emoji_disc_id,
				emoji_name,
				emotion_key,
				is_animated,
			} of emojiValues) {
				const [row] = await tx`
			INSERT INTO server_emojis (
				server_id,
				emoji_disc_id,
				emoji_name,
				emotion_key,
				is_animated
			)
				VALUES (
				${server.server_id},
				${emoji_disc_id},
				${emoji_name},
				${emotion_key},
				${is_animated}
				)
				RETURNING *
			`;
				emojis.push(row);
			}

			// Return all created records
			return {
				server,
				tomori,
				config,
				emojis,
			};
		});

		// Validate output structure but don't overwrite the result
		setupResultSchema.parse(result);

		log.success(
			`Server setup completed successfully for Server ID (${validConfig.serverId})`,
		);
		log.info(`Registered ${result.emojis.length} emojis`);

		return result;
	} catch (error) {
		log.error("Server setup transaction failed:", error);
		throw error; // Re-throw to let caller handle the error
	}
}
