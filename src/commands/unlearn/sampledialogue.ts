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
		.setName("sampledialogue")
		.setDescription(
			localizer("en-US", "commands.unlearn.sampledialogue.command_description"),
		)
		.setDescriptionLocalizations({
			ja: localizer(
				"ja",
				"commands.unlearn.sampledialogue.command_description",
			),
		});

/**
 * Rule 1: JSDoc comment for exported function
 * Removes a sample dialogue pair from Tomori's memory using a paginated embed
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

		// 4. Check if teaching is enabled - FIX: Access through config object
		if (
			!tomoriState.config.sampledialogue_memteaching_enabled &&
			!hasManagePermission
		) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.unlearn.sampledialogueadd.teaching_disabled_title",
				descriptionKey:
					"commands.unlearn.sampledialogueadd.teaching_disabled_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 5. Get the current dialogue pairs
		const currentIn = tomoriState.sample_dialogues_in ?? [];
		const currentOut = tomoriState.sample_dialogues_out ?? [];

		// 6. Check if there are any dialogues to remove or if arrays mismatch
		if (currentIn.length === 0 || currentIn.length !== currentOut.length) {
			if (currentIn.length !== currentOut.length) {
				log.warn(
					`Sample dialogue array length mismatch for tomori ${tomoriState.tomori_id} (in: ${currentIn.length}, out: ${currentOut.length})`,
				);
			}
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.unlearn.sampledialogue.no_dialogues_title",
				descriptionKey: "commands.unlearn.sampledialogue.no_dialogues",
				color: ColorCode.WARN,
			});
			return;
		}

		// 7. Format dialogue pairs for display, truncating long ones
		const displayItems = currentIn.map((input, index) => {
			const output = currentOut[index]; // Get corresponding output
			const truncatedInput =
				input.length > DISPLAY_TRUNCATE_LENGTH
					? `${input.slice(0, DISPLAY_TRUNCATE_LENGTH)}...`
					: input;
			const truncatedOutput =
				output.length > DISPLAY_TRUNCATE_LENGTH
					? `${output.slice(0, DISPLAY_TRUNCATE_LENGTH)}...`
					: output;
			// Format for display in the selection list
			return `User: "${truncatedInput}" → Bot: "${truncatedOutput}"`;
		});

		// 8. Use the replyPaginatedChoices helper
		// FIX: Simplify onSelect and onCancel signatures to match what's expected
		result = await replyPaginatedChoices(interaction, locale, {
			titleKey: "commands.unlearn.sampledialogue.select_title",
			descriptionKey: "commands.unlearn.sampledialogue.select_description",
			itemLabelKey: "commands.unlearn.sampledialogue.dialogue_label",
			items: displayItems,
			color: ColorCode.INFO,
			flags: MessageFlags.Ephemeral, // Make the pagination ephemeral

			// FIX: Simplify to match expected signature (index: number) => Promise<void>
			onSelect: async (selectedIndex: number) => {
				// 9. Get the item being removed
				const itemToRemoveIn = currentIn[selectedIndex];
				const itemToRemoveOut = currentOut[selectedIndex];

				// 10. Update both arrays in the database using array_remove for atomic operations (Rule 23)
				const [updatedRow] = await sql`
					UPDATE tomoris
					SET
						sample_dialogues_in = array_remove(sample_dialogues_in, ${itemToRemoveIn}),
						sample_dialogues_out = array_remove(sample_dialogues_out, ${itemToRemoveOut})
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
							command: "teach sampledialogue",
							guildId: interaction.guild?.id,
							selectedIndex,
							validationErrors: validatedTomori.success
								? null
								: validatedTomori.error.flatten(),
						},
					};
					// Throw error to be caught by replyPaginatedChoices's handler
					throw await log.error(
						"Failed to update or validate sample_dialogues in tomoris table",
						validatedTomori.success
							? new Error("Database update returned no rows or unexpected data")
							: new Error("Updated tomori data failed validation"),
						context,
					);
				}

				// 13. Log success (onSelect doesn't handle user feedback directly)

				log.success(
					`Removed sample dialogue pair at index ${selectedIndex} for tomori ${
						// biome-ignore lint/style/noNonNullAssertion: tomoriState check above guarantees tomori_id exists
						tomoriState!.tomori_id
					} by user ${userData.user_disc_id}`,
				);
				// The replyPaginatedChoices helper will show the success message
			},

			// FIX: Simplify to match expected signature () => Promise<void>
			onCancel: async () => {
				// This runs if the user clicks Cancel

				log.info(
					`User ${userData.user_disc_id} cancelled removing a sample dialogue for tomori ${
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
				`replyPaginatedChoices reported an error for user ${userData.user_disc_id} in /teach sampledialogue`,
			);
		} else if (!result.success && result.reason === "timeout") {
			log.warn(
				`Sample dialogue removal timed out for user ${userData.user_disc_id} (Tomori ID: ${
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
				command: "teach sampledialogue",
				guildId: interaction.guild?.id,
				executorDiscordId: interaction.user.id,
			},
		};
		await log.error(
			`Unexpected error in /teach sampledialogue for user ${userData.user_disc_id}`,
			error as Error,
			context,
		);

		// 16. Inform user of unknown error
		// FIX: PaginatedChoiceResult doesn't have an interaction property
		// Just use the original interaction since it was deferred
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
					"Failed to send follow-up error message in sampledialogue catch block",
					followUpError,
				);
			}
		} else {
			log.warn(
				"Could not determine valid interaction to send error message in sampledialogue catch block",
			);
		}
	}
}
