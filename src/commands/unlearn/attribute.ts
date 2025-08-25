import {
	MessageFlags,
	type ChatInputCommandInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
	replyInfoEmbed,
	replyPaginatedChoices,
} from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";
import {
	type UserRow,
	type ErrorContext,
	tomoriSchema,
	type TomoriState,
} from "../../types/db/schema";
import { sql } from "bun";
import type { PaginatedChoiceResult } from "@/types/discord/embed";

// Rule 20: Constants for static values at the top
const DISPLAY_TRUNCATE_LENGTH = 45; // Max length for each part in the display list

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("attribute")
		.setDescription(
			localizer("en-US", "commands.unlearn.attribute.description"),
		);

/**
 * Rule 1: JSDoc comment for exported function
 * Removes a personality attribute from Tomori's memory using a paginated embed
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
	// 1. Ensure command is run in a guild context
	if (!interaction.guild || !interaction.channel) {
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

		// 3. Load server's Tomori state (Rule 17)
		tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.not_setup_title",
				descriptionKey: "general.errors.not_setup_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// Check if user has Manage Server permission - admins can bypass teaching restriction
		const hasManagePermission =
			interaction.memberPermissions?.has("ManageGuild") ?? false;

		// 4. Check if teaching is enabled
		if (
			!tomoriState.config.attribute_memteaching_enabled &&
			!hasManagePermission
		) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.unlearn.attributeadd.teaching_disabled_title",
				descriptionKey:
					"commands.unlearn.attributeadd.teaching_disabled_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 5. Get the current attribute list
		const currentAttributes = tomoriState.attribute_list ?? [];

		// 6. Check if there are any attributes to remove
		if (currentAttributes.length === 0) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.unlearn.attribute.no_attributes_title",
				descriptionKey: "commands.unlearn.attribute.no_attributes",
				color: ColorCode.WARN,
			});
			return;
		}

		// 7. Format attributes for display, truncating long ones
		const displayItems = currentAttributes.map((attribute) => {
			return attribute.length > DISPLAY_TRUNCATE_LENGTH
				? `${attribute.slice(0, DISPLAY_TRUNCATE_LENGTH)}...`
				: attribute;
		});

		// 8. Use the replyPaginatedChoices helper
		result = await replyPaginatedChoices(interaction, locale, {
			titleKey: "commands.unlearn.attribute.select_title",
			descriptionKey: "commands.unlearn.attribute.select_description",
			itemLabelKey: "commands.unlearn.attribute.attribute_label",
			items: displayItems,
			color: ColorCode.INFO,
			flags: MessageFlags.Ephemeral, // Make the pagination ephemeral

			// Use simplified signature as expected by PaginatedChoiceOptions
			onSelect: async (selectedIndex: number) => {
				// 9. Get the attribute to remove
				const attributeToRemove = currentAttributes[selectedIndex];

				// 10. Update the attribute_list in the database using array_remove (Rule 4, 15, 23)
				const [updatedRow] = await sql`
					UPDATE tomoris
					SET attribute_list = array_remove(attribute_list, ${attributeToRemove})
					WHERE tomori_id = ${
						// biome-ignore lint/style/noNonNullAssertion: tomoriState check above guarantees tomori_id exists
						tomoriState!.tomori_id
					}
					RETURNING *
				`;

				// 12. Validate the returned data (Rule 3, 5, 6)
				const validatedTomori = tomoriSchema.safeParse(updatedRow);

				if (!validatedTomori.success || !updatedRow) {
					// Log error specific to this update failure
					const context: ErrorContext = {
						// biome-ignore lint/style/noNonNullAssertion: tomoriState check above guarantees these IDs exist
						tomoriId: tomoriState!.tomori_id,
						// biome-ignore lint/style/noNonNullAssertion: tomoriState check above guarantees these IDs exist
						serverId: tomoriState!.server_id,
						userId: userData.user_id,
						errorType: "DatabaseUpdateError",
						metadata: {
							command: "teach attribute",
							guildId: interaction.guild?.id,
							selectedIndex,
							attributeToRemove,
							validationErrors: validatedTomori.success
								? null
								: validatedTomori.error.flatten(),
						},
					};
					// Throw error to be caught by replyPaginatedChoices's handler
					throw await log.error(
						"Failed to update or validate attribute_list in tomoris table",
						validatedTomori.success
							? new Error("Database update returned no rows or unexpected data")
							: new Error("Updated tomori data failed validation"),
						context,
					);
				}

				// 13. Log success (onSelect doesn't handle user feedback directly)
				log.success(
					`Removed attribute "${attributeToRemove}" for tomori ${
						// biome-ignore lint/style/noNonNullAssertion: tomoriState check above guarantees tomori_id exists
						tomoriState!.tomori_id
					} by user ${userData.user_disc_id}`,
				);
				// The replyPaginatedChoices helper will show the success message
			},

			// Simplified onCancel handler as expected by PaginatedChoiceOptions
			onCancel: async () => {
				// This runs if the user clicks Cancel
				log.info(
					`User ${userData.user_disc_id} cancelled removing an attribute for tomori ${
						// biome-ignore lint/style/noNonNullAssertion: tomoriState check above guarantees tomori_id exists
						tomoriState!.tomori_id
					}`,
				);
				// The replyPaginatedChoices helper will show the cancellation message
			},
		});

		// 14. Handle potential errors from the helper itself
		if (!result.success && result.reason === "error") {
			log.warn(
				`replyPaginatedChoices reported an error for user ${userData.user_disc_id} in /teach attribute`,
			);
		} else if (!result.success && result.reason === "timeout") {
			log.warn(
				`Attribute removal timed out for user ${userData.user_disc_id} (Tomori ID: ${
					// biome-ignore lint/style/noNonNullAssertion: tomoriState check above guarantees tomori_id exists
					tomoriState!.tomori_id
				})`,
			);
		}
	} catch (error) {
		// 15. Catch unexpected errors
		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: tomoriState?.server_id,
			tomoriId: tomoriState?.tomori_id,
			errorType: "CommandExecutionError",
			metadata: {
				command: "teach attribute",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
			},
		};
		await log.error(
			`Unexpected error in /teach attribute for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 16. Inform user of unknown error
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
					"Failed to send follow-up error message in attribute catch block",
					followUpError,
				);
			}
		} else {
			log.warn(
				"Could not determine valid interaction to send error message in attribute catch block",
			);
		}
	}
}
