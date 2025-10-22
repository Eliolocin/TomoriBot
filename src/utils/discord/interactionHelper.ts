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
	InteractionResponseType,
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
	RawDiscordComponent,
	RawDiscordWebSocketPacket,
	RawDiscordShard,
	GlobalDiscordState,
} from "@/types/discord/rawApiTypes";

// Clean storage for select values (Discord.js will strip them, so we preserve them)
const modalSelectValues = new Map<string, Record<string, string>>();

/**
 * Tracks interactions that were acknowledged via raw Discord REST API
 * Used to prevent "already acknowledged" errors when Discord.js state is out of sync
 */
const rawModalAcknowledged = new WeakMap<
	ChatInputCommandInteraction | ButtonInteraction,
	boolean
>();

/**
 * Transform Component Type 18 modal submission to standard ActionRow format
 * This makes Discord.js process the submission as if it were a normal modal from the start
 */
function transformModalSubmissionPacket(
	packet: RawDiscordWebSocketPacket,
): void {
	if (!packet.d?.data?.components) return;

	// Transform each Component Type 18 to standard ActionRow format with all data preserved
	packet.d.data.components = packet.d.data.components.map((comp) => {
		if (comp.type === 18 && comp.component) {
			// Extract the nested component with all its properties
			const nestedComponent = comp.component;

			// Create a clean ActionRow that Discord.js can process normally
			return {
				type: 1, // ActionRow
				components: [
					{
						type: nestedComponent.type,
						custom_id: nestedComponent.custom_id,
						// Preserve all component data based on type
						...(nestedComponent.type === 3 && {
							// STRING_SELECT
							values: nestedComponent.values, // This is the key fix!
						}),
						...(nestedComponent.type === 4 && {
							// TEXT_INPUT
							value: nestedComponent.value,
						}),
						// Include any other properties
						...Object.fromEntries(
							Object.entries(nestedComponent).filter(
								([key]) =>
									!["type", "custom_id", "values", "value"].includes(key),
							),
						),
					},
				],
			};
		}
		return comp;
	});
}

/**
 * Intercept and transform WebSocket messages for Component Type 18 support
 * This patches the actual WebSocket message handler at a lower level
 */

// biome-ignore lint/suspicious/noExplicitAny: Discord.js client type requires any for WebSocket interception
function setupWebSocketInterception(client: any) {
	if ((globalThis as GlobalDiscordState).__webSocketPatched) return;

	try {
		// Patch the WebSocket manager's handlePacket method
		const wsManager = client.ws;
		if (wsManager?.handlePacket) {
			const originalHandlePacket = wsManager.handlePacket.bind(wsManager);

			wsManager.handlePacket = (
				packet: RawDiscordWebSocketPacket,
				shard: RawDiscordShard,
			) => {
				// Intercept INTERACTION_CREATE packets for modal submissions
				if (
					packet.t === "INTERACTION_CREATE" &&
					packet.d?.type === 5 &&
					packet.d?.data?.components
				) {
					// Check if we have Component Type 18 that needs transformation
					const hasComponentType18 = packet.d.data.components.some(
						(comp: RawDiscordComponent) => comp.type === 18,
					);

					if (hasComponentType18) {
						log.info(
							"Transforming Component Type 18 modal submission for Discord.js compatibility",
						);

						// Store select values before Discord.js strips them
						const interactionId = packet.d.id;
						if (interactionId) {
							const selectValues: Record<string, string> = {};

							for (const comp of packet.d.data.components) {
								if (
									comp.type === 18 &&
									comp.component?.type === 3 &&
									comp.component.custom_id &&
									comp.component.values?.[0]
								) {
									selectValues[comp.component.custom_id] =
										comp.component.values[0];
								}
							}

							if (Object.keys(selectValues).length > 0) {
								modalSelectValues.set(interactionId, selectValues);
								log.info(
									`Stored ${Object.keys(selectValues).length} select values for interaction`,
								);
							}
						}

						// Transform the entire packet to standard format
						transformModalSubmissionPacket(packet);
					}
				}

				// Call the original handler with (potentially) transformed packet
				return originalHandlePacket(packet, shard);
			};

			(globalThis as GlobalDiscordState).__webSocketPatched = true;
			log.info("Component Type 18 WebSocket transformation enabled");
		} else {
			log.warn(
				"Could not find WebSocket handlePacket method for Component Type 18 support",
			);
		}
	} catch (error) {
		log.warn(
			"Failed to set up Component Type 18 WebSocket interception:",
			error,
		);
	}
}

