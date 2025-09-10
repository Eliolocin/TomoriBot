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
	userSchema, // Use userSchema for validation
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
import { createStandardEmbed } from "../../utils/discord/embedHelper";

// Rule 20: Constants for static values at the top
const MODAL_CUSTOM_ID = "unlearn_personalmemory_modal";
const MEMORY_SELECT_ID = "memory_select";

/**
 * Helper function to perform personal memory removal from database
 * @param memoryToRemove - Memory string to remove
 * @param userData - User data
 * @param replyInteraction - Interaction to reply to (can be modal or pagination)
 * @param locale - User locale
 */
async function performPersonalMemoryRemoval(
	memoryToRemove: string,
	userData: UserRow,
	replyInteraction:
		| ChatInputCommandInteraction
		| ButtonInteraction
		| ModalSubmitInteraction,
	locale: string,
): Promise<void> {
	// Update the user's row in the database using array_remove
	const [updatedUserResult] = await sql`
		UPDATE users
		SET personal_memories = array_remove(personal_memories, ${memoryToRemove})
		WHERE user_id = ${userData.user_id}
		RETURNING *
	`;

	// Validate the returned (updated) data
	const validationResult = userSchema.safeParse(updatedUserResult);

	if (!validationResult.success || !updatedUserResult) {
		// Log error specific to this update failure
		const context: ErrorContext = {
			userId: userData.user_id,
			serverId: null,
			tomoriId: null,
			errorType: "DatabaseUpdateError",
			metadata: {
				command: "unlearn personalmemory",
				table: "users",
				column: "personal_memories",
				operation: "UPDATE",
				memoryToRemove,
				validationErrors: validationResult.success
					? null
					: validationResult.error.flatten(),
			},
		};

		await log.error(
			"Failed to update or validate user data after deleting personal memory",
			validationResult.success
				? new Error("Database update returned no rows or unexpected data")
				: new Error("Updated user data failed validation"),
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
		`Deleted personal memory "${memoryToRemove.slice(0, 30)}..." for user ${userData.user_disc_id} (ID: ${userData.user_id})`,
	);

	await replyInfoEmbed(replyInteraction, locale, {
		titleKey: "commands.unlearn.personalmemory.success_title",
		descriptionKey: "commands.unlearn.personalmemory.success_description",
		descriptionVars: {
			memory:
				memoryToRemove.length > 50
					? `${memoryToRemove.slice(0, 50)}...`
					: memoryToRemove,
		},
		color: ColorCode.SUCCESS,
	});
}

// Rule 21: Configure the subcommand
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("personalmemory")
		.setDescription(
			localizer("en-US", "commands.unlearn.personalmemory.description"),
		);

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
	let personalizationDisabledWarning = false; // Flag to check if warning needed

	try {
		// 2. Load server's Tomori state to check personalization setting (Rule 17)
		tomoriState = await loadTomoriState(
			interaction.guild?.id ?? interaction.user.id,
		);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title", // Corrected key
				descriptionKey: "general.errors.tomori_not_setup_description", // Corrected key
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
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
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 6. Create memory select options for the modal
		const memorySelectOptions: SelectOption[] = currentMemories.map(
			(memory, index) => ({
				label: safeSelectOptionText(memory, 20),
				value: index.toString(), // Use index to avoid truncation issues
				description: safeSelectOptionText(memory),
			}),
		);

		// 7. Show the paginated modal with memory selection
		const modalResult = await promptWithPaginatedModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.unlearn.personalmemory.modal_title",
			components: [
				{
					customId: MEMORY_SELECT_ID,
					labelKey: "commands.unlearn.personalmemory.select_label",
					descriptionKey: "commands.unlearn.personalmemory.select_description",
					placeholder: "commands.unlearn.personalmemory.select_placeholder",
					required: true,
					options: memorySelectOptions,
				},
			],
		});

		// 8. Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Personal memory deletion modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// 9. Extract values from the modal
		const modalSubmitInteraction = modalResult.interaction;
		const selectedIndex = modalResult.values?.[MEMORY_SELECT_ID];

		// Safety checks (should never be null after submit outcome)
		if (!modalSubmitInteraction || !selectedIndex) {
			log.error("Modal result unexpectedly missing interaction or values");
			return;
		}

		// Get the full memory content from the original array
		const selectedMemory = currentMemories[Number.parseInt(selectedIndex, 10)];

		// 10. Perform the database update using the helper function - let helper manage interaction state
		await performPersonalMemoryRemoval(
			selectedMemory,
			userData,
			modalSubmitInteraction,
			locale,
		);

		// 12. If personalization is disabled, send a warning follow-up
		if (personalizationDisabledWarning) {
			await modalSubmitInteraction.followUp({
				embeds: [
					createStandardEmbed(locale, {
						titleKey: "commands.unlearn.personalmemory.warning_disabled_title",
						descriptionKey:
							"commands.unlearn.personalmemory.warning_disabled_description",
						color: ColorCode.WARN,
					}),
				],
				flags: MessageFlags.Ephemeral,
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
