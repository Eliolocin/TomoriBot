import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import type {
	ButtonInteraction,
	ChatInputCommandInteraction,
	Message,
	ModalSubmitInteraction,
} from "discord.js";
import { localizer } from "../text/localizer";
import { log, ColorCode } from "../misc/logger";
import type {
	ConfirmationOptions,
	ConfirmationResult,
	StandardEmbedOptions,
	SummaryEmbedOptions,
} from "../../types/discord/embed";
import type { ModalOptions, ModalResult } from "../../types/discord/modal";
import { createStandardEmbed, createSummaryEmbed } from "./embedHelper";

const PROMPT_TIMEOUT = 15000;
/**
 * @description Prompts the user with an embed and Continue/Cancel buttons, awaiting their response.
 * Handles interaction replies, button filtering, and timeouts.
 * @param interaction The interaction to reply to
 * @param locale The locale for localization
 * @param options Configuration for the embed and buttons
 * @returns Promise resolving to a ConfirmationResult
 */
export async function promptWithConfirmation(
	interaction: ChatInputCommandInteraction | ButtonInteraction,
	locale: string,
	options: ConfirmationOptions,
): Promise<ConfirmationResult> {
	// 1. Destructure options with defaults
	const {
		embedTitleKey,
		embedDescriptionKey,
		embedDescriptionVars = {},
		embedColor = ColorCode.WARN, // Default Warning/Question color
		continueLabelKey,
		cancelLabelKey,
		continueCustomId,
		cancelCustomId,
		timeout = PROMPT_TIMEOUT, // Default 15 seconds
	} = options;

	// 2. Create Embed
	const embed = new EmbedBuilder()
		.setColor(embedColor)
		.setTitle(localizer(locale, embedTitleKey))
		.setDescription(
			localizer(locale, embedDescriptionKey, embedDescriptionVars),
		);

	// 3. Create Buttons
	const continueButton = new ButtonBuilder()
		.setCustomId(continueCustomId)
		.setLabel(localizer(locale, continueLabelKey))
		.setStyle(ButtonStyle.Success);

	const cancelButton = new ButtonBuilder()
		.setCustomId(cancelCustomId)
		.setLabel(localizer(locale, cancelLabelKey))
		.setStyle(ButtonStyle.Danger);

	// 4. Create Action Row
	const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		continueButton,
		cancelButton,
	);

	// 5. Send/Edit the Reply
	let message: Message;
	try {
		// First, check if this interaction has already been responded to
		if (interaction.deferred || interaction.replied) {
			message = await interaction.editReply({
				embeds: [embed],
				components: [buttonRow],
			});
		} else {
			// If not, we need to reply first
			message = (await interaction.reply({
				embeds: [embed],
				components: [buttonRow],
				flags: MessageFlags.Ephemeral,
				fetchReply: true, // Important: we need the Message object
			})) as Message;
		}
	} catch (error) {
		log.error("Failed to edit reply in promptWithConfirmation:", error);
		try {
			// Try followUp as a fallback
			message = (await interaction.followUp({
				embeds: [embed],
				components: [buttonRow],
				flags: MessageFlags.Ephemeral,
			})) as Message;
		} catch (followUpError) {
			log.error(
				"Failed to follow up in promptWithConfirmation:",
				followUpError,
			);
			return { outcome: "timeout" };
		}
	}

	// 6. Create Button Collector Filter
	const buttonCollectorFilter = (i: ButtonInteraction) => {
		i.deferUpdate().catch((e) =>
			log.warn("Failed to defer update on button filter:", e),
		);
		return i.user.id === interaction.user.id;
	};

	// 7. Await Component Interaction
	try {
		const buttonInteraction = await message.awaitMessageComponent({
			filter: buttonCollectorFilter,
			componentType: ComponentType.Button,
			time: timeout,
		});

		// 8. Handle Button Click
		if (buttonInteraction.customId === continueCustomId) {
			return { outcome: "continue", interaction: buttonInteraction };
		}

		// User clicked Cancel
		const cancelEmbed = new EmbedBuilder()
			.setColor(ColorCode.ERROR)
			.setTitle(localizer(locale, "general.interaction.cancel_title"))
			.setDescription(
				localizer(locale, "general.interaction.cancel_description"),
			);

		await interaction.editReply({ embeds: [cancelEmbed], components: [] });
		return { outcome: "cancel" };
	} catch (timeoutError) {
		// 9. Handle Timeout
		log.warn(`Confirmation prompt timed out for user ${interaction.user.id}`);
		const timeoutEmbed = new EmbedBuilder()
			.setColor(ColorCode.ERROR)
			.setTitle(localizer(locale, "general.interaction.timeout_title"))
			.setDescription(
				localizer(locale, "general.interaction.timeout_description"),
			);
		await interaction.editReply({ embeds: [timeoutEmbed], components: [] });
		return { outcome: "timeout" };
	}
}

