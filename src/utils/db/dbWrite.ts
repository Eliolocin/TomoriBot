import { sql } from "bun";
import {
	tomoriSchema,
	userSchema,
	type TomoriRow,
	type UserRow,
} from "../../types/db/schema"; // Import base schemas and types
import { log } from "../misc/logger";
import type { Guild } from "discord.js";
import type { SetupConfig, SetupResult } from "../../types/db/schema";
import { setupConfigSchema, setupResultSchema } from "../../types/db/schema";

/**
 * Registers or updates a user in the database, ensuring they have a record for presence tracking and personalization.
 * Uses an UPSERT pattern following Rule #15.
 *
 * @param userDiscId - Discord user ID of the user to register
 * @param displayName - User's display name or nickname
 * @param language - Preferred language code, defaults to 'en'
 * @returns The validated UserRow object, or null if registration failed
 */
export async function registerUser(
	userDiscId: string,
	displayName: string,
	language = "en",
): Promise<UserRow | null> {
	try {
		log.info(`Registering/updating user ${userDiscId} (${displayName})`);

		// Apply UPSERT pattern with RETURNING (Rule #15)
		const [userData] = await sql`
            INSERT INTO users (
                user_disc_id,
                user_nickname,
                language_pref
            ) VALUES (
                ${userDiscId},
                ${displayName},
                ${language}
            )
            ON CONFLICT (user_disc_id) DO UPDATE
            SET user_nickname = EXCLUDED.user_nickname
            RETURNING *
        `;

		// Validate with Zod schema (Rules #3, #6)
		const validatedUser = userSchema.safeParse(userData);

		if (!validatedUser.success) {
			log.error(
				`Failed to validate registered user data for ${userDiscId}:`,
				validatedUser.error,
			);
			return null;
		}

		return validatedUser.data;
	} catch (error) {
		log.error(`Error registering user ${userDiscId}:`, error);
		return null;
	}
}

/**
 * Increments the autoch_counter for a Tomori instance.
 * If the counter reaches the threshold, it resets to 0.
 * @param tomoriId - The ID of the Tomori instance.
 * @param threshold - The autoch_threshold value from config.
 * @returns The updated TomoriRow with the new counter value, or null on error.
 */
export async function incrementTomoriCounter(
	tomoriId: number,
	threshold: number,
): Promise<TomoriRow | null> {
	try {
		// Atomically increment and check threshold using RETURNING
		const updatedRows = await sql`
            WITH updated AS (
                UPDATE tomori
                SET autoch_counter = autoch_counter + 1
                WHERE tomori_id = ${tomoriId}
                RETURNING tomori_id, autoch_counter
            )
            UPDATE tomori
            SET autoch_counter = 0
            FROM updated
            WHERE 
                tomori.tomori_id = updated.tomori_id 
                AND ${threshold > 0} -- Only reset if threshold is active
                AND updated.autoch_counter % ${threshold} = 0
            RETURNING tomori.*; -- Return the final state of the row
        `;

		// If the threshold wasn't met, the second UPDATE won't run,
		// so we need to fetch the result from the first increment.
		if (!updatedRows.length) {
			const incrementedRows = await sql`
                SELECT * FROM tomori WHERE tomori_id = ${tomoriId} LIMIT 1
            `;
			if (!incrementedRows.length) {
				log.error(
					`Failed to retrieve Tomori row ${tomoriId} after incrementing counter.`,
				);
				return null;
			}
			// Validate and return
			const parsedTomori = tomoriSchema.safeParse(incrementedRows[0]);
			return parsedTomori.success ? parsedTomori.data : null;
		}

		// If threshold was met and reset occurred, validate and return
		const parsedTomori = tomoriSchema.safeParse(updatedRows[0]);
		if (!parsedTomori.success) {
			log.error(
				`Failed to validate updated Tomori row ${tomoriId} after counter reset:`,
				parsedTomori.error.flatten(),
			);
			return null;
		}
		return parsedTomori.data;
	} catch (error) {
		log.error(
			`Error incrementing/resetting auto counter for ${tomoriId}:`,
			error,
		);
		return null;
	}
}

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

			// Format trigger words as PostgreSQL array
			const triggerWordsArrayLiteral = `{${defaultTriggers.map((t) => `"${t.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;

			const [config] = await tx`
				INSERT INTO tomori_configs (
					tomori_id,
					llm_id,
					api_key,
					trigger_words,
					humanizer_degree
				)
				VALUES (
					${tomori.tomori_id},
					${defaultLlm.llm_id},
					${validConfig.encryptedApiKey},
					${triggerWordsArrayLiteral}::text[],
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
