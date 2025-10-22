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
	reminderSchema,
	type ReminderRow,
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
 * @param includeDeprecated - Whether to include deprecated models in the results (default: false).
 * @returns An array of validated LlmRow objects, or null if none found or error.
 */
export async function loadAvailableLlms(
	includeDeprecated = false,
): Promise<LlmRow[] | null> {
	try {
		// 1. Fetch rows from the llms table, filtering deprecated models unless explicitly included
		const llmRows = includeDeprecated
			? await sql`
				SELECT * FROM llms
				ORDER BY llm_id ASC
			`
			: await sql`
				SELECT * FROM llms
				WHERE is_deprecated = false
				ORDER BY llm_id ASC
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
 * Loads available models for a specific LLM provider with deprecation filtering.
 * @param providerName - The name of the LLM provider (e.g., 'google', 'openai').
 * @param includeDeprecated - Whether to include deprecated models (default: false).
 * @returns An array of validated LlmRow objects for the provider, or null if none found.
 */
export async function loadAvailableModelsForProvider(
	providerName: string,
	includeDeprecated = false,
): Promise<LlmRow[] | null> {
	// Input validation
	if (!providerName || providerName.trim().length === 0) {
		log.error("Provider name cannot be empty");
		return null;
	}

	// Validate provider name format (alphanumeric, hyphens, and underscores only)
	if (!/^[a-zA-Z0-9-_]+$/.test(providerName.trim())) {
		log.error(`Invalid provider name format: ${providerName}`);
		return null;
	}

	const normalizedProviderName = providerName.trim();

	try {
		// 1. Query for models for the specific provider, filtering deprecated unless explicitly included
		const modelRows = includeDeprecated
			? await sql`
				SELECT * FROM llms
				WHERE llm_provider = ${normalizedProviderName}
				ORDER BY llm_id ASC
			`
			: await sql`
				SELECT * FROM llms
				WHERE llm_provider = ${normalizedProviderName} AND is_deprecated = false
				ORDER BY llm_id ASC
			`;

		// 2. Check if any rows were returned
		if (!modelRows || modelRows.length === 0) {
			log.warn(
				`No available models found for provider: ${normalizedProviderName}`,
			);
			return null;
		}

		// 3. Validate the array of LLM rows against the schema
		const parsedModels = llmSchema.array().safeParse(modelRows);

		// 4. Handle validation failure
		if (!parsedModels.success) {
			log.error(
				`Failed to validate model data for provider ${normalizedProviderName}:`,
				parsedModels.error.flatten(),
			);
			return null;
		}

		// 5. Return the validated array of LLM rows
		log.info(
			`Found ${parsedModels.data.length} available models for ${normalizedProviderName}`,
		);
		return parsedModels.data;
	} catch (error) {
		// 6. Log any unexpected errors during the database query
		log.error(
			`Error loading available models for provider ${normalizedProviderName}:`,
			error,
		);
		return null;
	}
}

/**
 * Loads the default model for a specific LLM provider, with fallback logic.
 * 1. Tries to find the model marked as is_default=true
 * 2. Falls back to the first available model for the provider
 * 3. Always excludes deprecated models unless explicitly included
 * @param providerName - The name of the LLM provider (e.g., 'google', 'openai').
 * @param includeDeprecated - Whether to include deprecated models in fallback search (default: false).
 * @returns The default or first available LlmRow for the provider, or null if none found.
 */
export async function loadDefaultModelForProvider(
	providerName: string,
	includeDeprecated = false,
): Promise<LlmRow | null> {
	// Input validation
	if (!providerName || providerName.trim().length === 0) {
		log.error("Provider name cannot be empty");
		return null;
	}

	// Validate provider name format (alphanumeric, hyphens, and underscores only)
	if (!/^[a-zA-Z0-9-_]+$/.test(providerName.trim())) {
		log.error(`Invalid provider name format: ${providerName}`);
		return null;
	}

	const normalizedProviderName = providerName.trim();

	try {
		// 1. Single optimized query: prioritize default models, then fallback to any available model
		// Uses CASE to create a priority column: default models get priority 1, others get priority 2
		const modelQuery = includeDeprecated
			? sql`
				SELECT *, 
					CASE WHEN is_default = true THEN 1 ELSE 2 END as priority
				FROM llms
				WHERE llm_provider = ${normalizedProviderName}
				ORDER BY priority ASC, llm_id ASC
				LIMIT 1
			`
			: sql`
				SELECT *, 
					CASE WHEN is_default = true THEN 1 ELSE 2 END as priority
				FROM llms
				WHERE llm_provider = ${normalizedProviderName} AND is_deprecated = false
				ORDER BY priority ASC, llm_id ASC
				LIMIT 1
			`;

		const modelRows = await modelQuery;

		// 2. Check if any model was found
		if (!modelRows || modelRows.length === 0) {
			log.error(
				`No available models found for provider: ${normalizedProviderName}`,
			);
			return null;
		}

		// 3. Validate the selected model
		const selectedModel = modelRows[0];
		const parsedModel = llmSchema.safeParse(selectedModel);

		if (!parsedModel.success) {
			log.error(
				`Failed to validate model data for provider ${normalizedProviderName}:`,
				parsedModel.error.flatten(),
			);
			return null;
		}

		// 4. Log appropriate message based on whether we got the default or a fallback
		const isDefaultModel = selectedModel.is_default === true;
		if (isDefaultModel) {
			log.info(
				`Found default model for ${normalizedProviderName}: ${parsedModel.data.llm_codename}`,
			);
		} else {
			log.warn(
				`No default model found for provider ${normalizedProviderName}, using fallback: ${parsedModel.data.llm_codename}`,
			);
		}

		return parsedModel.data;
	} catch (error) {
		// 5. Log any unexpected errors during the database query
		log.error(
			`Error loading default model for provider ${normalizedProviderName}:`,
			error,
		);
		return null;
	}
}

/**
 * Loads the smartest (reasoning) model for a specific LLM provider from the database.
 * @param providerName - The name of the LLM provider (e.g., 'google', 'openai').
 * @param includeDeprecated - Whether to include deprecated models (default: false).
 * @returns A promise that resolves to the first smartest LlmRow found, or null if none found.
 */
export async function loadSmartestModel(
	providerName: string,
	includeDeprecated = false,
): Promise<LlmRow | null> {
	// Input validation
	if (!providerName || providerName.trim().length === 0) {
		log.error("Provider name cannot be empty");
		return null;
	}

	// Validate provider name format (alphanumeric, hyphens, and underscores only)
	if (!/^[a-zA-Z0-9-_]+$/.test(providerName.trim())) {
		log.error(`Invalid provider name format: ${providerName}`);
		return null;
	}

	const normalizedProviderName = providerName.trim();

	try {
		// 1. Query for smartest model for the specific provider, filtering deprecated unless explicitly included
		const smartModelQuery = includeDeprecated
			? sql`
				SELECT * FROM llms
				WHERE llm_provider = ${normalizedProviderName} AND is_smartest = true
				ORDER BY llm_id ASC
				LIMIT 1
			`
			: sql`
				SELECT * FROM llms
				WHERE llm_provider = ${normalizedProviderName} AND is_smartest = true AND is_deprecated = false
				ORDER BY llm_id ASC
				LIMIT 1
			`;

		const smartModelRows = await smartModelQuery;

		// 2. Check if any row was returned
		if (!smartModelRows || smartModelRows.length === 0) {
			log.warn(
				`No smartest model found for provider: ${normalizedProviderName}`,
			);
			return null;
		}

		// 3. Validate the single LLM row against the schema
		const parsedModel = llmSchema.safeParse(smartModelRows[0]);

		// 4. Handle validation failure
		if (!parsedModel.success) {
			log.error(
				`Failed to validate smartest model data for provider ${normalizedProviderName}:`,
				parsedModel.error.flatten(),
			);
			return null;
		}

		// 5. Return the validated LLM row
		log.info(
			`Found smartest model for ${normalizedProviderName}: ${parsedModel.data.llm_codename}`,
		);
		return parsedModel.data;
	} catch (error) {
		// 6. Log any unexpected errors during the database query
		log.error(
			`Error loading smartest model for provider ${normalizedProviderName}:`,
			error,
		);
		return null;
	}
}

/**
 * Loads unique LLM providers from the database for dynamic select menus.
 * Only returns providers that have at least one non-deprecated model available.
 * Case-insensitive deduplication with consistent capitalization.
 * @param includeDeprecated - Whether to include providers that only have deprecated models (default: false).
 * @returns An array of unique provider names, or null if error or none found.
 */
export async function loadUniqueProviders(
	includeDeprecated = false,
): Promise<string[] | null> {
	try {
		// 1. Query for providers that have at least one available model (filtering deprecated unless explicitly included)
		const providerQuery = includeDeprecated
			? sql`
				SELECT DISTINCT llm_provider
				FROM llms
				ORDER BY llm_provider ASC
			`
			: sql`
				SELECT DISTINCT llm_provider
				FROM llms
				WHERE is_deprecated = false
				ORDER BY llm_provider ASC
			`;

		const providerRows = await providerQuery;

		// 2. Check if any rows were returned
		if (!providerRows || providerRows.length === 0) {
			log.warn("No LLM providers with available models found in the database.");
			return null;
		}

		// 3. Extract provider names and perform case-insensitive deduplication
		const providerMap = new Map<string, string>();

		for (const row of providerRows) {
			const provider = row.llm_provider as string;
			const lowerKey = provider.toLowerCase();

			// Keep the first occurrence (which will be alphabetically sorted)
			// This ensures consistent capitalization (e.g., "Google" over "google")
			if (!providerMap.has(lowerKey)) {
				providerMap.set(lowerKey, provider);
			}
		}

		// 4. Convert back to array, sorted by the normalized keys
		const providers = Array.from(providerMap.values()).sort();

		log.info(
			`Found ${providers.length} unique LLM providers with available models: ${providers.join(", ")}`,
		);
		return providers;
	} catch (error) {
		// 5. Log any unexpected errors during the database query
		log.error("Error loading unique LLM providers from database:", error);
		return null;
	}
}

/**
 * Loads personality presets with truncated descriptions for dynamic select menus.
 * @param maxDescriptionLength - Maximum length for preset descriptions (default: 100)
 * @returns An array of preset options with truncated descriptions, or null if error or none found.
 */
export async function loadPresetOptions(
	maxDescriptionLength = 100,
): Promise<Array<{ name: string; description: string }> | null> {
	try {
		// 1. Query for all presets with descriptions
		const presetRows = await sql`
			SELECT tomori_preset_name, tomori_preset_desc
			FROM tomori_presets
			ORDER BY tomori_preset_name ASC
		`;

		// 2. Check if any rows were returned
		if (!presetRows || presetRows.length === 0) {
			log.warn("No personality presets found in the database.");
			return null;
		}

		// 3. Process and truncate descriptions
		const presetOptions = presetRows.map((row: Record<string, unknown>) => {
			const description = row.tomori_preset_desc as string;
			const truncatedDescription =
				description.length > maxDescriptionLength
					? `${description.substring(0, maxDescriptionLength - 3)}...`
					: description;

			return {
				name: row.tomori_preset_name as string,
				description: truncatedDescription,
			};
		});

		log.info(
			`Found ${presetOptions.length} personality presets for selection menu.`,
		);
		return presetOptions;
	} catch (error) {
		// 4. Log any unexpected errors during the database query
		log.error("Error loading preset options from database:", error);
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

/**
 * Loads all reminders that are due for execution (reminder_time <= current time)
 * @returns Array of due ReminderRow objects, or null if error
 */
export async function getDueReminders(): Promise<ReminderRow[] | null> {
	try {
		// Query for reminders that are due (reminder_time <= now)
		const reminderData = await sql`
			SELECT * FROM reminders
			WHERE reminder_time <= CURRENT_TIMESTAMP
			ORDER BY reminder_time ASC
		`;

		if (!reminderData) {
			log.warn(
				"Reminders data was unexpectedly null when fetching due reminders",
			);
			return [];
		}

		if (reminderData.length === 0) {
			// log.info("No due reminders found");
			return [];
		}

		// Validate each reminder row
		const validatedReminders: ReminderRow[] = [];
		for (const reminder of reminderData) {
			const parsed = reminderSchema.safeParse(reminder);
			if (parsed.success) {
				validatedReminders.push(parsed.data);
			} else {
				log.warn(
					`Invalid reminder data found in DB for reminder_id ${reminder.reminder_id}: ${JSON.stringify(reminder)}. Errors: ${parsed.error.flatten()}`,
				);
			}
		}

		log.info(`Found ${validatedReminders.length} due reminders`);
		return validatedReminders;
	} catch (error) {
		log.error("Error loading due reminders from database:", error);
		return null;
	}
}

/**
 * Loads a specific reminder by its ID
 * @param reminderId - The ID of the reminder to load
 * @returns The ReminderRow object if found, null otherwise
 */
export async function getReminderById(
	reminderId: number,
): Promise<ReminderRow | null> {
	try {
		const [reminderData] = await sql`
			SELECT * FROM reminders
			WHERE reminder_id = ${reminderId}
			LIMIT 1
		`;

		if (!reminderData) {
			log.info(`Reminder not found with ID: ${reminderId}`);
			return null;
		}

		// Validate the reminder data
		const parsed = reminderSchema.safeParse(reminderData);
		if (!parsed.success) {
			log.warn(
				`Invalid reminder data found in DB for reminder_id ${reminderId}: ${JSON.stringify(reminderData)}. Errors: ${parsed.error.flatten()}`,
			);
			return null;
		}

		log.info(`Loaded reminder with ID: ${reminderId}`);
		return parsed.data;
	} catch (error) {
		log.error(`Error loading reminder with ID ${reminderId}:`, error);
		return null;
	}
}

/**
 * Gets the count of active reminders for a specific user
 * @param userDiscordId - The Discord ID of the user
 * @returns The count of active reminders for the user, or 0 if error
 */
export async function getUserReminderCount(userDiscordId: string): Promise<number> {
	try {
		const [result] = await sql`
			SELECT COUNT(*) as reminder_count
			FROM reminders
			WHERE user_discord_id = ${userDiscordId}
		`;

		return Number(result?.reminder_count || 0);
	} catch (error) {
		log.error(`Error counting reminders for user ${userDiscordId}:`, error);
		return 0;
	}
}

/**
 * Deletes a reminder from the database by its ID
 * @param reminderId - The ID of the reminder to delete
 * @returns True if reminder was deleted, false otherwise
 */
export async function deleteReminderById(reminderId: number): Promise<boolean> {
	try {
		const result = await sql`
			DELETE FROM reminders
			WHERE reminder_id = ${reminderId}
		`;

		const deletedCount = result.affectedRows || 0;
		if (deletedCount > 0) {
			log.success(`Reminder deleted successfully (ID: ${reminderId})`);
			return true;
		} else {
			log.warn(`No reminder found to delete with ID: ${reminderId}`);
			return false;
		}
	} catch (error) {
		log.error(`Error deleting reminder with ID ${reminderId}:`, error);
		return false;
	}
}
