import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
	ModalSubmitInteraction,
} from "discord.js";
import { MessageFlags, TextInputStyle } from "discord.js";
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
	promptWithModal,
} from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";
import type { ModalResult } from "../../types/discord/modal";

// Rule 20: Constants for modal and input IDs
const MODAL_CUSTOM_ID = "teach_personalmemory_add_modal";
const MEMORY_INPUT_ID = "personal_memory_input";
const MEMORY_MAX_LENGTH = 512; // Max length for personal memories

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("personalmemory")
		.setDescription(
			localizer("en-US", "commands.teach.personalmemory.command_description"),
		)
		.setDescriptionLocalizations({
			ja: localizer("ja", "commands.teach.personalmemory.command_description"),
		});

/**
 * Rule 1: JSDoc comment for exported function
 * Adds a personal memory to the user's record in the users table.
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

	// Define state and modal result outside try for catch block
	let tomoriState: TomoriState | null = null;
	let modalResult: ModalResult | null = null;
	let modalSubmitInteraction: ModalSubmitInteraction | null = null;

	try {
		// 2. Load server's Tomori state to check personalization setting (Rule 17)
		// We need this even though we're updating the users table
		tomoriState = await loadTomoriState(interaction.guild.id);

		// 3. Check if Tomori is set up on the server (needed for config check)
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.not_setup_title",
				descriptionKey: "general.errors.not_setup_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 4. Prompt user with a modal (Rule 10, 12, 19, 25)
		modalResult = await promptWithModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.teach.personalmemory.modal_title",
			inputs: [
				{
					customId: MEMORY_INPUT_ID,
					labelKey: "commands.teach.personalmemory.memory_input_label",
					style: TextInputStyle.Paragraph,
					required: true,
					maxLength: MEMORY_MAX_LENGTH,
				},
			],
		});

		// 5. Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Personal memory add modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// 6. Capture and immediately defer the modal submission interaction (Rule 25)
		// biome-ignore lint/style/noNonNullAssertion: Outcome 'submit' guarantees interaction
		modalSubmitInteraction = modalResult.interaction!;
		await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });

		// 7. Get input from modal
		// biome-ignore lint/style/noNonNullAssertion: Outcome 'submit' + required=true guarantees value
		const newMemory = modalResult.values![MEMORY_INPUT_ID];

		// 8. Prepare updated array using data from userData
		const currentMemories = userData.personal_memories ?? [];

		// 9. Check for duplicates within the user's memories
		if (currentMemories.includes(newMemory)) {
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "commands.teach.personalmemory.duplicate_title",
				descriptionKey: "commands.teach.personalmemory.duplicate_description",
				descriptionVars: { memory: newMemory },
				color: ColorCode.WARN,
			});
			return;
		}

		// 10. Add the new memory to the list
		const updatedMemories = [...currentMemories, newMemory];

		// 11. Format array for PostgreSQL update (Rule 23)
		const memoriesArrayLiteral = `{${updatedMemories
			.map((item) => `"${item.replace(/(["\\])/g, "\\$1")}"`)
			.join(",")}}`;

		// 12. Update the user's row in the database using Bun SQL (Rule 4, 15)
		// Remember: No type parameters needed for sql template literal
		const [updatedUserResult] = await sql`
            UPDATE users
            SET personal_memories = ${memoriesArrayLiteral}::text[]
            WHERE user_id = ${userData.user_id}
            RETURNING *
        `;

		// 13. Validate the result from the database using userSchema (Rule 3, 5, 6)
		const validationResult = userSchema.safeParse(updatedUserResult);

		if (!validationResult.success) {
			// Rule 22: Log error with context
			const context: ErrorContext = {
				userId: userData.user_id,
				serverId: tomoriState.server_id, // Include server context
				tomoriId: tomoriState.tomori_id, // Include tomori context
				errorType: "DatabaseValidationError",
				metadata: {
					command: "teach personalmemory",
					table: "users",
					column: "personal_memories",
					operation: "UPDATE",
					userDiscordId: interaction.user.id,
					newMemoryContent: newMemory,
					validationErrors: validationResult.error.issues,
				},
			};
			await log.error(
				"Failed to validate updated user data after adding personal memory",
				validationResult.error,
				context,
			);

			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.update_failed_title",
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 14. Check if personalization is disabled on this server and prepare message
		let descriptionKey = "commands.teach.personalmemory.success_description";
		let embedColor = ColorCode.SUCCESS;

		// biome-ignore lint/style/noNonNullAssertion: tomoriState checked earlier
		if (!tomoriState!.config.personal_memories_enabled) {
			descriptionKey =
				"commands.teach.personalmemory.success_but_disabled_description"; // Use the warning description
			embedColor = ColorCode.WARN; // Use warning color
		}

		// 15. Success! Confirm addition (with potential warning) (Rule 12, 19)
		await replyInfoEmbed(modalSubmitInteraction, locale, {
			titleKey: "commands.teach.personalmemory.success_title",
			descriptionKey: descriptionKey, // Use the determined description key
			descriptionVars: {
				memory:
					newMemory.length > 96 ? `${newMemory.slice(0, 96)}...` : newMemory, // Truncate for display
			},
			color: embedColor, // Use the determined color
		});
	} catch (error) {
		// Rule 22: Log error with context
		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: tomoriState?.server_id,
			tomoriId: tomoriState?.tomori_id,
			errorType: "CommandExecutionError",
			metadata: {
				command: "teach personalmemory",
				userDiscordId: interaction.user.id,
				guildId: interaction.guild?.id,
			},
		};
		await log.error("Error in /teach personalmemory command", error, context);

		// Rule 12, 19: Reply with unknown error embed
		const errorReplyInteraction =
			modalSubmitInteraction &&
			(modalSubmitInteraction.replied || modalSubmitInteraction.deferred)
				? modalSubmitInteraction
				: interaction.replied || interaction.deferred
					? interaction
					: null;

		if (errorReplyInteraction) {
			try {
				await replyInfoEmbed(errorReplyInteraction, locale, {
					titleKey: "general.errors.unknown_error_title",
					descriptionKey: "general.errors.unknown_error_description",
					color: ColorCode.ERROR,
					flags: MessageFlags.Ephemeral,
				});
			} catch (replyError) {
				log.error(
					"Failed to send error reply in personalmemory catch block",
					replyError,
					{ ...context, errorType: "ErrorReplyFailed" },
				);
			}
		} else {
			log.warn(
				"Interaction was not replied or deferred in personalmemory catch block, cannot send error message to user.",
				context,
			);
		}
	}
}
