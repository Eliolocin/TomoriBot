import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
	ModalSubmitInteraction,
} from "discord.js";
import { MessageFlags, TextInputStyle } from "discord.js";
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
	promptWithRawModal,
} from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";
import { isBlacklisted } from "../../utils/db/dbRead";
import type { ModalResult } from "../../types/discord/modal";
import {
	validateMemoryContent,
	checkServerMemoryLimit,
	getMemoryLimits,
} from "../../utils/db/memoryLimits";

// Rule 20: Constants for modal and input IDs
const MODAL_CUSTOM_ID = "teach_servermemory_add_modal";
const MEMORY_INPUT_ID = "memory_input";

// Get memory limits from environment variables
const memoryLimits = getMemoryLimits();

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("servermemory")
		.setDescription(
			localizer("en-US", "commands.teach.servermemory.description"),
		);

/**
 * Rule 1: JSDoc comment for exported function
 * Adds a server memory to Tomori's knowledge for the server by inserting into the server_memories table.
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
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Define state and modal result outside try for catch block
	let tomoriState: TomoriState | null = null;
	let modalResult: ModalResult | null = null;
	// Define modalSubmitInteraction here to be accessible in catch block
	let modalSubmitInteraction: ModalSubmitInteraction | null = null;

	try {
		// 2. Check blacklisting only for guild contexts
		if (interaction.guild) {
			const blacklisted = (await isBlacklisted(interaction.guild.id, interaction.user.id)) ?? false;
			if (blacklisted) {
				await replyInfoEmbed(interaction, locale, {
					titleKey: "general.errors.user_blacklisted_title",
					descriptionKey: "general.errors.user_blacklisted_description",
					color: ColorCode.ERROR,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
		}

		// 3. Load server's Tomori state (Rule 17) - Still needed for server_id and config checks
		tomoriState = await loadTomoriState(interaction.guild?.id ?? interaction.user.id);

		// 3. Check if Tomori is set up
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 4. Check if user has Manage Server permission - admins can bypass teaching restriction
		const hasManagePermission =
			interaction.memberPermissions?.has("ManageGuild") ?? false;

		// 5. Check if server memory teaching is enabled
		// NOTE: Check the correct config key name from tomori_configs table
		if (
			!tomoriState.config.server_memteaching_enabled && // Assuming this is the correct key
			!hasManagePermission
		) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.teach.servermemory.teaching_disabled_title",
				descriptionKey:
					"commands.teach.servermemory.teaching_disabled_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 6. Prompt user with a modal with Component Type 18 support (Rule 10, 12, 19, 25)
		modalResult = await promptWithRawModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.teach.servermemory.modal_title",
			components: [
				{
					customId: MEMORY_INPUT_ID,
					labelKey: "commands.teach.servermemory.memory_input_label",
					descriptionKey: "commands.teach.servermemory.modal_description",
					placeholder: "commands.teach.servermemory.memory_input_placeholder",
					style: TextInputStyle.Paragraph,
					required: true,
					maxLength: memoryLimits.maxMemoryLength,
				},
			],
		});

		// 7. Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Server memory add modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// 8. Capture and immediately defer the modal submission interaction (Rule 25)
		// biome-ignore lint/style/noNonNullAssertion: Outcome 'submit' guarantees interaction
		modalSubmitInteraction = modalResult.interaction!;
		await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });

		// 9. Get input from modal
		// biome-ignore lint/style/noNonNullAssertion: Outcome 'submit' + required=true guarantees value
		const newMemory = modalResult.values![MEMORY_INPUT_ID];

		// 10. Validate memory content length
		const contentValidation = validateMemoryContent(newMemory);
		if (!contentValidation.isValid) {
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "commands.teach.servermemory.content_too_long_title",
				descriptionKey:
					"commands.teach.servermemory.content_too_long_description",
				descriptionVars: { max_length: memoryLimits.maxMemoryLength },
				color: ColorCode.ERROR,
			});
			return;
		}

		// 11. Check server memory limit

		const serverLimitCheck = await checkServerMemoryLimit(
			// biome-ignore lint/style/noNonNullAssertion: tomoriState validation ensures server_id exists
			tomoriState.server_id!,
		);
		if (!serverLimitCheck.isValid) {
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "commands.teach.servermemory.limit_exceeded_title",
				descriptionKey:
					"commands.teach.servermemory.limit_exceeded_description",
				descriptionVars: {
					max_allowed:
						serverLimitCheck.maxAllowed || memoryLimits.maxServerMemories,
					current_count: serverLimitCheck.currentCount || 0,
				},
				color: ColorCode.ERROR,
			});
			return;
		}

		// 12. Check for duplicate memory content for this server in the server_memories table

		const [existingMemory] = await sql`
            SELECT server_memory_id FROM server_memories
            WHERE server_id = ${
							// biome-ignore lint/style/noNonNullAssertion: tomoriState check guarantees server_id
							tomoriState.server_id!
						} AND content = ${newMemory}
            LIMIT 1
        `;

		if (existingMemory) {
			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "commands.teach.servermemory.duplicate_title",
				descriptionKey: "commands.teach.servermemory.duplicate_description",
				descriptionVars: { memory: newMemory },
				color: ColorCode.WARN,
			});
			return;
		}

		// 11. Insert the new memory into the server_memories table (Rule 4, 15)

		const [insertedMemoryResult] = await sql`
            INSERT INTO server_memories (server_id, user_id, content)
            VALUES (${
							// biome-ignore lint/style/noNonNullAssertion: tomoriState check guarantees server_id
							tomoriState.server_id!
						}, ${userData.user_id}, ${newMemory})
            RETURNING *
        `;

		// 12. Validate the result from the database using serverMemorySchema (Rule 3, 5, 6)
		const validationResult = serverMemorySchema.safeParse(insertedMemoryResult);

		if (!validationResult.success) {
			// Rule 22: Log error with context
			const context: ErrorContext = {
				userId: userData.user_id,
				serverId: tomoriState.server_id,
				tomoriId: tomoriState.tomori_id, // Keep tomori_id for context if available
				errorType: "DatabaseValidationError",
				metadata: {
					command: "teach servermemory",
					table: "server_memories",
					operation: "INSERT",
					userDiscordId: interaction.user.id,
					newMemoryContent: newMemory,
					validationErrors: validationResult.error.issues,
				},
			};
			await log.error(
				"Failed to validate inserted server memory data",
				validationResult.error,
				context,
			);

			await replyInfoEmbed(modalSubmitInteraction, locale, {
				titleKey: "general.errors.update_failed_title", // Re-use generic failure message
				descriptionKey: "general.errors.update_failed_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 13. Success! Confirm addition (Rule 12, 19)
		await replyInfoEmbed(modalSubmitInteraction, locale, {
			titleKey: "commands.teach.servermemory.success_title",
			descriptionKey: "commands.teach.servermemory.success_description",
			descriptionVars: {
				memory:
					newMemory.length > 96 ? `${newMemory.slice(0, 96)}...` : newMemory, // Truncate for display
			},
			color: ColorCode.SUCCESS,
		});
	} catch (error) {
		// Rule 22: Log error with context
		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: tomoriState?.server_id,
			tomoriId: tomoriState?.tomori_id,
			errorType: "CommandExecutionError",
			metadata: {
				command: "teach servermemory",
				userDiscordId: interaction.user.id,
				guildId: interaction.guild?.id,
			},
		};
		await log.error("Error in /teach servermemory command", error, context);

		// Rule 12, 19: Reply with unknown error embed
		// Determine which interaction to use (Rule 25)
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
					"Failed to send error reply in servermemory catch block",
					replyError,
					{ ...context, errorType: "ErrorReplyFailed" },
				);
			}
		} else {
			log.warn(
				"Interaction was not replied or deferred in servermemory catch block, cannot send error message to user.",
				context,
			);
		}
	}
}
