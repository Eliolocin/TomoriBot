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
	promptWithModal,
} from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";

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
			localizer("en-US", "commands.teach.sampledialogue.command_description"), // Rule 9
		)
		.setDescriptionLocalizations({
			ja: localizer("ja", "commands.teach.sampledialogue.command_description"),
		});

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
	// 1. Ensure command is run in a guild context (Rule 17)
	if (!interaction.guild) {
		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only",
			color: ColorCode.ERROR,
			flags: MessageFlags.Ephemeral, // User Request
		});
		return;
	}

	try {
		// 2. Load server's Tomori state (Rule 17)
		const tomoriState: TomoriState | null = await loadTomoriState(
			interaction.guild.id,
		);

		// 3. Check if Tomori is set up and if sample dialogue teaching is enabled
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.not_setup_title",
				descriptionKey: "general.errors.not_setup_description",
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
			hasManagePermission
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

		// 4. Prompt user with a modal (Rule 10, 12, 19)
		// NOTE: Ensure locale keys resolve to strings <= 45 chars for labels!
		const modalResult = await promptWithModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.teach.sampledialogue.modal_title",
			inputs: [
				{
					customId: USER_INPUT_ID,
					// Ensure this locale key's value is <= 45 chars
					labelKey: "commands.teach.sampledialogue.user_input_label",
					style: TextInputStyle.Paragraph,
					required: true,
				},
				{
					customId: BOT_INPUT_ID,
					// Ensure this locale key's value is <= 45 chars
					labelKey: "commands.teach.sampledialogue.bot_input_label",
					style: TextInputStyle.Paragraph,
					required: true,
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

		// ADD THIS LINE: Immediately defer the modal submission interaction (Rule 25)
		await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });

		// 6. Get inputs from modal
		// biome-ignore lint/style/noNonNullAssertion: Modal submit + required=true guarantees values exist
		const userInput = modalResult.values![USER_INPUT_ID];
		// biome-ignore lint/style/noNonNullAssertion: Modal submit + required=true guarantees values exist
		const botInput = modalResult.values![BOT_INPUT_ID];

		// 7. Prepare updated arrays (Access directly from tomoriState)
		const currentIn = tomoriState.sample_dialogues_in || [];
		const currentOut = tomoriState.sample_dialogues_out || [];

		const updatedIn = [...currentIn, userInput];
		const updatedOut = [...currentOut, botInput];

		// 8. Format arrays for PostgreSQL update (Rule 23)
		const inArrayLiteral = `{${updatedIn
			.map((item) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;
		const outArrayLiteral = `{${updatedOut
			.map((item) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;

		// 9. Update Tomori row in the database using Bun SQL (Rule 4, 15)
		// Access tomori_id directly from tomoriState
		const [updatedTomoriResult] = await sql`
            UPDATE tomoris
            SET
                sample_dialogues_in = ${inArrayLiteral}::text[],
                sample_dialogues_out = ${outArrayLiteral}::text[]
            WHERE tomori_id = ${
							// biome-ignore lint/style/noNonNullAssertion: tomoriState check guarantees tomori_id
							tomoriState.tomori_id!
						}
            RETURNING *
        `;

		// 10. Validate the result from the database (Rule 3, 5, 6)
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

		// 11. Success! Confirm addition (Rule 12, 19)
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
