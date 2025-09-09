import {
	MessageFlags,
	type ChatInputCommandInteraction,
	type ButtonInteraction,
	type ModalSubmitInteraction,
	type Client,
	type SlashCommandSubcommandBuilder,
} from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
	replyInfoEmbed,
	promptWithPaginatedModal,
	safeSelectOptionText,
} from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";
import {
	type UserRow,
	type ErrorContext,
	tomoriSchema,
	type TomoriState,
} from "../../types/db/schema";
import { sql } from "bun";
import type { SelectOption } from "../../types/discord/modal";

// Rule 20: Constants for static values at the top
const MODAL_CUSTOM_ID = "unlearn_sampledialogue_modal";
const DIALOGUE_SELECT_ID = "dialogue_select";

/**
 * Helper function to perform sample dialogue removal from database
 * @param tomoriState - Current Tomori state
 * @param selectedIndex - Index of the dialogue pair to remove
 * @param currentIn - Current input dialogues array
 * @param currentOut - Current output dialogues array
 * @param userData - User data
 * @param replyInteraction - Interaction to reply to (can be modal or pagination)
 * @param locale - User locale
 */
async function performSampleDialogueRemoval(
	tomoriState: TomoriState,
	selectedIndex: number,
	currentIn: string[],
	currentOut: string[],
	userData: UserRow,
	replyInteraction:
		| ChatInputCommandInteraction
		| ButtonInteraction
		| ModalSubmitInteraction,
	locale: string,
): Promise<void> {
	// Get the item being removed
	const itemToRemoveIn = currentIn[selectedIndex];
	const itemToRemoveOut = currentOut[selectedIndex];

	// Update both arrays in the database using array_remove for atomic operations
	const [updatedRow] = await sql`
		UPDATE tomoris
		SET
			sample_dialogues_in = array_remove(sample_dialogues_in, ${itemToRemoveIn}),
			sample_dialogues_out = array_remove(sample_dialogues_out, ${itemToRemoveOut})
		WHERE tomori_id = ${tomoriState.tomori_id}
		RETURNING *
	`;

	// Validate the returned data
	const validatedTomori = tomoriSchema.safeParse(updatedRow);

	if (!validatedTomori.success || !updatedRow) {
		// Log error specific to this update failure
		const context: ErrorContext = {
			tomoriId: tomoriState.tomori_id,
			serverId: tomoriState.server_id,
			userId: userData.user_id,
			errorType: "DatabaseUpdateError",
			metadata: {
				command: "unlearn sampledialogue",
				selectedIndex,
				validationErrors: validatedTomori.success
					? null
					: validatedTomori.error.flatten(),
			},
		};

		await log.error(
			"Failed to update or validate sample_dialogues in tomoris table",
			validatedTomori.success
				? new Error("Database update returned no rows or unexpected data")
				: new Error("Updated tomori data failed validation"),
			context,
		);

		await replyInfoEmbed(replyInteraction, locale, {
			titleKey: "general.errors.update_failed_title",
			descriptionKey: "general.errors.update_failed_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	// Log success and show success message
	log.success(
		`Removed sample dialogue pair at index ${selectedIndex} for tomori ${tomoriState.tomori_id} by user ${userData.user_disc_id}`,
	);

	await replyInfoEmbed(replyInteraction, locale, {
		titleKey: "commands.unlearn.sampledialogue.success_title",
		descriptionKey: "commands.unlearn.sampledialogue.success_description",
		descriptionVars: {
			input:
				itemToRemoveIn.length > 50
					? `${itemToRemoveIn.slice(0, 50)}...`
					: itemToRemoveIn,
			output:
				itemToRemoveOut.length > 50
					? `${itemToRemoveOut.slice(0, 50)}...`
					: itemToRemoveOut,
		},
		color: ColorCode.SUCCESS,
	});
}

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("sampledialogue")
		.setDescription(
			localizer("en-US", "commands.unlearn.sampledialogue.description"),
		);

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
	// 1. Ensure command is run in a valid channel context
	if (!interaction.channel) {
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.channel_only_title",
			descriptionKey: "general.errors.channel_only_description",
			color: ColorCode.ERROR,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Define state and result variables outside try for catch block context
	let tomoriState: TomoriState | null = null;

	try {
		// 2. Load server's Tomori state (Rule 17)
		tomoriState = await loadTomoriState(
			interaction.guild?.id ?? interaction.user.id,
		);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
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
				titleKey: "commands.teach.sampledialogue.teaching_disabled_title",
				descriptionKey:
					"commands.teach.sampledialogue.teaching_disabled_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
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
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 7. Create dialogue select options for the modal
		const dialogueSelectOptions: SelectOption[] = currentIn.map(
			(input, index) => {
				const output = currentOut[index];
				const truncatedInput = safeSelectOptionText(input, 50);
				const truncatedOutput = safeSelectOptionText(output, 50);
				//const fullDisplay = `User: "${truncatedInput}" → Bot: "${truncatedOutput}"`;

				return {
					label: safeSelectOptionText(truncatedInput),
					value: index.toString(),
					description: safeSelectOptionText(truncatedOutput),
				};
			},
		);

		// 8. Show the paginated modal with dialogue selection
		const modalResult = await promptWithPaginatedModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.unlearn.sampledialogue.modal_title",
			components: [
				{
					customId: DIALOGUE_SELECT_ID,
					labelKey: "commands.unlearn.sampledialogue.select_label",
					descriptionKey: "commands.unlearn.sampledialogue.select_description",
					placeholder: "commands.unlearn.sampledialogue.select_placeholder",
					required: true,
					options: dialogueSelectOptions,
				},
			],
		});

		// 9. Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Sample dialogue deletion modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// 10. Extract values from the modal
		const modalSubmitInteraction = modalResult.interaction;
		const selectedIndexStr = modalResult.values?.[DIALOGUE_SELECT_ID];

		// Safety checks (should never be null after submit outcome)
		if (!modalSubmitInteraction || !selectedIndexStr) {
			log.error("Modal result unexpectedly missing interaction or values");
			return;
		}

		const selectedIndex = Number.parseInt(selectedIndexStr, 10);

		// 11. Perform the database update using the helper function - let helper manage interaction state
		await performSampleDialogueRemoval(
			tomoriState,
			selectedIndex,
			currentIn,
			currentOut,
			userData,
			modalSubmitInteraction,
			locale,
		);
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
