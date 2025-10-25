/**
 * Preset Generate Command
 * AI-powered personality generation using Google Gemini
 */

import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
	Attachment,
} from "discord.js";
import { AttachmentBuilder, MessageFlags, EmbedBuilder } from "discord.js";
import { TextInputStyle } from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed, promptWithRawModal } from "../../utils/discord/interactionHelper";
import type { UserRow } from "../../types/db/schema";
import { loadTomoriState } from "../../utils/db/dbRead";
import { decryptApiKey } from "../../utils/security/crypto";
import {
	searchCharacterInfo,
	generatePresetFromPrompt,
	type GeneratePresetParams,
} from "../../providers/google/presetGenerator";
import { getServerAvatar } from "../../utils/image/avatarHelper";
import { centerCropToSquare } from "../../utils/image/imageProcessor";
import { embedMetadataInPNG } from "../../utils/image/pngMetadata";
import { presetExportDataSchema, PRESET_EXPORT_VERSION } from "../../types/preset/presetExport";
import type { PresetExport } from "../../types/preset/presetExport";
import type { ModalComponent } from "../../types/discord/modal";
import axios from "axios";

// Modal constants
const MODAL_CUSTOM_ID = "preset_generate_modal";
const CHARACTER_NAME_ID = "character_name";
const CHARACTER_DESC_ID = "character_desc";
const SPEECH_EXAMPLES_ID = "speech_examples";
const WEB_SEARCH_ID = "web_search";
const ADDITIONAL_INST_ID = "additional_inst";

/**
 * Configure the 'generate' subcommand
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("generate")
		.setDescription(localizer("en-US", "commands.preset.generate.description"))
		.addAttachmentOption((option) =>
			option
				.setName("image")
				.setDescription(
					localizer("en-US", "commands.preset.generate.image_description"),
				)
				.setRequired(false),
		);

/**
 * Convert Discord attachment to base64
 * @param attachment - Discord attachment object
 * @returns Promise<{base64: string, mimeType: string}> - Base64 data and MIME type
 */
async function attachmentToBase64(attachment: Attachment): Promise<{
	base64: string;
	mimeType: string;
}> {
	// Download the attachment
	const response = await axios.get(attachment.url, {
		responseType: "arraybuffer",
	});

	// Convert to base64
	const base64 = Buffer.from(response.data).toString("base64");
	const mimeType = attachment.contentType || "image/png";

	return { base64, mimeType };
}

/**
 * Format sample dialogues for preview display
 * @param dialoguesIn - Array of user input dialogues
 * @param dialoguesOut - Array of bot response dialogues
 * @param maxExamples - Maximum number of examples to show (default: 3)
 * @param maxLength - Maximum length per dialogue snippet (default: 100)
 * @returns Formatted dialogue preview string
 */
function formatDialoguePreview(
	dialoguesIn: string[],
	dialoguesOut: string[],
	maxExamples = 3,
	maxLength = 100,
): string {
	// 1. Determine how many dialogues to show (min of array lengths and maxExamples)
	const numDialogues = Math.min(
		dialoguesIn.length,
		dialoguesOut.length,
		maxExamples,
	);

	// 2. Build preview string with truncated dialogues
	const previews: string[] = [];
	for (let i = 0; i < numDialogues; i++) {
		const userInput = dialoguesIn[i].substring(0, maxLength);
		const botResponse = dialoguesOut[i].substring(0, maxLength);

		// 3. Add ellipsis if truncated
		const userText = dialoguesIn[i].length > maxLength ? `${userInput}...` : userInput;
		const botText = dialoguesOut[i].length > maxLength ? `${botResponse}...` : botResponse;

		// 4. Format as User/Bot pair
		previews.push(`**User:** ${userText}\n**Bot:** ${botText}`);
	}

	// 5. Join all examples with line breaks
	return previews.join("\n\n");
}

/**
 * Executes the 'generate' command
 * AI-powered personality generation using Gemini
 *
 * @param client - The Discord client instance
 * @param interaction - The chat input command interaction
 * @param _userData - The user data for the invoking user
 * @param locale - The user's preferred locale
 */
