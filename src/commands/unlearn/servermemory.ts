import type {
	ChatInputCommandInteraction,
	ButtonInteraction,
	ModalSubmitInteraction,
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
	promptWithPaginatedModal,
	safeSelectOptionText,
} from "../../utils/discord/interactionHelper";
import { loadTomoriState } from "../../utils/db/dbRead";
import type { SelectOption } from "../../types/discord/modal";

// Rule 20: Constants for static values at the top
const MODAL_CUSTOM_ID = "unlearn_servermemory_modal";
const MEMORY_SELECT_ID = "memory_select";

/**
 * Helper function to perform server memory removal from database
 * @param tomoriState - Current Tomori state
 * @param memoryToDelete - Memory object to delete
 * @param userData - User data
 * @param replyInteraction - Interaction to reply to (can be modal or pagination)
 * @param locale - User locale
 */
async function performServerMemoryRemoval(
	tomoriState: TomoriState,
	memoryToDelete: { server_memory_id: number; content: string },
	userData: UserRow,
	replyInteraction:
		| ChatInputCommandInteraction
		| ButtonInteraction
		| ModalSubmitInteraction,
	locale: string,
): Promise<void> {
	// Delete the memory from the database using Bun SQL
	const [deletedRow] = await sql`
		DELETE FROM server_memories
		WHERE server_memory_id = ${memoryToDelete.server_memory_id}
		RETURNING *
	`;

	// Validate the returned (deleted) data
	const validatedMemory = serverMemorySchema.safeParse(deletedRow);

	if (!validatedMemory.success || !deletedRow) {
		// Log error specific to this delete failure
		const context: ErrorContext = {
			tomoriId: tomoriState.tomori_id,
			serverId: tomoriState.server_id,
			userId: userData.user_id,
			errorType: "DatabaseDeleteError",
			metadata: {
				command: "unlearn servermemory",
				table: "server_memories",
				deletedMemoryId: memoryToDelete.server_memory_id,
				validationErrors: validatedMemory.success
					? null
					: validatedMemory.error.flatten(),
			},
		};

		await log.error(
			"Failed to delete or validate server memory from server_memories table",
			validatedMemory.success
				? new Error("Database delete returned no rows or unexpected data")
				: new Error("Deleted server memory data failed validation"),
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
		`Deleted server memory "${memoryToDelete.content.slice(0, 30)}..." (ID: ${memoryToDelete.server_memory_id}) for server ${tomoriState.server_id} by user ${userData.user_disc_id}`,
	);

	await replyInfoEmbed(replyInteraction, locale, {
		titleKey: "commands.unlearn.servermemory.success_title",
		descriptionKey: "commands.unlearn.servermemory.success_description",
		descriptionVars: {
			memory:
				memoryToDelete.content.length > 50
					? `${memoryToDelete.content.slice(0, 50)}...`
					: memoryToDelete.content,
		},
		color: ColorCode.SUCCESS,
	});
}

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("servermemory")
		.setDescription(
			localizer("en-US", "commands.unlearn.servermemory.description"),
		);

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

	// Define state and result variables outside try for catch block context
	let tomoriState: TomoriState | null = null;

	try {
		// 2. Load server's Tomori state (Rule 17) - Needed for server_id and config checks
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

		// 4. Check permissions and if teaching is enabled
		const hasManagePermission =
			interaction.memberPermissions?.has("ManageGuild") ?? false;
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
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 7. Use unified paginated modal system (supports up to 25 items directly, >25 via page selection)
		const memorySelectOptions: SelectOption[] = memories.map(
			(memory: { content: string }, index: number) => ({
				label: safeSelectOptionText(memory.content, 10),
				value: index.toString(), // Use index to avoid truncation issues
				description: safeSelectOptionText(memory.content),
			}),
		);

		const modalResult = await promptWithPaginatedModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.unlearn.servermemory.modal_title",
			components: [
				{
					customId: MEMORY_SELECT_ID,
					labelKey: "commands.unlearn.servermemory.select_label",
					descriptionKey: "commands.unlearn.servermemory.select_description",
					placeholder: "commands.unlearn.servermemory.select_placeholder",
					required: true,
					options: memorySelectOptions,
				},
			],
		});

		// Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Server memory deletion modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// Extract values from the modal
		const modalSubmitInteraction = modalResult.interaction;
		const selectedIndex = modalResult.values?.[MEMORY_SELECT_ID];

		// Safety checks (should never be null after submit outcome)
		if (!modalSubmitInteraction || !selectedIndex) {
			log.error("Modal result unexpectedly missing interaction or values");
			return;
		}

		// Get the full memory from the original array
		const selectedMemory = memories[Number.parseInt(selectedIndex, 10)];

		// Defer the reply for the modal submission
		await modalSubmitInteraction.deferReply({
			flags: MessageFlags.Ephemeral,
		});

		// Validate the selected index
		if (!selectedMemory) {
			await modalSubmitInteraction.editReply({
				content: localizer(
					locale,
					"commands.unlearn.servermemory.memory_not_found",
				),
			});
			return;
		}

		// Perform the database update using the helper function
		await performServerMemoryRemoval(
			tomoriState,
			selectedMemory,
			userData,
			modalSubmitInteraction,
			locale,
		);
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
