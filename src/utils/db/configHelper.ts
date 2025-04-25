import { sql } from "bun";
import {
	tomoriSchema,
	tomoriStateSchema,
	userSchema,
	serverEmojiSchema,
	type TomoriRow,
	type TomoriState,
	type UserRow,
	type ServerEmojiRow,
} from "../../types/db/schema"; // Import base schemas and types
import { log } from "../misc/logger";
import type { Guild } from "discord.js";
import type { SetupConfig, SetupResult } from "../../types/db/schema";
import { setupConfigSchema, setupResultSchema } from "../../types/db/schema";

/**
 * Loads the complete Tomori state (base row + config + server memories) for a given server.
 * Validates the combined state using Zod.
 * @param serverDiscId - The Discord ID of the server.
 * @returns The validated TomoriState object, or null if not found or invalid.
 */
export async function loadTomoriState(
	serverDiscId: string,
): Promise<TomoriState | null> {
	try {
		// 1. Load base Tomori data using server Discord ID
		const tomoriRows = await sql`
			SELECT t.* 
			FROM tomoris t
			JOIN servers s ON t.server_id = s.server_id
			WHERE s.server_disc_id = ${serverDiscId}
			LIMIT 1
		`;

		if (!tomoriRows.length) {
			log.warn(`No Tomori instance found for server ${serverDiscId}`);
			return null;
		}
		const tomoriData = tomoriRows[0];

		// 2. Load associated config using tomori_id
		// biome-ignore lint/style/noNonNullAssertion: Row existence checked above, ID is guaranteed by DB schema.
		const tomoriId = tomoriData.tomori_id!;
		const configRows = await sql`
			SELECT * FROM tomori_configs
			WHERE tomori_id = ${tomoriId}
			LIMIT 1
		`;

		if (!configRows.length) {
			log.error(
				`Found Tomori (${tomoriId}) but no config for server ${serverDiscId}`,
			);
			return null;
		}
		const configData = configRows[0];

		// 3. Load LLM data using the llm_id from the config
		const llmRows = await sql`
            SELECT * FROM llms
            WHERE llm_id = ${configData.llm_id}
            LIMIT 1
        `;

		if (!llmRows.length) {
			log.error(
				`Found Tomori config but no LLM data for server ${serverDiscId}, llm_id: ${configData.llm_id}`,
			);
			return null;
		}
		const llmData = llmRows[0];

		// 4. Load server memories for this server
		const serverMemoriesRows = await sql`
			SELECT content
			FROM server_memories
			WHERE server_id = ${tomoriData.server_id}
			ORDER BY created_at DESC
		`;

		// Extract memory content strings into an array
		const serverMemories = serverMemoriesRows.map(
			(row: { content: string }) => row.content,
		);

		// 5. Combine and validate the full state
		const combinedState = {
			...tomoriData,
			config: configData,
			llm: llmData, // Add the LLM data to match schema
			server_memories: serverMemories, // Add server memories to the state
		};

		// Use Zod to parse and validate the combined structure
		const parsedState = tomoriStateSchema.safeParse(combinedState);

		if (!parsedState.success) {
			log.error(
				`Failed to validate combined Tomori state for server ${serverDiscId}:`,
				parsedState.error.flatten(),
			);
			return null;
		}

		// Return the validated, combined state object
		return parsedState.data;
	} catch (error) {
		log.error(`Error loading tomori state for server ${serverDiscId}:`, error);
		return null;
	}
}

/**
 * Loads a user's state (UserRow) from the database.
 * @param userDiscId - Discord user ID.
 * @returns UserRow object or null if not found or invalid.
 */
export async function loadUserRow(userDiscId: string): Promise<UserRow | null> {
	try {
		const rows = await sql`
			SELECT * FROM users 
			WHERE user_disc_id = ${userDiscId}
			LIMIT 1
		`;

		if (!rows.length) {
			// It's common for users not to exist yet, so use info level
			log.info(`No user data found for ID ${userDiscId}.`);
			return null;
		}

		// Validate the row against the schema
		const parsedUser = userSchema.safeParse(rows[0]);
		if (!parsedUser.success) {
			log.error(
				`Failed to validate user data for ID ${userDiscId}:`,
				parsedUser.error.flatten(),
			);
			return null;
		}

		return parsedUser.data;
	} catch (error) {
		log.error(`Error loading user row for ID ${userDiscId}:`, error);
		return null;
	}
}

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
 * Checks if a user is blacklisted from personalization in a server.
 * @param serverDiscId - Discord server ID.
 * @param userDiscId - Discord user ID.
 * @returns true if user is blacklisted, false otherwise.
 */
export async function isBlacklisted(
	serverDiscId: string,
	userDiscId: string,
): Promise<boolean> {
	try {
		// Use EXISTS for efficiency (Rule 16)
		const result = await sql`
			SELECT EXISTS (
				SELECT 1
				FROM personalization_blacklist pb
				JOIN servers s ON pb.server_id = s.server_id
				JOIN users u ON pb.user_id = u.user_id
				WHERE s.server_disc_id = ${serverDiscId}
				AND u.user_disc_id = ${userDiscId}
			) as "exists";
		`;

		// Bun's sql returns [{ exists: 1 }] or [{ exists: 0 }]
		// biome-ignore lint/style/noNonNullAssertion: Query guarantees result[0] exists
		return result[0]!.exists === 1;
	} catch (error) {
		log.error(
			`Error checking blacklist for user ${userDiscId} in server ${serverDiscId}:`,
			error,
		);
		return false; // Default to false on error to avoid blocking personalization unintentionally
	}
}

/**
 * Loads all custom emojis for a given server.
 * @param internalServerId - The internal database ID of the server.
 * @returns An array of validated ServerEmojiRow objects, or null if none found or error.
 */
export async function loadServerEmojis(
	internalServerId: number,
): Promise<ServerEmojiRow[] | null> {
	try {
		const emojiRows = await sql`
			SELECT *
			FROM server_emojis
			WHERE server_id = ${internalServerId}
		`;

		if (!emojiRows || emojiRows.length === 0) {
			log.info(`No custom emojis found for server ID ${internalServerId}.`);
			return null;
		}

		// Validate the array of emojis
		const parsedEmojis = serverEmojiSchema.array().safeParse(emojiRows);

		if (!parsedEmojis.success) {
			log.error(
				`Failed to validate emojis for server ID ${internalServerId}:`,
				parsedEmojis.error.flatten(),
			);
			return null;
		}

		return parsedEmojis.data;
	} catch (error) {
		log.error(`Error loading emojis for server ID ${internalServerId}:`, error);
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
					humanizer_enabled
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