const MODAL_TIMEOUT = 180000;
/**
 * @description Prompts the user with a modal form and awaits their response.
 * @param interaction The interaction to show the modal for
 * @param locale The locale for localization
 * @param options Configuration for the modal and its input fields
 * @returns Promise resolving to a ModalResult
 */
export async function promptWithModal(
	interaction: ChatInputCommandInteraction | ButtonInteraction,
	locale: string,
	options: ModalOptions,
): Promise<ModalResult> {
	const {
		modalTitleKey,
		modalCustomId,
		inputs,
		timeout = MODAL_TIMEOUT, // Default 3 minutes for modal input
	} = options;

	// 1. Create Modal
	const modal = new ModalBuilder()
		.setCustomId(modalCustomId)
		.setTitle(localizer(locale, modalTitleKey));

	// 2. Create Text Inputs
	const rows = inputs.map((input) => {
		const textInput = new TextInputBuilder()
			.setCustomId(input.customId)
			.setLabel(localizer(locale, input.labelKey))
			.setStyle(input.style || TextInputStyle.Short)
			.setRequired(input.required !== false);

		if (input.placeholder) textInput.setPlaceholder(input.placeholder);
		if (input.minLength) textInput.setMinLength(input.minLength);
		if (input.maxLength) textInput.setMaxLength(input.maxLength);
		if (input.value) textInput.setValue(input.value);

		return new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);
	});

	modal.addComponents(...rows);

	// 3. Show Modal
	try {
		await interaction.showModal(modal);
	} catch (error) {
		log.error("Failed to show modal:", error);
		return { outcome: "timeout" };
	}

	// 4. Wait for submission
	try {
		const submitted = await interaction.awaitModalSubmit({
			time: timeout,
			filter: (i) =>
				i.customId === modalCustomId && i.user.id === interaction.user.id,
		});

		// 5. Collect field values
		const values: Record<string, string> = {};
		for (const input of inputs) {
			values[input.customId] = submitted.fields.getTextInputValue(
				input.customId,
			);
		}

		// 6. Defer update (modals always require a response)
		await submitted.deferUpdate();

		return { outcome: "submit", values };
	} catch (timeoutError) {
		log.warn(`Modal timed out for user ${interaction.user.id}`);
		try {
			const timeoutEmbed = new EmbedBuilder()
				.setColor(ColorCode.ERROR)
				.setTitle(localizer(locale, "general.interaction.timeout_title"))
				.setDescription(
					localizer(locale, "general.interaction.timeout_description"),
				);

			await interaction.editReply({
				embeds: [timeoutEmbed],
				components: [],
			});
		} catch (error) {
			log.error("Failed to show timeout message for modal:", error);
		}
		return { outcome: "timeout" };
	}
}

/**
 * @description Shows a simple info/status embed without any interactive components.
 * @param interaction The interaction to show the embed for
 * @param locale The locale for localization
 * @param options Configuration for the embed
 */
export async function replyInfoEmbed(
	interaction:
		| ChatInputCommandInteraction
		| ButtonInteraction
		| ModalSubmitInteraction,
	locale: string,
	options: StandardEmbedOptions,
	flags?:
		| MessageFlags.SuppressEmbeds
		| MessageFlags.Ephemeral
		| MessageFlags.SuppressNotifications,
): Promise<void> {
	// 1. Build the embed using the shared helper for consistency
	const embed = createStandardEmbed(locale, options);

	try {
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply({ embeds: [embed], components: [] });
		} else {
			await interaction.reply({ embeds: [embed], components: [] });
		}
	} catch (error) {
		log.error("Failed to show info embed:", error);
		try {
			await interaction.followUp({
				embeds: [embed],
				components: [],
				flags,
			});
		} catch (followUpError) {
			log.error("Failed to follow up with info embed:", followUpError);
		}
	}
}

/**
 * @description Shows a summary embed with multiple fields, organized and localized.
 * Useful for displaying configuration summaries, help information, etc.
 * @param interaction The interaction to show the embed for
 * @param locale The locale for localization
 * @param options Configuration for the summary embed and its fields
 */
export async function replySummaryEmbed(
	interaction:
		| ChatInputCommandInteraction
		| ButtonInteraction
		| ModalSubmitInteraction,
	locale: string,
	options: SummaryEmbedOptions,
): Promise<void> {
	const embed = createSummaryEmbed(locale, options);

	try {
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply({ embeds: [embed], components: [] });
		} else {
			await interaction.reply({ embeds: [embed], components: [] });
		}
	} catch (error) {
		log.error("Failed to show summary embed:", error);
		try {
			await interaction.followUp({
				embeds: [embed],
				components: [],
				flags: MessageFlags.Ephemeral,
			});
		} catch (followUpError) {
			log.error("Failed to follow up with summary embed:", followUpError);
		}
	}
}
