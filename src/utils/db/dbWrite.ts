import { sql } from "bun";
import {
	tomoriSchema,
	userSchema,
	tomoriConfigSchema,
	type TomoriRow,
	type UserRow,
	type TomoriConfigRow,
	type ErrorContext,
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
				WHERE llm_codename = '${process.env.DEFAULT_GEMINI_MODEL}'
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

			const defaultTriggers = process.env.BASE_TRIGGER_WORDS?.split(",").map(
				(word) => word.trim(),
			) || ["tomori", "tomo", "トモリ", "ともり"];

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

			// 5. Register guild stickers
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

			const stickers = [];
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

		// Dynamically build the SQL SET clause
		// 1. Prepare arrays for placeholders and values
		const setParts: string[] = [];
		// biome-ignore lint/suspicious/noExplicitAny: Using any[] to ensure compatibility with sql.unsafe's spread argument signature
		const values: any[] = [];

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

		// 1. Prepare arrays for placeholders and values
		const setParts: string[] = [];
		// biome-ignore lint/suspicious/noExplicitAny: Using any[] to ensure compatibility with sql.unsafe's spread argument signature
		const values: any[] = [];

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

		// 1. Prepare arrays for placeholders and values
		const setParts: string[] = [];
		// biome-ignore lint/suspicious/noExplicitAny: Using any[] to ensure compatibility with sql.unsafe's spread argument signature
		const values: any[] = [];

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
