import { sql } from "bun";
import type { SqlParameterArray } from "@/types/db/sqlOperations";
import {
	tomoriSchema,
	userSchema,
	tomoriConfigSchema,
	type TomoriRow,
	type UserRow,
	type TomoriConfigRow,
	type ErrorContext,
	serverMemorySchema,
} from "../../types/db/schema"; // Import base schemas and types
import { log } from "../misc/logger";
import { validateTomoriConfigFields, validateTomoriFields, validateUserFields } from "./sqlSecurity";
import type { Guild } from "discord.js";
import {
	validateMemoryContent,
	checkPersonalMemoryLimit,
	checkServerMemoryLimit,
} from "./memoryLimits";
import type {
	ServerMemoryRow,
	SetupConfig,
	SetupResult,
} from "../../types/db/schema";
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
 * When the counter reaches the threshold, it resets to 0.
 * @param tomoriId - The ID of the Tomori instance.
 * @param threshold - The autoch_threshold value from config.
 * @returns The updated TomoriRow with the new counter value, or null on error.
 */
export async function incrementTomoriCounter(
	tomoriId: number,
	threshold: number,
): Promise<TomoriRow | null> {
	try {
		// 1. First check if the threshold is positive and active
		if (threshold <= 0) {
			// If threshold is inactive, just increment without resetting
			const [incrementedTomori] = await sql`
				UPDATE tomoris
				SET autoch_counter = autoch_counter + 1
				WHERE tomori_id = ${tomoriId}
				RETURNING *
			`;

			// Validate and return
			const parsedTomori = tomoriSchema.safeParse(incrementedTomori);
			return parsedTomori.success ? parsedTomori.data : null;
		}

		// 2. If threshold is active, use CTE to check if we've reached it
		const [updatedTomori] = await sql`
			WITH incremented AS (
				UPDATE tomoris
				SET autoch_counter = 
					CASE 
						WHEN autoch_counter + 1 > ${threshold} THEN 0  -- Reset to 0 when threshold reached
						ELSE autoch_counter + 1                         -- Otherwise increment
					END
				WHERE tomori_id = ${tomoriId}
				RETURNING *
			)
			SELECT * FROM incremented
		`;

		if (!updatedTomori) {
			const context: ErrorContext = {
				tomoriId,
				errorType: "DatabaseUpdateError",
				metadata: {
					operation: "incrementTomoriCounter",
					threshold,
				},
			};

			await log.error(
				`Failed to increment/reset counter for Tomori ${tomoriId}`,
				new Error("Tomori not found"),
				context,
			);
			return null;
		}

		// Validate the returned data
		const parsedTomori = tomoriSchema.safeParse(updatedTomori);
		if (!parsedTomori.success) {
			const context: ErrorContext = {
				tomoriId,
				errorType: "SchemaValidationError",
				metadata: {
					operation: "incrementTomoriCounter",
					validationErrors: parsedTomori.error.flatten(),
				},
			};

			await log.error(
				"Failed to validate Tomori data after counter update",
				parsedTomori.error,
				context,
			);
			return null;
		}

		return parsedTomori.data;
	} catch (error) {
		const context: ErrorContext = {
			tomoriId,
			errorType: "DatabaseOperationError",
			metadata: {
				operation: "incrementTomoriCounter",
				threshold,
			},
		};

		await log.error(
			`Error incrementing/resetting auto counter for Tomori ${tomoriId}`,
			error,
			context,
		);
		return null;
	}
}

/**
 * Sets up a new server with Tomori in a single atomic transaction.
 * Creates server record, Tomori instance, config, and registers all server emojis.
 * Supports both guild channels and DM contexts (pseudo-servers).
 *
 * @param guild - The Discord guild to setup (null for DM contexts)
 * @param config - Configuration data for server setup
 * @returns All database rows created during setup
 * @throws If validation fails or any part of the setup transaction fails
 */