import type {
	ConfirmationOptions,
	ConfirmationResult,
	PaginatedChoiceOptions,
	PaginatedChoiceResult,
	StandardEmbedOptions,
	SummaryEmbedOptions,
} from "../../types/discord/embed";
import type {
	ModalOptions,
	ModalResult,
	ModalSelectField,
} from "../../types/discord/modal";
import {
	isModalInputField,
	isModalSelectField,
} from "../../types/discord/modal";
import { createStandardEmbed, createSummaryEmbed } from "./embedHelper";

const PROMPT_TIMEOUT = 15000;
const MODAL_DESCRIPTION_MAX_LENGTH = 99; // Discord modal description limit

/**
 * Safely localizes a string for modal usage, truncating if necessary to prevent Discord API errors
 * @param locale The locale for localization
 * @param key The localization key
 * @param vars Variables for localization (optional)
 * @param maxLength Maximum allowed length (defaults to modal description limit)
 * @returns Localized and potentially truncated string
 */
function safeModalLocalizer(
	locale: string,
	key: string,
	vars?: Record<string, string | number>,
	maxLength: number = MODAL_DESCRIPTION_MAX_LENGTH,
): string {
	const localizedText = localizer(locale, key, vars);

	if (localizedText.length > maxLength) {
		log.warn(
			`Modal locale string truncated - Key: '${key}', Original: ${localizedText.length} chars, Truncated to: ${maxLength} chars`,
			{
				originalText: localizedText,
				truncatedText: `${localizedText.substring(0, maxLength - 3)}...`,
			},
		);
		return `${localizedText.substring(0, maxLength - 3)}...`;
	}

	return localizedText;
}

/**
 * Safely truncates text for select option labels and values with "..." suffix
 * @param text The text to truncate
 * @param maxLength Maximum allowed length (100 for select options)
 * @returns Truncated text with "..." if needed
 */
