import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { MessageFlags } from "discord.js";
import { sql } from "bun";
import {
	serverMemorySchema, // Use the correct schema for validation
	type UserRow,
	type ErrorContext,
	type TomoriState,
} from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
	replyInfoEmbed,
	replyPaginatedChoices,
} from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";
import type { PaginatedChoiceResult } from "../../types/discord/embed";

// Rule 20: Constants for static values at the top
const DISPLAY_TRUNCATE_LENGTH = 45; // Max length for memory content in the display list

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("servermemory")
		.setDescription(
			localizer("en-US", "commands.unlearn.servermemory.command_description"),
		)
		.setDescriptionLocalizations({
			ja: localizer("ja", "commands.unlearn.servermemory.command_description"),
		});

/**
 * Rule 1: JSDoc comment for exported function
 * Removes a server memory from the server_memories table using a paginated embed.
 * @param _client - Discord client instance
 * @param interaction - Command interaction
 * @param userData - User data from database
 * @param locale - Locale of the interaction
 */
export async function execute(
	_client: Client,
	interaction: ChatInputCommandInteraction,
	userData: UserRow,
	locale: string,
): Promise<void> {
	// 1. Ensure command is run in a guild context (Rule 17)
	if (!interaction.guild) {
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only",
			color: ColorCode.ERROR,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Define state and result variables outside try for catch block context
	let tomoriState: TomoriState | null = null;
	let result: PaginatedChoiceResult | null = null;

	try {
		// 2. Defer reply ephemerally (User Request)
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 3. Load server's Tomori state (Rule 17) - Needed for server_id and config checks
		tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.not_setup_title",
				descriptionKey: "general.errors.not_setup_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 4. Check permissions and if teaching is enabled
		const hasManagePermission =
			interaction.memberPermissions?.has("ManageGuild") ?? false;
		// NOTE: Check the correct config key name from tomori_configs table
		if (
			!tomoriState.config.server_memteaching_enabled && // Assuming this is the correct key
			!hasManagePermission
		) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.unlearn.servermemoryadd.teaching_disabled_title", // Re-use add command's key
				descriptionKey:
					"commands.unlearn.servermemoryadd.teaching_disabled_description", // Re-use add command's key
				color: ColorCode.ERROR,
			});
			return;
		}

		// 5. Fetch all server memories for this server from the server_memories table
		let memoriesQuery = sql`
            SELECT server_memory_id, content, user_id -- Select user_id too
            FROM server_memories
            WHERE server_id = ${
							// biome-ignore lint/style/noNonNullAssertion: tomoriState check guarantees server_id
							tomoriState.server_id!
						}
        `;

		if (!hasManagePermission) {
			// If user does NOT have ManageGuild permission, only fetch their own memories
			memoriesQuery = sql`${memoriesQuery} AND user_id = ${userData.user_id}`;
		}

		// Add ordering
		memoriesQuery = sql`${memoriesQuery} ORDER BY created_at DESC`;

		// Execute the constructed query
		const memories = await memoriesQuery;

		if (memories.length === 0) {
			// 6. Check if there are any memories to remove (using the potentially filtered list)
			// Use a different message if the list is empty *because* of permissions vs. no memories exist at all
			const descriptionKey = hasManagePermission
				? "commands.unlearn.servermemory.no_memories" // No memories on server
				: "commands.unlearn.servermemory.no_owned_memories"; // User owns no memories
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.unlearn.servermemory.no_memories_title",
				descriptionKey: descriptionKey,
				color: ColorCode.WARN,
			});
			return;
		}

		// 7. Format memories for display, truncating long ones
		const displayItems = memories.map((memory: { content: string }) => {
			return memory.content.length > DISPLAY_TRUNCATE_LENGTH
				? `${memory.content.slice(0, DISPLAY_TRUNCATE_LENGTH)}...`
				: memory.content;
		});

		// 8. Use the replyPaginatedChoices helper
		result = await replyPaginatedChoices(interaction, locale, {
			titleKey: "commands.unlearn.servermemory.select_title",
			descriptionKey: "commands.unlearn.servermemory.select_description",
			itemLabelKey: "commands.unlearn.servermemory.memory_label",
			items: displayItems,
			color: ColorCode.INFO,
			flags: MessageFlags.Ephemeral, // Make the pagination ephemeral

			// Use simplified signature as expected by PaginatedChoiceOptions
			onSelect: async (selectedIndex: number) => {
				// 9. Get the ID of the memory to delete
				const memoryToDelete = memories[selectedIndex];

				// 10. Delete the memory from the database using Bun SQL (Rule 4, 15)
				// We use RETURNING * to validate the deleted row
				const [deletedRow] = await sql`
                    DELETE FROM server_memories
                    WHERE server_memory_id = ${memoryToDelete.server_memory_id}
                    RETURNING *
                `;

				// 11. Validate the returned (deleted) data (Rule 3, 5, 6)
				const validatedMemory = serverMemorySchema.safeParse(deletedRow);

				if (!validatedMemory.success || !deletedRow) {
					// Log error specific to this delete failure
					const context: ErrorContext = {
						// biome-ignore lint/style/noNonNullAssertion: tomoriState check guarantees these IDs exist
						tomoriId: tomoriState!.tomori_id,
						// biome-ignore lint/style/noNonNullAssertion: tomoriState check guarantees these IDs exist
						serverId: tomoriState!.server_id,
						userId: userData.user_id,
						errorType: "DatabaseDeleteError",
						metadata: {
							command: "teach servermemory",
							table: "server_memories",
							deletedMemoryId: memoryToDelete.server_memory_id,
							guildId: interaction.guild?.id,
							validationErrors: validatedMemory.success
								? null
								: validatedMemory.error.flatten(),
						},
					};
					// Throw error to be caught by replyPaginatedChoices's handler
					throw await log.error(
						"Failed to delete or validate server memory from server_memories table",
						validatedMemory.success
							? new Error("Database delete returned no rows or unexpected data")
							: new Error("Deleted server memory data failed validation"),
						context,
					);
				}

				// 12. Log success (onSelect doesn't handle user feedback directly)
				log.success(
					`Deleted server memory "${memoryToDelete.content.slice(0, 30)}..." (ID: ${memoryToDelete.server_memory_id}) for server ${
						// biome-ignore lint/style/noNonNullAssertion: tomoriState check guarantees server_id exists
						tomoriState!.server_id
					} by user ${userData.user_disc_id}`,
				);
				// The replyPaginatedChoices helper will show the success message
			},

			// Simplified onCancel handler as expected by PaginatedChoiceOptions
			onCancel: async () => {
				// This runs if the user clicks Cancel
				log.info(
					`User ${userData.user_disc_id} cancelled deleting a server memory for server ${
						// biome-ignore lint/style/noNonNullAssertion: tomoriState check guarantees server_id exists
						tomoriState!.server_id
					}`,
				);
				// The replyPaginatedChoices helper will show the cancellation message
			},
		});

		// 13. Handle potential errors from the helper itself
		if (!result.success && result.reason === "error") {
			log.warn(
				`replyPaginatedChoices reported an error for user ${userData.user_disc_id} in /teach servermemory`,
			);
		} else if (!result.success && result.reason === "timeout") {
			log.warn(
				`Server memory deletion timed out for user ${userData.user_disc_id} (Server ID: ${
					// biome-ignore lint/style/noNonNullAssertion: tomoriState check guarantees server_id exists
					tomoriState!.server_id
				})`,
			);
		}
	} catch (error) {
		// 14. Catch unexpected errors
		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: tomoriState?.server_id,
			tomoriId: tomoriState?.tomori_id,
			errorType: "CommandExecutionError",
			metadata: {
				command: "teach servermemory",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
			},
		};
		await log.error(
			`Unexpected error in /teach servermemory for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 15. Inform user of unknown error
		if (interaction.deferred || interaction.replied) {
			try {
				await interaction.followUp({
					content: localizer(
						locale,
						"general.errors.unknown_error_description",
					),
					flags: MessageFlags.Ephemeral,
				});
			} catch (followUpError) {
				log.error(
					"Failed to send follow-up error message in servermemory catch block",
					followUpError,
				);
			}
		} else {
			log.warn(
				"Could not determine valid interaction to send error message in servermemory catch block",
			);
		}
	}
}
