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
import type { ModalResult } from "../../types/discord/modal";

// Rule 20: Constants (Modal IDs, Input IDs)
const MODAL_CUSTOM_ID = "teach_attribute_add_modal";
const ATTRIBUTE_INPUT_ID = "attribute_input";
const ATTRIBUTE_MAX_LENGTH = 256; // Define a max length for attributes

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("attribute")
		.setDescription(
			localizer("en-US", "commands.teach.attribute.description"),
		);

/**
 * Rule 1: JSDoc comment for exported function
 * Adds a personality attribute to Tomori's memory for the server.
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
			flags: MessageFlags.Ephemeral, // Explicit flag needed before deferral
		});
		return;
	}

	// Define state and modal result outside try for catch block
	let tomoriState: TomoriState | null = null;
	let modalResult: ModalResult | null = null;

	try {
		// 3. Load server's Tomori state (Rule 17)
		tomoriState = await loadTomoriState(interaction.guild.id);

		// 4. Check if Tomori is set up
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.not_setup_title",
				descriptionKey: "general.errors.not_setup_description",
				color: ColorCode.ERROR,
				// No flags needed due to deferReply
			});
			return;
		}

		// 5. Check if attribute teaching is enabled (Assuming config key exists)
		// Check if user has Manage Server permission - admins can bypass teaching restriction
		const hasManagePermission =
			interaction.memberPermissions?.has("ManageGuild") ?? false;

		// Check if attribute teaching is enabled and if user has bypass permissions
		// TODO: Verify/add 'attribute_memteaching_enabled' to ConfigRow and tomoriConfigSchema
		if (
			!tomoriState.config.attribute_memteaching_enabled &&
			!hasManagePermission
		) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.teach.attribute.teaching_disabled_title", // New locale key needed
				descriptionKey:
					"commands.teach.attribute.teaching_disabled_description", // New locale key needed
				color: ColorCode.ERROR,
				// No flags needed
			});
			return;
		}

		// 6. Prompt user with a modal (Rule 10, 12, 19)
		// NOTE: Ensure locale keys resolve to strings <= 45 chars for labels!
		modalResult = await promptWithModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.teach.attribute.modal_title", // New locale key
			inputs: [
				{
					customId: ATTRIBUTE_INPUT_ID,
					labelKey: "commands.teach.attribute.attribute_input_label", // New locale key (<= 45 chars)
					style: TextInputStyle.Paragraph, // Allow longer attributes
					required: true,
					maxLength: ATTRIBUTE_MAX_LENGTH, // Set a max length
				},
			],
		});

		// 7. Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Attribute add modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			// promptWithModal handles cancel/timeout replies
			return;
		}

		// Capture the ModalSubmitInteraction
		// biome-ignore lint/style/noNonNullAssertion: Outcome 'submit' guarantees interaction
		const modalSubmitInteraction = modalResult.interaction!;

		// ADD THIS LINE: Defer the modal submission interaction
		await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });

		// 8. Get input from modal
		// biome-ignore lint/style/noNonNullAssertion: Outcome 'submit' + required=true guarantees value
		const newAttribute = modalResult.values![ATTRIBUTE_INPUT_ID];

		// 9. Prepare updated array (Access directly from tomoriState)
		const currentAttributes = tomoriState.attribute_list || [];

		// Optional: Check for duplicates before adding
		if (currentAttributes.includes(newAttribute)) {
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "commands.teach.attribute.duplicate_title", // New locale key
				descriptionKey: "commands.teach.attribute.duplicate_description", // New locale key
				descriptionVars: { attribute: newAttribute },
				color: ColorCode.WARN,
				// No flags needed
			});
			return;
		}

		// 11. Update Tomori row in the database using array_append (Rule 4, 15, 23)
		const [updatedTomoriResult] = await sql`
			UPDATE tomoris
			SET attribute_list = array_append(attribute_list, ${newAttribute})
			WHERE tomori_id = ${tomoriState.tomori_id}
			RETURNING *
		`;

		// 12. Validate the result from the database (Rule 3, 5, 6)
		const validationResult = tomoriSchema.safeParse(updatedTomoriResult);

		if (!validationResult.success) {
			// Rule 22: Log error with context
			const context: ErrorContext = {
				userId: userData.user_id,
				serverId: tomoriState.server_id,
				tomoriId: tomoriState.tomori_id,
				errorType: "DatabaseValidationError",
				metadata: {
					command: "teach attribute",
					userDiscordId: interaction.user.id, // Keep Discord ID for easier user lookup
					newAttribute,
					validationErrors: validationResult.error.issues,
				},
			};
			await log.error(
				"Failed to validate updated tomori data after adding attribute",
				validationResult.error,
				context,
			);

			// Use modal interaction for reply
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
				// No flags needed
			});
			return;
		}

		// 13. Success! Confirm addition (Rule 12, 19)
		await replyInfoEmbed(modalSubmitInteraction, locale, {
			titleKey: "commands.teach.attribute.success_title", // New locale key
			descriptionKey: "commands.teach.attribute.success_description", // New locale key
			descriptionVars: {
				attribute: newAttribute,
			},
			color: ColorCode.SUCCESS,
			// No flags needed
		});
	} catch (error) {
		// Rule 22: Log error with context
		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: tomoriState?.server_id, // Use optional chaining as tomoriState might be null if error happened early
			tomoriId: tomoriState?.tomori_id,
			errorType: "CommandExecutionError",
			metadata: {
				command: "teach attribute",
				userDiscordId: interaction.user.id,
				guildId: interaction.guild?.id,
			},
		};
		await log.error("Error in /teach attribute command", error, context);

		// Rule 12, 19: Reply with unknown error embed
		// Determine which interaction to use
		const errorReplyInteraction =
			modalResult?.interaction ?? // Prefer modal interaction
			(interaction.replied || interaction.deferred ? interaction : null); // Fallback

		if (errorReplyInteraction) {
			await replyInfoEmbed(errorReplyInteraction, locale, {
				titleKey: "general.errors.unknown_error_title",
				descriptionKey: "general.errors.unknown_error_description",
				color: ColorCode.ERROR,
				// No flags needed
			});
		} else {
			log.warn(
				"Interaction was not replied or deferred in attribute catch block, cannot send error message to user.",
				context,
			);
		}
	}
}