export async function execute(
	client: Client,
	interaction: ChatInputCommandInteraction,
	_userData: UserRow,
	locale: string,
): Promise<void> {
	try {
		// 1. Check if command is run in a guild (server-only command)
		if (!interaction.guild) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.guild_only_title",
				descriptionKey: "general.errors.guild_only_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 2. Load Tomori state to check provider
		const tomoriState = await loadTomoriState(interaction.guild.id);
		if (!tomoriState) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "general.errors.tomori_not_setup_title",
				descriptionKey: "general.errors.tomori_not_setup_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 3. Check if provider is Google/Gemini
		const providerName = tomoriState.llm.llm_provider.toLowerCase();
		if (providerName !== "google" && providerName !== "gemini") {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.preset.generate.wrong_provider_title",
				descriptionKey: "commands.preset.generate.wrong_provider_description",
				descriptionVars: {
					current_provider: tomoriState.llm.llm_provider,
				},
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 4. Get API key and decrypt
		if (!tomoriState.config.api_key) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.preset.generate.no_api_key_title",
				descriptionKey: "commands.preset.generate.no_api_key_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const decryptedApiKey = await decryptApiKey(tomoriState.config.api_key);
		if (!decryptedApiKey) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.preset.generate.api_key_decrypt_failed_title",
				descriptionKey:
					"commands.preset.generate.api_key_decrypt_failed_description",
				color: ColorCode.ERROR,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 5. Get optional image attachment
		const imageAttachment = interaction.options.getAttachment("image");
		let imageBase64: string | undefined;
		let imageMimeType: string | undefined;

		if (imageAttachment) {
			// Validate image type
			if (
				!imageAttachment.contentType?.startsWith("image/")
			) {
				await replyInfoEmbed(interaction, locale, {
					titleKey: "commands.preset.generate.invalid_image_title",
					descriptionKey: "commands.preset.generate.invalid_image_description",
					color: ColorCode.ERROR,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			try {
				const { base64, mimeType } = await attachmentToBase64(imageAttachment);
				imageBase64 = base64;
				imageMimeType = mimeType;
				log.info("Image attachment converted to base64");
			} catch (error) {
				log.error("Failed to convert image attachment:", error);
				await replyInfoEmbed(interaction, locale, {
					titleKey: "commands.preset.generate.image_download_failed_title",
					descriptionKey:
						"commands.preset.generate.image_download_failed_description",
					color: ColorCode.ERROR,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
		}

		// 6. Show modal with generation fields
		const modalComponents: ModalComponent[] = [
			{
				customId: CHARACTER_NAME_ID,
				labelKey: "commands.preset.generate.modal.character_name_label",
				placeholder: "commands.preset.generate.modal.character_name_placeholder",
				required: true,
				style: TextInputStyle.Short,
				maxLength: 100,
			},
			{
				customId: CHARACTER_DESC_ID,
				labelKey: "commands.preset.generate.modal.character_desc_label",
				placeholder: "commands.preset.generate.modal.character_desc_placeholder",
				required: true,
				style: TextInputStyle.Paragraph,
				maxLength: 1000,
			},
			{
				customId: SPEECH_EXAMPLES_ID,
				labelKey: "commands.preset.generate.modal.speech_examples_label",
				placeholder: "commands.preset.generate.modal.speech_examples_placeholder",
				required: true,
				style: TextInputStyle.Paragraph,
				maxLength: 1000,
			},
			{
				customId: WEB_SEARCH_ID,
				labelKey: "commands.preset.generate.modal.web_search_label",
				descriptionKey: "commands.preset.generate.modal.web_search_description",
				placeholder: "commands.preset.generate.modal.web_search_placeholder",
				required: true,
				options: [
					{
						label: localizer(locale, "commands.preset.generate.modal.web_search_yes"),
						value: "yes",
					},
					{
						label: localizer(locale, "commands.preset.generate.modal.web_search_no"),
						value: "no",
					},
				],
			},
			{
				customId: ADDITIONAL_INST_ID,
				labelKey: "commands.preset.generate.modal.additional_inst_label",
				placeholder: "commands.preset.generate.modal.additional_inst_placeholder",
				required: false,
				style: TextInputStyle.Paragraph,
				maxLength: 500,
			},
		];

		const modalResult = await promptWithRawModal(interaction, locale, {
			modalCustomId: MODAL_CUSTOM_ID,
			modalTitleKey: "commands.preset.generate.modal.title",
			components: modalComponents,
		});

		// 7. Handle modal outcome
		if (modalResult.outcome !== "submit") {
			log.info(`Generate modal ${modalResult.outcome}`);
			return;
		}

		const modalSubmitInteraction = modalResult.interaction;
		const characterName = modalResult.values?.[CHARACTER_NAME_ID];
		const characterDesc = modalResult.values?.[CHARACTER_DESC_ID];
		const speechExamples = modalResult.values?.[SPEECH_EXAMPLES_ID];
		const webSearch = modalResult.values?.[WEB_SEARCH_ID];
		const additionalInst = modalResult.values?.[ADDITIONAL_INST_ID];

		// Safety checks
		if (
			!modalSubmitInteraction ||
			!characterName ||
			!characterDesc ||
			!speechExamples ||
			!webSearch
		) {
			log.error("Modal result unexpectedly missing values");
			return;
		}

		// 8. Defer reply with processing message (not ephemeral - public visibility)
		await modalSubmitInteraction.deferReply();

		// 9. Show processing embed
		await modalSubmitInteraction.editReply({
			embeds: [
				new EmbedBuilder()
					.setTitle(localizer(locale, "commands.preset.generate.processing_title"))
					.setDescription(
						localizer(locale, "commands.preset.generate.processing_description"),
					)
					.setColor(ColorCode.INFO),
			],
		});

		// 10. Optionally perform web search with full context
		let searchInfo: string | undefined;
		if (webSearch.toLowerCase() === "yes") {
			log.info("Performing web search for character information...");
			const searchResult = await searchCharacterInfo(
				decryptedApiKey,
				characterName,
				{
					description: characterDesc,
					speechExamples: speechExamples,
					additionalInstructions: additionalInst,
				},
			);

			if (searchResult.error) {
				log.warn(`Web search failed: ${searchResult.error}`);
				// Continue anyway - generation can work without search
			} else {
				searchInfo = searchResult.characterInfo;
				log.success("Web search completed successfully");
			}
		}

		// 11. Prepare generation parameters
		const genParams: GeneratePresetParams = {
			characterName,
			characterDescription: characterDesc,
			speechExamples,
			additionalInstructions: additionalInst,
			imageBase64,
			imageMimeType,
			searchInfo,
		};

		// 12. Generate preset data
		log.info("Generating preset data with Gemini...");
		const genResult = await generatePresetFromPrompt(decryptedApiKey, genParams);

		if (genResult.error || !genResult.preset) {
			// Show error embed
			await modalSubmitInteraction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(
							localizer(locale, "commands.preset.generate.generation_failed_title"),
						)
						.setDescription(
							localizer(
								locale,
								"commands.preset.generate.generation_failed_description",
								{
									error: genResult.error || "Unknown error",
								},
							),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 13. Validate generated data against schema
		const validationResult = presetExportDataSchema.safeParse(genResult.preset);
		if (!validationResult.success) {
			// Log detailed validation errors
			log.error("Generated preset failed validation:");
			log.error("Validation errors:", JSON.stringify(validationResult.error.format(), null, 2));
			log.error("Generated preset data:", JSON.stringify(genResult.preset, null, 2));

			// Extract specific error messages for user
			const errorDetails = validationResult.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("\n");

			await modalSubmitInteraction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(
							localizer(
								locale,
								"commands.preset.generate.validation_failed_title",
							),
						)
						.setDescription(
							`${localizer(
								locale,
								"commands.preset.generate.validation_failed_description",
							)}\n\n**Details:**\n\`\`\`\n${errorDetails.substring(0, 500)}\n\`\`\``,
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		log.success("Generated preset passed validation");

		// 14. Get image for export (uploaded image or server avatar)
		let pngBuffer: Buffer;

		if (imageAttachment) {
			// Use uploaded image
			try {
				const imageResponse = await axios.get(imageAttachment.url, {
					responseType: "arraybuffer",
				});
				const imageBuffer = Buffer.from(imageResponse.data);

				// Crop to 1:1 square
				pngBuffer = await centerCropToSquare(imageBuffer);
				log.info("Uploaded image cropped to 1:1 square");
			} catch (error) {
				log.error("Failed to process uploaded image:", error);
				await modalSubmitInteraction.editReply({
					embeds: [
						new EmbedBuilder()
							.setTitle(
								localizer(
									locale,
									"commands.preset.generate.image_processing_failed_title",
								),
							)
							.setDescription(
								localizer(
									locale,
									"commands.preset.generate.image_processing_failed_description",
								),
							)
							.setColor(ColorCode.ERROR),
					],
				});
				return;
			}
		} else {
			// Use server avatar
			try {
				const avatarBuffer = await getServerAvatar(interaction.guild, client);
				pngBuffer = await centerCropToSquare(avatarBuffer);
				log.info("Server avatar cropped to 1:1 square");
			} catch (error) {
				log.error("Failed to get server avatar:", error);
				await modalSubmitInteraction.editReply({
					embeds: [
						new EmbedBuilder()
							.setTitle(
								localizer(
									locale,
									"commands.preset.generate.avatar_fetch_failed_title",
								),
							)
							.setDescription(
								localizer(
									locale,
									"commands.preset.generate.avatar_fetch_failed_description",
								),
							)
							.setColor(ColorCode.ERROR),
					],
				});
				return;
			}
		}

		// 15. Create preset export structure with metadata
		const presetExport: PresetExport = {
			version: PRESET_EXPORT_VERSION,
			type: "preset",
			exported_at: new Date().toISOString(),
			data: genResult.preset,
		};

		// 16. Embed metadata in PNG
		let finalPngBuffer: Buffer;
		try {
			finalPngBuffer = await embedMetadataInPNG(pngBuffer, presetExport);
			log.success("Metadata embedded in PNG");
		} catch (error) {
			log.error("Failed to embed metadata in PNG:", error);
			await modalSubmitInteraction.editReply({
				embeds: [
					new EmbedBuilder()
						.setTitle(
							localizer(
								locale,
								"commands.preset.generate.metadata_embed_failed_title",
							),
						)
						.setDescription(
							localizer(
								locale,
								"commands.preset.generate.metadata_embed_failed_description",
							),
						)
						.setColor(ColorCode.ERROR),
				],
			});
			return;
		}

		// 17. Create attachment
		const filename = `${characterName.replace(/[^a-zA-Z0-9]/g, "_")}_preset.png`;
		const attachment = new AttachmentBuilder(finalPngBuffer, {
			name: filename,
		});

		// 18. Create success embed with main image
		// Format attribute preview (first attribute, truncated to 200 chars)
		const attributePreview = genResult.preset.attribute_list[0]
			? `${genResult.preset.attribute_list[0].substring(0, 200)}...`
			: "No attributes generated";

		// Format dialogue preview (up to 3 examples, 100 chars each)
		const dialoguePreview = formatDialoguePreview(
			genResult.preset.sample_dialogues_in,
			genResult.preset.sample_dialogues_out,
			3,
			100,
		);

		const successEmbed = new EmbedBuilder()
			.setTitle(
				localizer(locale, "commands.preset.generate.success_title", {
					character_name: characterName,
				}),
			)
			.setDescription(
				localizer(locale, "commands.preset.generate.success_description", {
					character_name: characterName,
					attribute_preview: attributePreview,
					dialogue_preview: dialoguePreview,
				}),
			)
			.setColor(ColorCode.SUCCESS)
			.setImage(`attachment://${filename}`)
			.addFields([
				{
					name: localizer(locale, "commands.preset.generate.success_next_steps_title"),
					value: localizer(
						locale,
						"commands.preset.generate.success_next_steps_description",
					),
					inline: false,
				},
			]);

		// 19. Send success embed with attachment
		await modalSubmitInteraction.editReply({
			embeds: [successEmbed],
			files: [attachment],
		});

		log.success(`Preset generated successfully for: ${characterName}`);
	} catch (error) {
		log.error("Error in preset generate command:", error);
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		// Try to send error embed if possible
		try {
			const errorEmbed = new EmbedBuilder()
				.setTitle(localizer(locale, "general.errors.unexpected_title"))
				.setDescription(
					localizer(locale, "general.errors.unexpected_description", {
						error: errorMessage,
					}),
				)
				.setColor(ColorCode.ERROR);

			if (interaction.deferred || interaction.replied) {
				await interaction.editReply({ embeds: [errorEmbed] });
			} else {
				await interaction.reply({
					embeds: [errorEmbed],
					flags: MessageFlags.Ephemeral,
				});
			}
		} catch {
			// If we can't send the error embed, just log it
			log.error("Failed to send error embed");
		}
	}
}