export async function setupServer(
	guild: Guild | null,
	config: SetupConfig,
): Promise<SetupResult> {
	// Validate input config - critical operation so we use Zod (Rule 3, Rule 5)
	const validConfig = setupConfigSchema.parse(config);

	// Detect if this is a DM context (no guild)
	const isDMChannel = guild === null;
	log.section(`Starting server setup transaction (${isDMChannel ? 'DM' : 'Guild'} context)`);

	try {
		// Start transaction for atomicity (Rule 15)
		const result = await sql.transaction(async (tx) => {
			// Find the default model for the selected provider using is_default flag
			let selectedLlm = (await tx`
                SELECT llm_id, llm_codename, llm_provider 
                FROM llms 
                WHERE llm_provider = ${validConfig.provider} AND is_default = true
                LIMIT 1
            `)[0];

			// Fallback: if no default is marked for this provider, get the first available model for the provider
			if (!selectedLlm) {
				selectedLlm = (await tx`
					SELECT llm_id, llm_codename, llm_provider 
					FROM llms 
					WHERE llm_provider = ${validConfig.provider}
					ORDER BY llm_id 
					LIMIT 1
				`)[0];
				
				if (!selectedLlm) {
					throw new Error(`No models found for provider: ${validConfig.provider}`);
				}
				
				log.warn(`No default model found for provider ${validConfig.provider}, using fallback: ${selectedLlm.llm_codename}`);
			} else {
				log.info(`Using default model for ${validConfig.provider}: ${selectedLlm.llm_codename}`);
			}

			const defaultTriggers = process.env.BASE_TRIGGER_WORDS?.split(",").map(
				(word) => word.trim(),
			) || ["tomori", "tomo", "トモリ", "ともり"];

			// 1. Create or update server record with DM support (Rule 15)
			const [server] = await tx`
				INSERT INTO servers (server_disc_id, is_dm_channel)
				VALUES (${validConfig.serverId}, ${isDMChannel})
				ON CONFLICT (server_disc_id) DO UPDATE
				SET is_dm_channel = EXCLUDED.is_dm_channel
				RETURNING *
			`;

			// 2. Create Tomori instance with preset including description
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
					(
						SELECT 
							array_prepend(
								'{bot}''s Description: ' || tomori_preset_desc,
								preset_attribute_list
							) 
						FROM tomori_presets 
						WHERE tomori_preset_id = ${validConfig.presetId}
					),
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
					humanizer_degree,
					attribute_memteaching_enabled,
					sampledialogue_memteaching_enabled
				)
				VALUES (
					${tomori.tomori_id},
					${selectedLlm.llm_id},
					${validConfig.encryptedApiKey},
					${triggerWordsArrayLiteral}::text[],
					${validConfig.humanizer},
					${isDMChannel},
					${isDMChannel}
				)
				RETURNING *
			`;

			// 4. Register guild emojis in bulk insert (only for guild contexts, Rule 16)
			const emojis = [];
			if (!isDMChannel && guild) {
				const emojiValues = Array.from(guild.emojis.cache.values()).map((e) => ({
					emoji_disc_id: e.id,
					emoji_name: e.name ?? "",
					emotion_key: "unset", // Add the emotion_key field
					is_animated: e.animated || false, // Track if emoji is animated
				}));

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
			} else {
				log.info("Skipping emoji registration for DM context");
			}

			// 5. Register guild stickers (only for guild contexts)
			const stickers = [];
			if (!isDMChannel && guild) {
				log.info(`Registering stickers for server ${server.server_id}`);
				const stickerValues = Array.from(guild.stickers.cache.values()).map(
					(s) => ({
						sticker_disc_id: s.id,
						sticker_name: s.name,
						sticker_desc: s.description ?? "",
						emotion_key: "unset",
						// is_animated: s.format === StickerFormatType.Lottie, // Remove this line
						sticker_format: s.format, // Store the actual format type enum value
					}),
				);

				for (const {
					sticker_disc_id,
					sticker_name,
					sticker_desc,
					emotion_key,
					// is_animated, // Remove from destructuring
					sticker_format, // Add to destructuring
				} of stickerValues) {
					const [row] = await tx`
                        INSERT INTO server_stickers (
                            server_id,
                            sticker_disc_id,
                            sticker_name,
                            sticker_desc,
                            emotion_key,
                            sticker_format -- Add to INSERT
                            -- is_global defaults to false in DB schema
                        ) VALUES (
                            ${server.server_id},
                            ${sticker_disc_id},
                            ${sticker_name},
                            ${sticker_desc},
                            ${emotion_key},
                            ${sticker_format} -- Add value
                        )
                        ON CONFLICT (server_id, sticker_disc_id) DO NOTHING
                        RETURNING *
                    `;
					if (row) {
						stickers.push(row);
					}
				}
				log.info(`Finished registering ${stickers.length} stickers.`);
			} else {
				log.info("Skipping sticker registration for DM context");
			}

			// Return all created records
			return {
				server,
				tomori,
				config,
				emojis,
				stickers,
			};
		});

		// Validate output structure but don't overwrite the result
		setupResultSchema.parse(result);

		log.success(
			`${isDMChannel ? 'DM pseudo-server' : 'Server'} setup completed successfully for Server ID (${validConfig.serverId})`,
		);
		if (!isDMChannel) {
			log.info(`Registered ${result.emojis.length} emojis and ${result.stickers.length} stickers`);
		} else {
			log.info("DM setup completed - emoji/sticker registration skipped");
		}

		return result;
	} catch (error) {
		log.error("Server setup transaction failed:", error);
		throw error; // Re-throw to let caller handle the error
	}
}

/**
 * Updates a TomoriConfig record with partial data.
 * Uses zod's .partial() schema for validation and SQL RETURNING for atomicity.
 *
 * @param tomoriId - The tomori_id of the config to update
 * @param configData - Partial data to update (only specified fields will be changed)
 * @returns The updated TomoriConfigRow or null if update failed
 */
export async function updateTomoriConfig(
	tomoriId: number,
	configData: Partial<TomoriConfigRow>,
): Promise<TomoriConfigRow | null> {
	try {
		// Validate the partial data with Zod (Rule #7)
		const validConfigData = tomoriConfigSchema.partial().parse(configData);

		// Extract field names and values for the SQL query
		const fields = Object.keys(validConfigData).filter(
			(key) => key !== "tomori_id" && key !== "tomori_config_id",
		);

		if (fields.length === 0) {
			log.warn(`No fields provided to update for tomori_id: ${tomoriId}`);
			return null;
		}

		// Security validation: Ensure all field names are whitelisted to prevent SQL injection
		validateTomoriConfigFields(fields);

		// Dynamically build the SQL SET clause
		// 1. Prepare arrays for placeholders and values
		const setParts: string[] = [];
		const values: SqlParameterArray = [];

		// 2. Iterate through fields to build SET clause parts and collect values
		fields.forEach((field, index) => {
			// Use PostgreSQL standard placeholders ($1, $2, etc.)
			setParts.push(`${field} = $${index + 1}`);
			// Add the corresponding value to the values array
			values.push(validConfigData[field as keyof typeof validConfigData]);
		});

		// 3. Join the SET parts
		const setClause = setParts.join(", ");

		// 4. Add the tomoriId as the last parameter for the WHERE clause
		const finalPlaceholderIndex = values.length + 1;
		values.push(tomoriId);

		// 5. Execute the UPDATE using sql.unsafe() but with proper placeholders and arguments
		// Bun's sql will correctly handle parameterization for different types (including arrays) here.
		const result = await sql.unsafe(
			`
			UPDATE tomori_configs
			SET ${setClause}
			WHERE tomori_id = $${finalPlaceholderIndex}
			RETURNING *
		`,
			...values, // Pass the values array directly with spreading
		);

		if (!result.length) {
			const context: ErrorContext = {
				tomoriId,
				errorType: "DatabaseUpdateError",
				metadata: {
					operation: "updateTomoriConfig",
					fields,
				},
			};
			await log.error(
				`No tomori_config found with tomori_id: ${tomoriId}`,
				new Error("Config not found"),
				context,
			);
			return null;
		}

		// Validate the returned data for type safety (Rule #5)
		const updatedConfig = tomoriConfigSchema.safeParse(result[0]);
		if (!updatedConfig.success) {
			const context: ErrorContext = {
				tomoriId,
				errorType: "SchemaValidationError",
				metadata: {
					operation: "updateTomoriConfig",
					validationErrors: updatedConfig.error.flatten(),
				},
			};
			await log.error(
				`Failed to validate updated config for tomori_id: ${tomoriId}`,
				updatedConfig.error,
				context,
			);
			return null;
		}

		return updatedConfig.data;
	} catch (error) {
		const context: ErrorContext = {
			tomoriId,
			errorType: "DatabaseUpdateError",
			metadata: {
				operation: "updateTomoriConfig",
			},
		};
		await log.error(
			`Error updating tomori_config for tomori_id: ${tomoriId}`,
			error,
			context,
		);
		return null;
	}
}

/**
 * Updates a Tomori record with partial data.
 * Uses zod's .partial() schema for validation and SQL RETURNING for atomicity.
 *
 * @param tomoriId - The tomori_id to update
 * @param tomoriData - Partial data to update (only specified fields will be changed)
 * @returns The updated TomoriRow or null if update failed
 */
export async function updateTomori(
	tomoriId: number,
	tomoriData: Partial<TomoriRow>,
): Promise<TomoriRow | null> {
	try {
		// Validate the partial data with Zod (Rule #7)
		const validTomoriData = tomoriSchema.partial().parse(tomoriData);

		// Extract field names and values for the SQL query
		const fields = Object.keys(validTomoriData).filter(
			(key) => key !== "tomori_id", // Exclude the primary key
		);

		if (fields.length === 0) {
			log.warn(`No fields provided to update for tomori_id: ${tomoriId}`);
			return null;
		}

		// Security validation: Ensure all field names are whitelisted to prevent SQL injection
		validateTomoriFields(fields);

		// 1. Prepare arrays for placeholders and values
		const setParts: string[] = [];
		const values: SqlParameterArray = [];

		// 2. Iterate through fields to build SET clause parts and collect values
		fields.forEach((field, index) => {
			setParts.push(`${field} = $${index + 1}`); // Use $1, $2, etc.
			values.push(validTomoriData[field as keyof typeof validTomoriData]);
		});

		// 3. Join the SET parts
		const setClause = setParts.join(", ");

		// 4. Add the tomoriId as the last parameter for the WHERE clause
		const finalPlaceholderIndex = values.length + 1;
		values.push(tomoriId);

		// 5. Execute the UPDATE using sql.unsafe() with placeholders and arguments
		const result = await sql.unsafe(
			`
			UPDATE tomoris
			SET ${setClause}
			WHERE tomori_id = $${finalPlaceholderIndex}
			RETURNING *
		`,
			...values, // Pass the values array directly spreading
		);

		if (!result.length) {
			const context: ErrorContext = {
				tomoriId,
				errorType: "DatabaseUpdateError",
				metadata: {
					operation: "updateTomori",
					fields,
				},
			};
			await log.error(
				`No tomori found with id: ${tomoriId}`,
				new Error("Tomori not found"),
				context,
			);
			return null;
		}

		// Validate the returned data for type safety
		const updatedTomori = tomoriSchema.safeParse(result[0]);
		if (!updatedTomori.success) {
			const context: ErrorContext = {
				tomoriId,
				errorType: "SchemaValidationError",
				metadata: {
					operation: "updateTomori",
					validationErrors: updatedTomori.error.flatten(),
				},
			};
			await log.error(
				`Failed to validate updated tomori for id: ${tomoriId}`,
				updatedTomori.error,
				context,
			);
			return null;
		}

		return updatedTomori.data;
	} catch (error) {
		const context: ErrorContext = {
			tomoriId,
			errorType: "DatabaseUpdateError",
			metadata: {
				operation: "updateTomori",
			},
		};
		await log.error(
			`Error updating tomori for id: ${tomoriId}`,
			error,
			context,
		);
		return null;
	}
}

/**
 * Updates a User record with partial data.
 * Uses zod's .partial() schema for validation and SQL RETURNING for atomicity.
 *
 * @param userId - The user_id to update
 * @param userData - Partial data to update (only specified fields will be changed)
 * @returns The updated UserRow or null if update failed
 */
export async function updateUser(
	userId: number,
	userData: Partial<UserRow>,
): Promise<UserRow | null> {
	try {
		// Validate the partial data with Zod (Rule #7)
		const validUserData = userSchema.partial().parse(userData);

		// Extract field names and values for the SQL query
		const fields = Object.keys(validUserData).filter(
			(key) => key !== "user_id", // Exclude the primary key
		);

		if (fields.length === 0) {
			log.warn(`No fields provided to update for user_id: ${userId}`);
			return null;
		}

		// Security validation: Ensure all field names are whitelisted to prevent SQL injection
		validateUserFields(fields);

		// 1. Prepare arrays for placeholders and values
		const setParts: string[] = [];
		const values: SqlParameterArray = [];

		// 2. Iterate through fields to build SET clause parts and collect values
		fields.forEach((field, index) => {
			setParts.push(`${field} = $${index + 1}`); // Use $1, $2, etc.
			values.push(validUserData[field as keyof typeof validUserData]);
		});

		// 3. Join the SET parts
		const setClause = setParts.join(", ");

		// 4. Add the userId as the last parameter for the WHERE clause
		const finalPlaceholderIndex = values.length + 1;
		values.push(userId);

		// 5. Execute the UPDATE using sql.unsafe() with placeholders and arguments
		const result = await sql.unsafe(
			`
            UPDATE users
            SET ${setClause}
            WHERE user_id = $${finalPlaceholderIndex}
            RETURNING *
        `,
			...values, // Spread the values array as arguments
		);

		if (!result.length) {
			const context: ErrorContext = {
				userId,
				errorType: "DatabaseUpdateError",
				metadata: {
					operation: "updateUser",
					fields,
				},
			};
			await log.error(
				`No user found with id: ${userId}`,
				new Error("User not found"),
				context,
			);
			return null;
		}

		// Validate the returned data for type safety
		const updatedUser = userSchema.safeParse(result[0]);
		if (!updatedUser.success) {
			const context: ErrorContext = {
				userId,
				errorType: "SchemaValidationError",
				metadata: {
					operation: "updateUser",
					validationErrors: updatedUser.error.flatten(),
				},
			};
			await log.error(
				`Failed to validate updated user for id: ${userId}`,
				updatedUser.error,
				context,
			);
			return null;
		}

		return updatedUser.data;
	} catch (error) {
		const context: ErrorContext = {
			userId,
			errorType: "DatabaseUpdateError",
			metadata: {
				operation: "updateUser",
			},
		};
		await log.error(`Error updating user for id: ${userId}`, error, context);
		return null;
	}
}

/**
 * Adds a new server-wide memory, initiated by Tomori itself due to an interaction.
 * This memory is associated with a specific server and the user whose interaction triggered the learning.
 *
 * @param serverId - The internal ID of the server this memory pertains to.
 * @param taughtByUserId - The internal ID of the user whose interaction led to Tomori learning this.
 * @param content - The text content of the memory to be saved.
 * @returns The newly created ServerMemoryRow, or null if the operation failed.
 */
export async function addServerMemoryByTomori(
	serverId: number,
	taughtByUserId: number,
	content: string,
): Promise<ServerMemoryRow | null> {
	// 1. Log the attempt to add a server memory.
	log.info(
		`Tomori is attempting to self-learn a server memory for server ID ${serverId} (triggered by user ID ${taughtByUserId}): "${content.substring(0, 50)}..."`,
	);

	// 2. Validate memory content before database operations
	const contentValidation = validateMemoryContent(content);
	if (!contentValidation.isValid) {
		log.warn(
			`Server memory content validation failed for server ID ${serverId}: ${contentValidation.error}`,
		);
		return null;
	}

	// 3. Check server memory limit
	const serverLimitCheck = await checkServerMemoryLimit(serverId);
	if (!serverLimitCheck.isValid) {
		log.warn(
			`Server memory limit exceeded for server ID ${serverId}: ${serverLimitCheck.currentCount}/${serverLimitCheck.maxAllowed}`,
		);
		return null;
	}

	try {
		// 2. Insert the new memory into the server_memories table.
		// The columns now correctly match the serverMemorySchema.
		const [newMemory] = await sql`
            INSERT INTO server_memories (server_id, user_id, content)
            VALUES (${serverId}, ${taughtByUserId}, ${content})
            RETURNING *
        `;

		// 3. Validate the returned data using Zod schema (Rule 3, Rule 5, Rule 6).
		const validatedMemory = serverMemorySchema.safeParse(newMemory);

		if (!validatedMemory.success) {
			const context: ErrorContext = {
				serverId,
				userId: taughtByUserId,
				errorType: "SchemaValidationError",
				metadata: {
					operation: "addServerMemoryByTomori",
					contentAttempted: content.substring(0, 100),
					validationErrors: validatedMemory.error.flatten(),
				},
			};
			await log.error(
				`Failed to validate new server memory for server ID ${serverId}`,
				validatedMemory.error,
				context,
			);
			return null;
		}

		// 4. Log success and return the validated memory.
		log.success(
			`Tomori successfully saved a new server memory (ID: ${validatedMemory.data.server_memory_id}) for server ID ${serverId}, taught by user ID ${taughtByUserId}.`,
		);
		return validatedMemory.data;
	} catch (error) {
		const context: ErrorContext = {
			serverId,
			userId: taughtByUserId,
			errorType: "DatabaseInsertError",
			metadata: {
				operation: "addServerMemoryByTomori",
				contentAttempted: content.substring(0, 100),
			},
		};
		await log.error(
			`Error adding server memory for server ID ${serverId}`,
			error,
			context,
		);
		return null;
	}
}
/**
 * Adds a new personal memory for a user by atomically appending to their
 * 'personal_memories' array using PostgreSQL's array_append function.
 * This is initiated by Tomori itself.
 *
 * @param userId - The internal ID of the user for whom the memory is being saved.
 * @param content - The text content of the memory to be appended.
 * @returns The updated UserRow with the new memory, or null if the operation failed.
 */
export async function addPersonalMemoryByTomori(
	userId: number,
	content: string,
): Promise<UserRow | null> {
	// 1. Log the attempt to add a personal memory.
	log.info(
		`Tomori is attempting to self-learn and append a personal memory for User ID ${userId} using array_append: "${content.substring(0, 50)}..."`,
	);

	// 2. Validate memory content before database operations
	const contentValidation = validateMemoryContent(content);
	if (!contentValidation.isValid) {
		log.warn(
			`Personal memory content validation failed for user ID ${userId}: ${contentValidation.error}`,
		);
		return null;
	}

	// 3. Check personal memory limit
	const personalLimitCheck = await checkPersonalMemoryLimit(userId);
	if (!personalLimitCheck.isValid) {
		log.warn(
			`Personal memory limit exceeded for user ID ${userId}: ${personalLimitCheck.currentCount}/${personalLimitCheck.maxAllowed}`,
		);
		return null;
	}

	try {
		// 2. Atomically update the user's personal_memories array using array_append.
		// This is generally safer for concurrent appends than read-modify-write from the application.
		// Rule 23 applies to formatting a full array literal; for appends, array_append is preferred.
		const [updatedUserResult] = await sql`
            UPDATE users
            SET personal_memories = array_append(personal_memories, ${content})
            WHERE user_id = ${userId}
            RETURNING *
        `;

		// 3. Check if the user row was found and updated.
		if (!updatedUserResult) {
			// This could happen if the userId doesn't exist, though in self-teach, it should.
			log.warn(
				`Attempted to append personal memory for non-existent User ID ${userId} (self-teach with array_append).`,
			);
			return null;
		}

		// 4. Validate the returned user data using Zod schema.
		const validatedUser = userSchema.safeParse(updatedUserResult);

		if (!validatedUser.success) {
			const context: ErrorContext = {
				userId,
				errorType: "SchemaValidationError",
				metadata: {
					operation: "addPersonalMemoryByTomori (array_append)",
					contentAttempted: content.substring(0, 100),
					validationErrors: validatedUser.error.flatten(),
				},
			};
			await log.error(
				`Failed to validate updated user row after appending personal memory for User ID ${userId} (self-teach)`,
				validatedUser.error,
				context,
			);
			return null;
		}

		// 5. Log success and return the validated user row.
		log.success(
			`Tomori successfully appended a personal memory for User ID ${userId} (self-teach using array_append). New array size: ${validatedUser.data.personal_memories.length}.`,
		);
		return validatedUser.data;
	} catch (error) {
		const context: ErrorContext = {
			userId,
			errorType: "DatabaseUpdateError",
			metadata: {
				operation: "addPersonalMemoryByTomori (array_append)",
				contentAttempted: content.substring(0, 100),
			},
		};
		await log.error(
			`Error appending personal memory for User ID ${userId} (self-teach using array_append)`,
			error,
			context,
		);
		return null;
	}
}
