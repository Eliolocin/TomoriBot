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
	MessageActionRowComponentBuilder,
	ModalSubmitInteraction,
	InteractionReplyOptions,
} from "discord.js";
import { localizer } from "../text/localizer";
import { log, ColorCode } from "../misc/logger";
import type {
	ConfirmationOptions,
	ConfirmationResult,
	PaginatedChoiceOptions,
	PaginatedChoiceResult,
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
		// await submitted.deferUpdate();

		return { outcome: "submit", values, interaction: submitted };
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
			await interaction.reply({ embeds: [embed], components: [], flags });
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

const PAGINATION_TIMEOUT_MS = 120000; // 2 minute timeout for pagination interactions
const PAGINATION_ITEMS_PER_PAGE = 9; // Number of items to show per page
const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"]; // Emojis for numbered selection

/**
 * Displays a paginated list of choices with emoji reactions for selection
 * @param interaction - Discord interaction
 * @param locale - User locale
 * @param options - Configuration options for the paginated choices
 * @returns A promise that resolves with the selected item or null if cancelled/timeout
 */
export async function replyPaginatedChoices(
	interaction: ChatInputCommandInteraction | ButtonInteraction,
	locale: string,
	options: PaginatedChoiceOptions,
): Promise<PaginatedChoiceResult> {
	// Initialization
	const totalItems = options.items.length;
	const totalPages = Math.ceil(totalItems / PAGINATION_ITEMS_PER_PAGE);
	let currentPage = 1;

	if (totalItems === 0) {
		// If there are no items, show an empty state
		await replyInfoEmbed(
			interaction,
			locale,
			{
				titleKey: options.titleKey,
				titleVars: options.titleVars,
				descriptionKey: "general.pagination.no_items", // Ensure this key exists
				color: ColorCode.INFO,
			},
			options.ephemeral ? MessageFlags.Ephemeral : undefined,
		);

		return {
			success: false,
			reason: "error", // Indicate error because there were no items to choose from
		};
	}

	// Outer try-catch for setup errors (e.g., initial reply fails)
	try {
		while (true) {
			// This loop handles pagination navigation
			// Calculate start and end indices for current page
			const startIdx = (currentPage - 1) * PAGINATION_ITEMS_PER_PAGE;
			const endIdx = Math.min(startIdx + PAGINATION_ITEMS_PER_PAGE, totalItems);
			const currentPageItems = options.items.slice(startIdx, endIdx);

			// Build the item display with numbered emojis
			let itemsDisplay = "";
			if (options.itemLabelKey) {
				itemsDisplay += `**${localizer(locale, options.itemLabelKey)}**\n\n`;
			}

			currentPageItems.forEach((item, idx) => {
				// Ensure item is a string before displaying
				const displayItem = typeof item === "string" ? item : String(item);
				itemsDisplay += `${NUMBER_EMOJIS[idx]} ${displayItem}\n`;
			});

			// Add pagination information if there are multiple pages
			if (totalPages > 1) {
				itemsDisplay += `\n${localizer(locale, "general.pagination.page_info", {
					current: currentPage,
					total: totalPages,
				})}`;
			}

			// Create pagination buttons
			const buttons: ButtonBuilder[] = [];

			// Previous page button (if not on first page)
			if (currentPage > 1) {
				buttons.push(
					new ButtonBuilder()
						.setCustomId("prev_page")
						.setLabel(localizer(locale, "general.pagination.previous"))
						.setStyle(ButtonStyle.Secondary)
						.setEmoji("⬅️"),
				);
			}

			// Cancel button
			buttons.push(
				new ButtonBuilder()
					.setCustomId("cancel")
					.setLabel(localizer(locale, "general.pagination.cancel"))
					.setStyle(ButtonStyle.Danger),
			);

			// Next page button (if not on last page)
			if (currentPage < totalPages) {
				buttons.push(
					new ButtonBuilder()
						.setCustomId("next_page")
						.setLabel(localizer(locale, "general.pagination.next"))
						.setStyle(ButtonStyle.Secondary)
						.setEmoji("➡️"),
				);
			}

			// Create selection buttons for each item on current page
			const selectionButtons: ButtonBuilder[] = [];
			currentPageItems.forEach((_, idx) => {
				selectionButtons.push(
					new ButtonBuilder()
						.setCustomId(`select_${idx}`)
						//.setLabel(String(idx + 1)) // Use the number as the label
						.setStyle(ButtonStyle.Primary)
						.setEmoji(NUMBER_EMOJIS[idx]), // Use the number emoji
				);
			});

			// Create button rows
			// Row 1: Pagination controls (Prev, Cancel, Next)
			const paginationRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
				...buttons,
			);

			// --- Start Change: Split selection buttons into multiple rows ---
			// Rows 2+: Selection buttons (max 5 per row)
			const selectionRows: ActionRowBuilder<ButtonBuilder>[] = [];
			for (let i = 0; i < selectionButtons.length; i += 5) {
				const rowButtons = selectionButtons.slice(i, i + 5);
				if (rowButtons.length > 0) {
					selectionRows.push(
						new ActionRowBuilder<ButtonBuilder>().addComponents(...rowButtons),
					);
				}
			}
			// --- End Change ---

			// Combine all rows, ensuring type compatibility
			const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
				// Type assertion needed because ActionRowBuilder<ButtonBuilder> is not directly assignable
				paginationRow as ActionRowBuilder<MessageActionRowComponentBuilder>,
				// Spread the selection rows (if any) with type assertions
				...selectionRows.map(
					(row) => row as ActionRowBuilder<MessageActionRowComponentBuilder>,
				),
			];

			// Create the embed
			const embed = createStandardEmbed(locale, {
				titleKey: options.titleKey,
				titleVars: options.titleVars,
				descriptionKey: options.descriptionKey,
				descriptionVars: {
					...options.descriptionVars,
					items: itemsDisplay, // Pass the generated list here
				},
				color: options.color ?? ColorCode.INFO, // Use provided color or default INFO
			});

			// Define base reply options (used by both editReply and reply)
			const baseReplyOptions: Omit<InteractionReplyOptions, "flags"> = {
				embeds: [embed],
				components: rows,
				fetchReply: true, // Needed for awaitMessageComponent
			};

			// Send or update the message
			const message =
				interaction.replied || interaction.deferred
					? // 1. Edit the reply if already replied/deferred
						await interaction.editReply(baseReplyOptions)
					: // 2. Reply initially, adding flags conditionally
						await interaction.reply({
							...baseReplyOptions,
							flags: options.ephemeral ? MessageFlags.Ephemeral : undefined,
						});

			// --- Start Updated Interaction Handling Block ---
			// This try-catch handles button interactions and timeouts
			try {
				const buttonInteraction = await message.awaitMessageComponent({
					filter: (i) => i.user.id === interaction.user.id,
					time: PAGINATION_TIMEOUT_MS,
				});

				// Handle the button interaction
				const customId = buttonInteraction.customId;

				// Handle pagination navigation
				if (customId === "prev_page") {
					currentPage--;
					await buttonInteraction.deferUpdate();
					continue; // Continue the while loop to show the previous page
				}
				if (customId === "next_page") {
					currentPage++;
					await buttonInteraction.deferUpdate();
					continue; // Continue the while loop to show the next page
				}
				if (customId === "cancel") {
					// Handle cancellation
					await buttonInteraction.update({
						embeds: [
							createStandardEmbed(locale, {
								titleKey: options.titleKey, // Keep original title context
								titleVars: options.titleVars,
								descriptionKey: "general.pagination.cancelled", // Use specific cancelled key
								color: ColorCode.WARN, // Use WARN for cancellation feedback
							}),
						],
						components: [], // Remove buttons
					});

					// Execute the onCancel callback if provided
					if (options.onCancel) {
						try {
							await options.onCancel();
						} catch (cancelCallbackError) {
							log.error(
								"Error executing onCancel callback in replyPaginatedChoices",
								cancelCallbackError,
							);
							// Don't block the cancellation flow, just log the error
						}
					}

					return {
						success: false,
						reason: "cancelled",
					};
				}
				if (customId.startsWith("select_")) {
					// Handle item selection
					const selectionIdx = Number.parseInt(customId.split("_")[1]);
					const absoluteIndex = startIdx + selectionIdx;
					const selectedItem = options.items[absoluteIndex];

					// Defer update before potentially long-running callback
					await buttonInteraction.deferUpdate();

					// --- Start Nested Try-Catch for onSelect ---
					try {
						// Process the selection using the callback provided by the command
						await options.onSelect(absoluteIndex);

						// Update the message to show the selection was successful
						await interaction.editReply({
							embeds: [
								createStandardEmbed(locale, {
									titleKey: options.titleKey, // Keep original title context
									titleVars: options.titleVars,
									descriptionKey: "general.pagination.item_selected", // Use specific selected key
									descriptionVars: { item: selectedItem }, // Pass selected item
									color: ColorCode.SUCCESS, // Use SUCCESS color
								}),
							],
							components: [], // Remove buttons
						});

						return {
							success: true,
							selectedIndex: absoluteIndex,
							selectedItem,
						};
					} catch (selectCallbackError) {
						// Error occurred within the onSelect callback (e.g., DB update failed in the command)
						log.warn(
							"Error occurred during onSelect callback execution:",
							selectCallbackError,
						); // Log as warn, the command's callback should use log.error with context

						// Inform the user about the specific failure using new locale keys
						await interaction.editReply({
							embeds: [
								createStandardEmbed(locale, {
									titleKey: "general.errors.operation_failed_title", // Specific error title
									descriptionKey: "general.errors.operation_failed_description", // Specific error description
									descriptionVars: { item: selectedItem }, // Mention the item
									color: ColorCode.ERROR, // Use ERROR color
								}),
							],
							components: [], // Remove buttons
						});

						// Return error state from the helper
						return {
							success: false,
							reason: "error", // Indicate an error occurred during processing
						};
					}
					// --- End Nested Try-Catch for onSelect ---
				}
			} catch (error) {
				// Handle timeout (This catch block now primarily handles timeouts from awaitMessageComponent)
				log.warn(
					`Pagination interaction timed out for user ${interaction.user.id}`,
				); // Log timeout specifically
				await interaction.editReply({
					embeds: [
						createStandardEmbed(locale, {
							titleKey: options.titleKey, // Keep original title context
							titleVars: options.titleVars,
							descriptionKey: "general.pagination.timeout", // Use specific timeout key
							color: ColorCode.WARN, // Use WARN for timeout user feedback
						}),
					],
					components: [], // Remove buttons
				});

				return {
					success: false,
					reason: "timeout",
				};
			}
			// --- End Updated Interaction Handling Block ---
		} // End while loop
	} catch (error) {
		// Handle unexpected errors during setup (e.g., initial reply/edit failed)
		// Errors from onSelect are now caught inside the loop's try-catch
		log.error("Unexpected error during replyPaginatedChoices setup:", error); // Log the setup error

		// Attempt to inform the user if possible
		try {
			// Use replyInfoEmbed for consistency, ensuring it handles deferred/replied state
			await replyInfoEmbed(
				interaction,
				locale,
				{
					titleKey: "general.errors.unknown_error_title",
					descriptionKey: "general.errors.unknown_error_description",
					color: ColorCode.ERROR,
				},
				MessageFlags.Ephemeral, // Ensure it's ephemeral if possible
			);
		} catch (finalErrorReplyError) {
			log.error(
				"Failed even to send final error message in replyPaginatedChoices:",
				finalErrorReplyError,
			);
		}

		return {
			success: false,
			reason: "error", // Indicate a general setup error
		};
	}
}
