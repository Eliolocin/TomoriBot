import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
} from "discord.js";
import { MessageFlags, TextInputStyle } from "discord.js";
import { sql } from "bun";
import {
	tomoriSchema, // Use tomoriSchema for validation
	type UserRow,
	type ErrorContext,
	type TomoriState,
} from "../../types/db/schema";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import {
	replyInfoEmbed,
	promptWithRawModal,
} from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";
import { checkSampleDialogueLimit } from "../../utils/db/memoryLimits";

// Rule 20: Constants (Modal IDs, Input IDs)
const MODAL_CUSTOM_ID = "teach_sampledialogue_add_modal";
const USER_INPUT_ID = "user_input";
const BOT_INPUT_ID = "bot_input";

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("sampledialogue")
		.setDescription(
			localizer("en-US", "commands.teach.sampledialogue.description"),
		);

/**
 * Rule 1: JSDoc comment for exported function
 * Adds a sample dialogue pair to Tomori's memory for the server.
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
	// 1. Ensure command is run in a valid channel context (Rule 17)
	if (!interaction.channel) {
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.channel_only_title",
			descriptionKey: "general.errors.channel_only_description",
			color: ColorCode.ERROR,
			flags: MessageFlags.Ephemeral, // User Request
		});
		return;
	}

	try {
		// 2. Load server's Tomori state (Rule 17)
		const tomoriState: TomoriState | null = await loadTomoriState(
			interaction.guild?.id ?? interaction.user.id,
		);

		// 3. Check if Tomori is set up and if sample dialogue teaching is enabled
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
		// Access config directly from tomoriState
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

		// 4. Check sample dialogue limit before showing modal (better UX)
		if (!tomoriState.tomori_id) {
			log.error("TomoriState missing tomori_id - this should never happen");
			return;
		}
		const dialogueLimitCheck = await checkSampleDialogueLimit(
			tomoriState.tomori_id,
		);
		if (!dialogueLimitCheck.isValid) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.teach.sampledialogue.limit_exceeded_title",
				descriptionKey:
					"commands.teach.sampledialogue.limit_exceeded_description",
				descriptionVars: {
					current_count: dialogueLimitCheck.currentCount?.toString() || "0",
					max_allowed: (dialogueLimitCheck.maxAllowed || 10).toString(),
				},
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 5. Prompt user with a modal with Component Type 18 support (Rule 10, 12, 19)
		// NOTE: Ensure locale keys resolve to strings <= 45 chars for labels!
		const modalResult = await promptWithRawModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.teach.sampledialogue.modal_title",
			components: [
				{
					customId: USER_INPUT_ID,
					// Ensure this locale key's value is <= 45 chars
					labelKey: "commands.teach.sampledialogue.user_input_label",
					descriptionKey:
						"commands.teach.sampledialogue.user_input_description",
					placeholder: "commands.teach.sampledialogue.user_input_placeholder",
					style: TextInputStyle.Paragraph,
					required: true,
					maxLength: 1000,
				},
				{
					customId: BOT_INPUT_ID,
					// Ensure this locale key's value is <= 45 chars
					labelKey: "commands.teach.sampledialogue.bot_input_label",
					descriptionKey: "commands.teach.sampledialogue.bot_input_description",
					placeholder: "commands.teach.sampledialogue.bot_input_placeholder",
					style: TextInputStyle.Paragraph,
					required: true,
					maxLength: 1000,
				},
			],
		});

		// 5. Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Sample dialogue add modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// biome-ignore lint/style/noNonNullAssertion: Modal submit guarantees interaction exists
		const modalSubmitInteraction = modalResult.interaction!;

		// 6. Get inputs from modal - let helper functions manage interaction state
		// biome-ignore lint/style/noNonNullAssertion: Modal submit + required=true guarantees values exist
		const userInput = modalResult.values![USER_INPUT_ID];
		// biome-ignore lint/style/noNonNullAssertion: Modal submit + required=true guarantees values exist
		const botInput = modalResult.values![BOT_INPUT_ID];

		// 8. Update Tomori row in the database using Bun SQL (Rule 4, 15, 23)
		// Use array_append for atomic array operations
		const [updatedTomoriResult] = await sql`
			UPDATE tomoris
			SET
				sample_dialogues_in = array_append(sample_dialogues_in, ${userInput}),
				sample_dialogues_out = array_append(sample_dialogues_out, ${botInput})
			WHERE tomori_id = ${tomoriState.tomori_id}
			RETURNING *
		`;

		// 9. Validate the result from the database (Rule 3, 5, 6)
		// Note: tomoriSchema validates a TomoriRow, not the full TomoriState
		const validationResult = tomoriSchema.safeParse(updatedTomoriResult);

		if (!validationResult.success) {
			// Rule 22: Log error with context (Access IDs directly)
			const context: ErrorContext = {
				userId: userData.user_id,
				serverId: tomoriState.server_id, // Direct access
				tomoriId: tomoriState.tomori_id, // Direct access
				errorType: "DatabaseValidationError",
				metadata: {
					command: "teach sampledialogue",
					userDiscordId: interaction.user.id,
					validationErrors: validationResult.error.issues,
				},
			};
			await log.error(
				"Failed to validate updated tomori data after adding sample dialogue",
				validationResult.error,
				context,
			);

			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 10. Success! Confirm addition (Rule 12, 19)
		await replyInfoEmbed(modalSubmitInteraction, locale, {
			titleKey: "commands.teach.sampledialogue.success_title",
			descriptionKey: "commands.teach.sampledialogue.success_description",
			descriptionVars: {
				user_input:
					userInput.length > 96 ? `${userInput.slice(0, 96)}...` : userInput,
				bot_input:
					botInput.length > 96 ? `${botInput.slice(0, 96)}...` : botInput,
			},
			color: ColorCode.SUCCESS,
			flags: MessageFlags.Ephemeral,
		});
	} catch (error) {
		// Rule 22: Log error with context
		const context: ErrorContext = {
			userId: userData.user_id,
			errorType: "CommandExecutionError",
			metadata: {
				command: "teach sampledialogue",
				userDiscordId: interaction.user.id,
				guildId: interaction.guild?.id,
			},
		};
		await log.error("Error in /teach sampledialogue command", error, context);

		if (interaction.replied || interaction.deferred) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.unknown_error_title",
				descriptionKey: "general.errors.unknown_error_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
		} else {
			log.warn(
				"Interaction was not replied or deferred in sampledialogue, cannot send error message to user.",
				context,
			);
		}
	}
}