export function safeSelectOptionText(text: string, maxLength = 100): string {
	if (text.length > maxLength) {
		return `${text.substring(0, maxLength - 3)}...`;
	}
	return text;
}

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
	} catch (_timeoutError) {
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

/**
 * @description Prompts the user with a modal form and awaits their response.
 * Discord handles modal timeouts naturally (~15 minutes), so no artificial timeout is applied.
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
	const { modalTitleKey, modalCustomId, components } = options;

	// 1. Create Modal
	const modal = new ModalBuilder()
		.setCustomId(modalCustomId)
		.setTitle(localizer(locale, modalTitleKey));

	// 2. Create Modal Components (Text Inputs Only - String Selects Not Yet Supported)
	const rows = components.map((component) => {
		if (isModalInputField(component)) {
			// Create text input component
			const textInput = new TextInputBuilder()
				.setCustomId(component.customId)
				.setLabel(localizer(locale, component.labelKey))
				.setStyle(component.style || TextInputStyle.Short)
				.setRequired(component.required !== false)
				.setMaxLength(component.maxLength || 256); // Discord API limit

			// Add description if provided (not yet supported by Discord.js)
			if (component.descriptionKey) {
				// Note: Discord.js does not support descriptions on TextInputs yet
				// For now, we can add the description to the placeholder or label
				const description = localizer(locale, component.descriptionKey);
				if (!component.placeholder) {
					textInput.setPlaceholder(description.substring(0, 100)); // Discord limit
				}
			}

			if (component.placeholder) {
				// If placeholder is provided, use it as localized placeholder
				const placeholder =
					typeof component.placeholder === "string" &&
					component.placeholder.startsWith("commands.")
						? localizer(locale, component.placeholder)
						: component.placeholder;
				textInput.setPlaceholder(placeholder);
			}
			if (component.minLength) textInput.setMinLength(component.minLength);
			if (component.value) textInput.setValue(component.value);

			return new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);
		} else if (isModalSelectField(component)) {
			// String selects in modals are not yet supported by Discord.js
			// Convert to a text input with localized placeholder
			const fallbackInput = new TextInputBuilder()
				.setCustomId(component.customId)
				.setLabel(localizer(locale, component.labelKey))
				.setStyle(TextInputStyle.Short)
				.setRequired(component.required !== false)
				.setMaxLength(256); // Discord API limit

			// Use localized placeholder if provided, otherwise show options
			if (component.placeholder) {
				const placeholder =
					typeof component.placeholder === "string" &&
					component.placeholder.startsWith("commands.")
						? localizer(locale, component.placeholder)
						: component.placeholder;
				fallbackInput.setPlaceholder(placeholder);
			} else {
				// Fallback to showing available options
				const optionsText = component.options
					.map((opt) => opt.label)
					.join(", ");
				fallbackInput.setPlaceholder(
					`Options: ${optionsText.substring(0, 95)}...`,
				);
			}

			return new ActionRowBuilder<TextInputBuilder>().addComponents(
				fallbackInput,
			);
		}

		throw new Error(`Unsupported modal component type: ${component}`);
	});

	modal.addComponents(...rows);

	// 3. Show Modal
	try {
		await interaction.showModal(modal);
	} catch (error) {
		log.error("Failed to show modal:", error);
		return { outcome: "timeout" };
	}

	// 4. Wait for submission (use Discord's natural timeout duration ~15 minutes)
	try {
		const submitted = await interaction.awaitModalSubmit({
			time: 600000, // 10 minutes - matches Discord's natural modal timeout
			filter: (i) =>
				i.customId === modalCustomId && i.user.id === interaction.user.id,
		});

		// 5. Collect field values
		const values: Record<string, string> = {};
		for (const component of components) {
			if (isModalInputField(component)) {
				values[component.customId] = submitted.fields.getTextInputValue(
					component.customId,
				);
			} else if (isModalSelectField(component)) {
				// Get selected values from string select
				const selectedValues = submitted.fields.getField(
					component.customId,
				)?.value;
				if (selectedValues) {
					values[component.customId] = selectedValues;
				}
			}
		}

		return { outcome: "submit", values, interaction: submitted };
	} catch (error) {
		// This will only catch actual errors, not artificial timeouts
		// Discord's natural timeout or user cancellation will be handled by command timeout
		log.warn(`Modal submission failed for user ${interaction.user.id}:`, error);
		return { outcome: "timeout" };
	}
}

/**
 * @description Shows a simple info/status embed without any interactive components.
 * Handles interaction state management defensively to prevent acknowledgment conflicts.
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
	flags:
		| MessageFlags.SuppressEmbeds
		| MessageFlags.Ephemeral
		| MessageFlags.SuppressNotifications
		| undefined = MessageFlags.Ephemeral,
): Promise<void> {
	// 1. Add DM footer automatically for tomori_not_setup errors in DM context
	const isDMContext = !interaction.guild;
	const finalOptions = { ...options };

	if (
		isDMContext &&
		(options.titleKey === "general.errors.tomori_not_setup_title" ||
			options.titleKey === "general.errors.api_key_missing_title")
	) {
		finalOptions.footerKey = "general.errors.tomori_not_setup_dm_footer";
	}

	// 2. Build the embed using the shared helper for consistency
	const embed = createStandardEmbed(locale, finalOptions);

	// 3. Defensive interaction state checking
	const interactionState = {
		deferred: interaction.deferred,
		replied: interaction.replied,
		id: interaction.id,
	};

	log.info(`replyInfoEmbed interaction state: ${JSON.stringify(interactionState)}`);

	// 4. Check if interaction was acknowledged via raw REST API (e.g., modal shown)
	// Discord.js state may be out of sync in this case
	const wasRawModalSent = rawModalAcknowledged.get(
		interaction as ChatInputCommandInteraction | ButtonInteraction,
	);

	if (wasRawModalSent && !interaction.deferred && !interaction.replied) {
		// State desync detected: Discord thinks acknowledged, but Discord.js doesn't know
		log.info(`Raw modal state desync detected for interaction ${interaction.id}, using followUp directly`);
		try {
			await interaction.followUp({
				embeds: [embed],
				components: [],
				flags: flags || MessageFlags.Ephemeral,
			});
			return;
		} catch (followUpError) {
			log.error("followUp failed for raw-modal-acknowledged interaction:", followUpError);
			// Fall through to standard error handling
		}
	}

	try {
		if (interaction.deferred || interaction.replied) {
			// Interaction has already been acknowledged, use editReply
			await interaction.editReply({ embeds: [embed], components: [] });
		} else {
			// Interaction hasn't been acknowledged, use reply
			await interaction.reply({ embeds: [embed], components: [], flags });
		}
	} catch (error) {
		log.warn("Failed to show info embed via primary method:", error);
		
		// Enhanced fallback logic with more specific error handling
		try {
			// Only attempt followUp if the interaction was actually replied to successfully
			// Check if the error suggests the interaction wasn't properly replied to
			const errorMessage = error instanceof Error ? error.message : String(error);
			
			if (errorMessage.includes("has already been acknowledged")) {
				// Interaction was acknowledged but editReply failed - try followUp
				log.info("Attempting followUp due to acknowledgment conflict");
				await interaction.followUp({
					embeds: [embed],
					components: [],
					flags: flags || MessageFlags.Ephemeral, // Default to ephemeral for followUps
				});
			} else if (errorMessage.includes("not been sent or deferred")) {
				// Interaction wasn't properly acknowledged - try reply without flags first
				log.info("Attempting basic reply due to no prior acknowledgment");
				await interaction.reply({ 
					embeds: [embed], 
					components: [], 
					flags: MessageFlags.Ephemeral // Force ephemeral for fallback
				});
			} else {
				// Other error - try followUp as last resort
				log.info("Attempting followUp as last resort fallback");
				await interaction.followUp({
					embeds: [embed],
					components: [],
					flags: flags || MessageFlags.Ephemeral,
				});
			}
		} catch (fallbackError) {
			// All methods failed - log comprehensive error details
			log.error("All interaction methods failed for replyInfoEmbed:", {
				originalError: error,
				fallbackError: fallbackError,
				interactionState: {
					id: interaction.id,
					type: interaction.type,
					deferred: interaction.deferred,
					replied: interaction.replied,
				},
				embedTitle: options.titleKey,
			});
		}
	}
}

/**
 * @description Shows a summary embed with multiple fields, organized and localized.
 * Useful for displaying configuration summaries, help information, etc.
 * Handles interaction state management defensively to prevent acknowledgment conflicts.
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
	flags:
		| MessageFlags.SuppressEmbeds
		| MessageFlags.Ephemeral
		| MessageFlags.SuppressNotifications
		| undefined = MessageFlags.Ephemeral,
): Promise<void> {
	const embed = createSummaryEmbed(locale, options);

	// Defensive interaction state checking
	const interactionState = {
		deferred: interaction.deferred,
		replied: interaction.replied,
		id: interaction.id,
	};

	log.info(`replySummaryEmbed interaction state: ${JSON.stringify(interactionState)}`);

	// Check if interaction was acknowledged via raw REST API (e.g., modal shown)
	const wasRawModalSent = rawModalAcknowledged.get(
		interaction as ChatInputCommandInteraction | ButtonInteraction,
	);

	if (wasRawModalSent && !interaction.deferred && !interaction.replied) {
		// State desync detected: Discord thinks acknowledged, but Discord.js doesn't know
		log.info(`Raw modal state desync detected for interaction ${interaction.id}, using followUp directly`);
		try {
			await interaction.followUp({
				embeds: [embed],
				components: [],
				flags: flags || MessageFlags.Ephemeral,
			});
			return;
		} catch (followUpError) {
			log.error("followUp failed for raw-modal-acknowledged interaction:", followUpError);
			// Fall through to standard error handling
		}
	}

	try {
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply({ embeds: [embed], components: [] });
		} else {
			await interaction.reply({ embeds: [embed], components: [], flags });
		}
	} catch (error) {
		log.warn("Failed to show summary embed via primary method:", error);
		
		// Enhanced fallback logic matching replyInfoEmbed
		try {
			const errorMessage = error instanceof Error ? error.message : String(error);
			
			if (errorMessage.includes("has already been acknowledged")) {
				log.info("Attempting followUp due to acknowledgment conflict");
				await interaction.followUp({
					embeds: [embed],
					components: [],
					flags: flags || MessageFlags.Ephemeral,
				});
			} else if (errorMessage.includes("not been sent or deferred")) {
				log.info("Attempting basic reply due to no prior acknowledgment");
				await interaction.reply({ 
					embeds: [embed], 
					components: [], 
					flags: flags || MessageFlags.Ephemeral 
				});
			} else {
				log.info("Attempting followUp as last resort fallback");
				await interaction.followUp({
					embeds: [embed],
					components: [],
					flags: flags || MessageFlags.Ephemeral,
				});
			}
		} catch (fallbackError) {
			log.error("All interaction methods failed for replySummaryEmbed:", {
				originalError: error,
				fallbackError: fallbackError,
				interactionState: {
					id: interaction.id,
					type: interaction.type,
					deferred: interaction.deferred,
					replied: interaction.replied,
				},
				embedTitle: options.titleKey,
			});
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
		await replyInfoEmbed(interaction, locale, {
			titleKey: options.titleKey,
			titleVars: options.titleVars,
			descriptionKey: "general.pagination.no_items", // Ensure this key exists
			color: ColorCode.INFO,
			flags: MessageFlags.Ephemeral,
		});

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
							flags: MessageFlags.Ephemeral,
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
					const selectionIdx = Number.parseInt(customId.split("_")[1], 10);
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
			} catch (_error) {
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

/**
 * @description Creates a modal using raw Discord API with Component Type 18 (Label) support for descriptions and string selects
 * @param interaction The interaction to respond to
 * @param locale The locale for localization
 * @param options Configuration for the modal and its components
 * @returns Promise resolving to a ModalResult
 */
export async function promptWithRawModal(
	interaction: ChatInputCommandInteraction | ButtonInteraction,
	locale: string,
	options: ModalOptions,
): Promise<ModalResult> {
	// Set up WebSocket interception FIRST, before showing the modal
	setupWebSocketInterception(interaction.client);

	const { modalTitleKey, modalCustomId, components } = options;

	try {
		// Build raw Discord API payload with Component Type 18 (Label) support
		const rawModalPayload = {
			type: InteractionResponseType.Modal, // Type 9
			data: {
				custom_id: modalCustomId,
				title: localizer(locale, modalTitleKey),
				components: components.map((component) => {
					if (isModalInputField(component)) {
						// Text Input wrapped in Label component (type 18)
						const rawComponent: RawDiscordComponent = {
							type: 4, // ComponentType.TextInput
							custom_id: component.customId,
							style: component.style || TextInputStyle.Short,
							required: component.required !== false,
						};

						if (component.placeholder) {
							const placeholder =
								typeof component.placeholder === "string" &&
								component.placeholder.startsWith("commands.")
									? localizer(locale, component.placeholder)
									: component.placeholder;
							rawComponent.placeholder = placeholder;
						}
						if (component.minLength)
							rawComponent.min_length = component.minLength;
						if (component.maxLength)
							rawComponent.max_length = component.maxLength;
						if (component.value) rawComponent.value = component.value;

						// Wrap in Label component (type 18)
						const labelComponent: RawDiscordComponent = {
							type: 18, // ComponentType.Label
							label: localizer(locale, component.labelKey),
							component: rawComponent,
						};

						// Add description if provided
						if (component.descriptionKey) {
							labelComponent.description = safeModalLocalizer(
								locale,
								component.descriptionKey,
							);
						}

						return labelComponent;
					} else if (isModalSelectField(component)) {
						// String Select wrapped in Label component (type 18)
						const rawComponent: RawDiscordComponent = {
							type: 3, // ComponentType.StringSelect
							custom_id: component.customId,
							options: component.options.map((option) => ({
								label: option.label,
								value: option.value,
								description: option.description,
								emoji: option.emoji,
							})),
							required: component.required !== false,
						};

						if (component.placeholder) {
							const placeholder =
								typeof component.placeholder === "string" &&
								component.placeholder.startsWith("commands.")
									? localizer(locale, component.placeholder)
									: component.placeholder;
							rawComponent.placeholder = placeholder;
						}

						// Wrap in Label component (type 18)
						const labelComponent: RawDiscordComponent = {
							type: 18, // ComponentType.Label
							label: localizer(locale, component.labelKey),
							component: rawComponent,
						};

						// Add description if provided
						if (component.descriptionKey) {
							labelComponent.description = safeModalLocalizer(
								locale,
								component.descriptionKey,
							);
						}

						return labelComponent;
					}

					throw new Error(`Unsupported modal component type: ${component}`);
				}),
			},
		};

		// Send raw API response using Discord's REST API directly
		const restEndpoint = `https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`;

		const response = await fetch(restEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(rawModalPayload),
		});

		if (!response.ok) {
			const errorText = await response.text();
			log.error(
				`Failed to send raw modal via REST API: ${response.status} ${response.statusText} - ${errorText}`,
			);
			throw new Error(
				`Discord API error: ${response.status} ${response.statusText}`,
			);
		}

		// Mark this interaction as acknowledged via raw API for state tracking
		rawModalAcknowledged.set(interaction, true);
		log.info(`Marked interaction ${interaction.id} as raw-modal-acknowledged`);

		// Now we can use the standard awaitModalSubmit with the transformed data
		// Use Discord's natural timeout duration (~15 minutes)
		try {
			const submitted = await interaction.awaitModalSubmit({
				time: 600000, // 10 minutes - matches Discord's natural modal timeout
				filter: (i) =>
					i.customId === modalCustomId && i.user.id === interaction.user.id,
			});

			// Extract values using Discord.js methods and stored select values
			const values: Record<string, string> = {};

			for (const component of components) {
				if (isModalInputField(component)) {
					try {
						values[component.customId] = submitted.fields.getTextInputValue(
							component.customId,
						);
					} catch (error) {
						log.warn(
							`Failed to get text input value for ${component.customId}:`,
							error,
						);
					}
				} else if (isModalSelectField(component)) {
					try {
						// Get select value from storage (since Discord.js strips them)
						const storedValues = modalSelectValues.get(submitted.id);
						const selectValue = storedValues?.[component.customId];

						if (selectValue) {
							values[component.customId] = selectValue;
						} else {
							log.warn(
								`Could not extract select value for ${component.customId}`,
							);
						}
					} catch (error) {
						log.warn(
							`Failed to get select value for ${component.customId}: ${error}`,
						);
					}
				}
			}

			// Clean up stored values
			modalSelectValues.delete(submitted.id);

			return { outcome: "submit", values, interaction: submitted };
		} catch (error) {
			// This will only catch actual errors, not artificial timeouts
			// Discord's natural timeout or user cancellation will be handled by command timeout
			log.warn(
				`Modal submission failed for user ${interaction.user.id}:`,
				error,
			);
			return { outcome: "timeout" };
		}
	} catch (error) {
		log.error("Failed to show raw modal:", error);
		return { outcome: "timeout" };
	}
}

