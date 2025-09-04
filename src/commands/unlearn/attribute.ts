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
import type { SelectOption } from "../../types/discord/modal";
import { sql } from "bun";

// Rule 20: Constants for static values at the top
const MODAL_CUSTOM_ID = "unlearn_attribute_modal";
const ATTRIBUTE_SELECT_ID = "attribute_select";

/**
 * Helper function to perform attribute removal from database
 * @param tomoriState - Current Tomori state
 * @param attributeToRemove - Attribute to remove
 * @param userData - User data
 * @param replyInteraction - Interaction to reply to (can be modal or pagination)
 * @param locale - User locale
 */
async function performAttributeRemoval(
	tomoriState: TomoriState,
	attributeToRemove: string,
	userData: UserRow,
	replyInteraction:
		| ChatInputCommandInteraction
		| ButtonInteraction
		| ModalSubmitInteraction,
	locale: string,
): Promise<void> {
	// Update the attribute_list in the database using array_remove
	const [updatedRow] = await sql`
		UPDATE tomoris
		SET attribute_list = array_remove(attribute_list, ${attributeToRemove})
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
				command: "unlearn attribute",
				attributeToRemove,
				validationErrors: validatedTomori.success
					? null
					: validatedTomori.error.flatten(),
			},
		};

		await log.error(
			"Failed to update or validate attribute_list in tomoris table",
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
		`Removed attribute "${attributeToRemove}" for tomori ${tomoriState.tomori_id} by user ${userData.user_disc_id}`,
	);

	await replyInfoEmbed(replyInteraction, locale, {
		titleKey: "commands.unlearn.attribute.success_title",
		descriptionKey: "commands.unlearn.attribute.success_description",
		descriptionVars: {
			attribute: attributeToRemove,
		},
		color: ColorCode.SUCCESS,
	});
}

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

	// Define state variables outside try for catch block context
	let tomoriState: TomoriState | null = null;

	try {
		// 2. Load server's Tomori state (Rule 17)
		tomoriState = await loadTomoriState(interaction.guild?.id ?? interaction.user.id);
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

		// 4. Check if teaching is enabled
		if (
			!tomoriState.config.attribute_memteaching_enabled &&
			!hasManagePermission
		) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.teach.attribute.teaching_disabled_title",
				descriptionKey:
					"commands.teach.attribute.teaching_disabled_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
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
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 7. Use unified paginated modal system (supports up to 25 items directly, >25 via page selection)
		const attributeSelectOptions: SelectOption[] = currentAttributes.map(
			(attribute, index) => ({
				label: safeSelectOptionText(attribute),
				value: index.toString(), // Use index to avoid truncation issues
				description: undefined, // No description needed for attributes
			}),
		);

		const modalResult = await promptWithPaginatedModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.unlearn.attribute.modal_title",
			components: [
				{
					customId: ATTRIBUTE_SELECT_ID,
					labelKey: "commands.unlearn.attribute.select_label",
					descriptionKey: "commands.unlearn.attribute.select_description",
					placeholder: "commands.unlearn.attribute.select_placeholder",
					required: true,
					options: attributeSelectOptions,
				},
			],
		});

		// Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(
				`Attribute removal modal ${modalResult.outcome} for user ${userData.user_id}`,
			);
			return;
		}

		// Extract values from the modal
		// biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
		const modalSubmitInteraction = modalResult.interaction!;
		// biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
		const selectedIndex = Number.parseInt(modalResult.values![ATTRIBUTE_SELECT_ID], 10);
		const attributeToRemove = currentAttributes[selectedIndex];

		// Defer the reply for the modal submission
		await modalSubmitInteraction.deferReply({ flags: MessageFlags.Ephemeral });

		// Perform the database update
		await performAttributeRemoval(
			tomoriState,
			attributeToRemove,
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
