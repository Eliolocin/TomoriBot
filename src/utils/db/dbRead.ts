import { sql } from "bun";
import {
	tomoriStateSchema,
	userSchema,
	serverEmojiSchema,
	type TomoriState,
	type UserRow,
	type ServerEmojiRow,
	type LlmRow,
	llmSchema,
	type ServerStickerRow,
	serverStickerSchema,
} from "../../types/db/schema"; // Import base schemas and types
import { log } from "../misc/logger";

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

		// Bun's sql returns [{ exists: true }] or [{ exists: false }]
		// biome-ignore lint/style/noNonNullAssertion: Query guarantees result[0] exists
		return result[0]!.exists;
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
 * Loads all available LLM models from the database.
 * @returns An array of validated LlmRow objects, or null if none found or error.
 */
export async function loadAvailableLlms(): Promise<LlmRow[] | null> {
	try {
		// 1. Fetch all rows from the llms table
		const llmRows = await sql`
            SELECT * FROM llms
            ORDER BY llm_id ASC -- Optional: Order for consistency
        `;

		// 2. Check if any rows were returned
		if (!llmRows || llmRows.length === 0) {
			log.warn("No LLM models found in the database.");
			return null;
		}

		// 3. Validate the array of LLM rows against the schema (Rule 5, Rule 6)
		const parsedLlms = llmSchema.array().safeParse(llmRows);

		// 4. Handle validation failure
		if (!parsedLlms.success) {
			log.error(
				"Failed to validate LLM data from database:",
				parsedLlms.error.flatten(),
			);
			return null;
		}

		// 5. Return the validated array of LLM rows
		return parsedLlms.data;
	} catch (error) {
		// 6. Log any unexpected errors during the database query (Rule 22)
		log.error("Error loading available LLMs from database:", error);
		return null;
	}
}

/**
 * Loads the smartest (reasoning) model for a specific LLM provider from the database.
 * @param providerName - The name of the LLM provider (e.g., 'google', 'openai').
 * @returns A promise that resolves to the first smartest LlmRow found, or null if none found.
 */
export async function loadSmartestModel(
	providerName: string,
): Promise<LlmRow | null> {
	try {
		// 1. Query for smartest model for the specific provider
		const smartModelRows = await sql`
            SELECT * FROM llms
            WHERE llm_provider = ${providerName} AND is_smartest = true
            ORDER BY llm_id ASC
            LIMIT 1
        `;

		// 2. Check if any row was returned
		if (!smartModelRows || smartModelRows.length === 0) {
			log.warn(`No smartest model found for provider: ${providerName}`);
			return null;
		}

		// 3. Validate the single LLM row against the schema
		const parsedModel = llmSchema.safeParse(smartModelRows[0]);

		// 4. Handle validation failure
		if (!parsedModel.success) {
			log.error(
				`Failed to validate smartest model data for provider ${providerName}:`,
				parsedModel.error.flatten(),
			);
			return null;
		}

		// 5. Return the validated LLM row
		log.info(`Found smartest model for ${providerName}: ${parsedModel.data.llm_codename}`);
		return parsedModel.data;
	} catch (error) {
		// 6. Log any unexpected errors during the database query
		log.error(`Error loading smartest model for provider ${providerName}:`, error);
		return null;
	}
}

/**
 * Loads all stickers for a given server's Discord ID from the database.
 * @param serverDiscId - The Discord ID of the server.
 * @returns A promise that resolves to an array of ServerStickerRow or null if server not found/error.
 *          Returns an empty array if the server is found but has no stickers.
 */
export async function loadServerStickers(
	serverDiscId: string,
): Promise<ServerStickerRow[] | null> {
	try {
		// 1. Get the internal server_id from server_disc_id
		const [server] = await sql`
            SELECT server_id FROM servers WHERE server_disc_id = ${serverDiscId} LIMIT 1
        `;

		if (!server || !server.server_id) {
			log.warn(
				`Server not found in DB with Discord ID: ${serverDiscId} when trying to load stickers.`,
			);
			return null; // Server itself not found
		}
		// biome-ignore lint/style/noNonNullAssertion: server check guarantees server_id (Rule 8)
		const serverId = server.server_id!;

		// 2. Fetch all stickers for that server_id, selecting only necessary fields
		const stickersData = await sql`
            SELECT sticker_id, server_id, sticker_disc_id, sticker_name, sticker_desc, emotion_key, format_type, is_global, created_at, updated_at
            FROM server_stickers
            WHERE server_id = ${serverId}
        `; // Rule 16: Explicit columns

		if (!stickersData) {
			// This case should ideally not happen with current bun-postgres; an empty array is more likely.
			log.warn(
				`Stickers data was unexpectedly null for server ID: ${serverId} (Discord ID: ${serverDiscId})`,
			);
			return []; // Treat as no stickers found
		}
		if (stickersData.length === 0) {
			log.info(
				`No stickers found in DB for server ID: ${serverId} (Discord ID: ${serverDiscId})`,
			);
			return []; // Explicitly return empty array if no stickers
		}

		// 3. Validate each sticker row (Rule 6, Rule 5 - data integrity for function calling)
		const validatedStickers: ServerStickerRow[] = [];
		for (const sticker of stickersData) {
			const parsed = serverStickerSchema.safeParse(sticker);
			if (parsed.success) {
				validatedStickers.push(parsed.data);
			} else {
				log.warn(
					`Invalid sticker data found in DB for server ${serverId}, sticker_disc_id ${sticker.sticker_disc_id}: ${JSON.stringify(sticker)}. Errors: ${parsed.error.flatten()}`,
				);
				// Optionally skip adding invalid stickers
			}
		}
		log.info(
			`Loaded ${validatedStickers.length} stickers for server ID ${serverId}.`,
		);
		return validatedStickers;
	} catch (error) {
		log.error(
			`Error loading stickers for server Discord ID ${serverDiscId}:`,
			error,
		);
		return null; // Error during DB operation
	}
}