/**
 * Enhanced modal function that automatically handles pagination when select options exceed 25 items
 * @param interaction - The interaction to respond to
 * @param locale - User locale for localization
 * @param options - Modal configuration options
 * @returns Promise<ModalResult> - The modal interaction result
 */
export async function promptWithPaginatedModal(
	interaction: ChatInputCommandInteraction | ButtonInteraction,
	locale: string,
	options: ModalOptions,
): Promise<ModalResult> {
	// Find the select component (should only be one per modal in current usage)
	const selectComponent = options.components.find(
		(comp): comp is ModalSelectField =>
			"options" in comp && Array.isArray(comp.options),
	);

	// If no select component or ≤25 options, use direct modal
	if (!selectComponent || selectComponent.options.length <= 25) {
		return promptWithRawModal(interaction, locale, options);
	}

	// Paginated modal system for >25 options
	const allOptions = selectComponent.options;
	const ITEMS_PER_PAGE = 25;
	const totalPages = Math.ceil(allOptions.length / ITEMS_PER_PAGE);

	// Create page selection embed
	const pageSelectEmbed = createStandardEmbed(locale, {
		titleKey: "general.pagination.select_page_title",
		descriptionKey: "general.pagination.select_page_description",
		descriptionVars: { totalItems: allOptions.length, totalPages },
		color: ColorCode.INFO,
	});

	// Create numbered page buttons (1-9, limited by total pages)
	const maxButtons = Math.min(totalPages, 9);
	const pageButtons: ButtonBuilder[] = [];

	for (let i = 1; i <= maxButtons; i++) {
		pageButtons.push(
			new ButtonBuilder()
				.setCustomId(`page_${i}`)
				.setLabel(i.toString())
				.setStyle(ButtonStyle.Primary),
		);
	}

	// Add page buttons to action row
	const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		...pageButtons,
	);

	// Send page selection message
	const pageSelectMessage = await (interaction.deferred || interaction.replied
		? interaction.editReply({
				embeds: [pageSelectEmbed],
				components: [actionRow],
			})
		: interaction.reply({
				embeds: [pageSelectEmbed],
				components: [actionRow],
				flags: MessageFlags.Ephemeral,
			}));

	try {
		// Wait for page button interaction
		const pageButtonInteraction = await pageSelectMessage.awaitMessageComponent(
			{
				filter: (i) =>
					i.user.id === interaction.user.id && i.customId.startsWith("page_"),
				time: 300_000, // 5 minutes timeout
			},
		);

		// Extract page number
		const selectedPage = Number.parseInt(
			pageButtonInteraction.customId.replace("page_", ""),
			10,
		);

		// Calculate page items
		const startIndex = (selectedPage - 1) * ITEMS_PER_PAGE;
		const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, allOptions.length);
		const pageOptions = allOptions.slice(startIndex, endIndex);

		// Create new modal options with paginated items
		const paginatedModalOptions: ModalOptions = {
			...options,
			components: options.components.map((comp) => {
				if ("options" in comp && Array.isArray(comp.options)) {
					return { ...comp, options: pageOptions };
				}
				return comp;
			}),
		};

		// Show modal with selected page items
		return promptWithRawModal(
			pageButtonInteraction as ButtonInteraction,
			locale,
			paginatedModalOptions,
		);
	} catch (error) {
		log.warn(
			`Page selection timed out or failed for user ${interaction.user.id}:`,
			error,
		);
		return { outcome: "timeout" };
	}
}
