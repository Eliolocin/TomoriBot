import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { MessageFlags } from "discord.js";
import { sql } from "bun";
import {
	userSchema, // Use userSchema for validation
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
import type { PaginatedChoiceResult } from "../../types/discord/embed"; // Corrected import path
import { createStandardEmbed } from "../../utils/discord/embedHelper";

// Rule 20: Constants for static values at the top
const DISPLAY_TRUNCATE_LENGTH = 45; // Max length for memory content in the display list

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("personalmemory")
		.setDescription(
			localizer("en-US", "commands.unlearn.personalmemory.command_description"),
		)
		.setDescriptionLocalizations({
			ja: localizer(
				"ja",
				"commands.unlearn.personalmemory.command_description",
			),
		});

/**
 * Rule 1: JSDoc comment for exported function
 * Removes a personal memory from the user's record in the users table using a paginated embed.
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
	// 1. Ensure command is run in a guild context to check server settings (Rule 17)
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
	let personalizationDisabledWarning = false; // Flag to check if warning needed

	try {
		// 2. Defer reply ephemerally (User Request)
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		// 3. Load server's Tomori state to check personalization setting (Rule 17)
		tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.not_setup_title", // Corrected key
				descriptionKey: "general.errors.not_setup_description", // Corrected key
				color: ColorCode.ERROR,
			});
			return;
		}

		// Check if personalization is disabled *before* showing choices
		// biome-ignore lint/style/noNonNullAssertion: tomoriState checked earlier
		if (!tomoriState!.config.personal_memories_enabled) {
			personalizationDisabledWarning = true;
		}

		// 4. Get the user's current personal memories from userData
		const currentMemories = userData.personal_memories ?? [];

		// 5. Check if there are any memories to remove
		if (currentMemories.length === 0) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.unlearn.personalmemory.no_memories_title",
				descriptionKey: "commands.unlearn.personalmemory.no_memories",
				color: ColorCode.WARN,
			});
			return;
		}

		// 6. Format memories for display, truncating long ones
		const displayItems = currentMemories.map((memory) => {
			return memory.length > DISPLAY_TRUNCATE_LENGTH
				? `${memory.slice(0, DISPLAY_TRUNCATE_LENGTH)}...`
				: memory;
		});

		// 7. Use the replyPaginatedChoices helper
		result = await replyPaginatedChoices(interaction, locale, {
			titleKey: "commands.unlearn.personalmemory.select_title",
			descriptionKey: "commands.unlearn.personalmemory.select_description",
			itemLabelKey: "commands.unlearn.personalmemory.memory_label",
			items: displayItems,
			color: ColorCode.INFO,
			flags: MessageFlags.Ephemeral, // Make the pagination ephemeral

			// Use simplified signature as expected by PaginatedChoiceOptions
			onSelect: async (selectedIndex: number) => {
				// 8. Get the memory to delete
				const memoryToRemove = currentMemories[selectedIndex];

				// 9. Create new array without the selected memory
				const updatedMemories = currentMemories.filter(
					(_, index) => index !== selectedIndex,
				);

				// 10. Format array for PostgreSQL update (Rule 23)
				const memoriesArrayLiteral = `{${updatedMemories
					.map((item) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
					.join(",")}}`;

				// 11. Update the user's row in the database using Bun SQL (Rule 4, 15)
				// Remember: No type parameters needed for sql template literal
				const [updatedUserResult] = await sql`
                    UPDATE users
                    SET personal_memories = ${memoriesArrayLiteral}::text[]
                    WHERE user_id = ${userData.user_id}
                    RETURNING *
                `;

				// 12. Validate the returned (updated) data (Rule 3, 5, 6)
				const validationResult = userSchema.safeParse(updatedUserResult);

				if (!validationResult.success || !updatedUserResult) {
					// Log error specific to this update failure
					const context: ErrorContext = {
						userId: userData.user_id,
						serverId: tomoriState?.server_id, // Include server context
						tomoriId: tomoriState?.tomori_id, // Include tomori context
						errorType: "DatabaseUpdateError",
						metadata: {
							command: "teach personalmemory",
							table: "users",
							column: "personal_memories",
							operation: "UPDATE",
							userDiscordId: interaction.user.id,
							memoryToRemove,
							validationErrors: validationResult.success
								? null
								: validationResult.error.flatten(),
						},
					};
					// Throw error to be caught by replyPaginatedChoices's handler
					throw await log.error(
						"Failed to update or validate user data after deleting personal memory",
						validationResult.success
							? new Error("Database update returned no rows or unexpected data")
							: new Error("Updated user data failed validation"),
						context,
					);
				}

				// 13. Log success (onSelect doesn't handle user feedback directly)
				log.success(
					`Deleted personal memory "${memoryToRemove.slice(0, 30)}..." for user ${userData.user_disc_id} (ID: ${userData.user_id})`,
				);
				// The replyPaginatedChoices helper will show the success message
				// We will add the warning follow-up outside this callback if needed
			},

			// Simplified onCancel handler as expected by PaginatedChoiceOptions
			onCancel: async () => {
				// This runs if the user clicks Cancel
				log.info(
					`User ${userData.user_disc_id} cancelled deleting a personal memory.`,
				);
				// The replyPaginatedChoices helper will show the cancellation message
			},
		});

		// 14. Handle potential errors/timeouts from the helper itself
		if (!result.success && result.reason === "error") {
			log.warn(
				`replyPaginatedChoices reported an error for user ${userData.user_disc_id} in /teach personalmemory`,
			);
		} else if (!result.success && result.reason === "timeout") {
			log.warn(
				`Personal memory deletion timed out for user ${userData.user_disc_id}`,
			);
		}

		// 15. If deletion was successful AND personalization is disabled, send a follow-up warning
		if (result.success && personalizationDisabledWarning) {
			// Use the ORIGINAL interaction for the followUp, as the helper manages its own interaction lifecycle
			await interaction.followUp({
				embeds: [
					createStandardEmbed(locale, {
						// Use the imported function
						titleKey: "commands.unlearn.personalmemory.warning_disabled_title",
						descriptionKey:
							"commands.unlearn.personalmemory.warning_disabled_description",
						color: ColorCode.WARN,
					}),
				],
				flags: MessageFlags.Ephemeral, // Keep it ephemeral
			});
		}
	} catch (error) {
		// 16. Catch unexpected errors
		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: tomoriState?.server_id,
			tomoriId: tomoriState?.tomori_id,
			errorType: "CommandExecutionError",
			metadata: {
				command: "teach personalmemory",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
			},
		};
		await log.error(
			`Unexpected error in /teach personalmemory for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 17. Inform user of unknown error
		// Always use the original interaction for followUp in catch block
		if (interaction.deferred || interaction.replied) {
			try {
				await interaction.followUp({
					// Use interaction.followUp
					content: localizer(
						locale,
						"general.errors.unknown_error_description",
					),
					flags: MessageFlags.Ephemeral,
				});
			} catch (followUpError) {
				log.error(
					"Failed to send follow-up error message in personalmemory catch block",
					followUpError,
				);
			}
		} else {
			log.warn(
				"Initial interaction was not replied or deferred in personalmemory catch block",
				context,
			);
		}
	}
}
