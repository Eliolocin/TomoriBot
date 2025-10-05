import type {
	ChatInputCommandInteraction,
	Client,
	SlashCommandSubcommandBuilder,
	Attachment,
} from "discord.js";
import { MessageFlags } from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed } from "../../utils/discord/interactionHelper";
import type { UserRow, ErrorContext } from "../../types/db/schema";

/**
 * Configure the avatar subcommand
 * @param subcommand - SlashCommandSubcommandBuilder instance
 * @returns Configured subcommand
 */
export const configureSubcommand = (
	subcommand: SlashCommandSubcommandBuilder,
) =>
	subcommand
		.setName("avatar")
		.setDescription(localizer("en-US", "commands.config.avatar.description"))
		.addAttachmentOption((option) =>
			option
				.setName("image")
				.setDescription(
					localizer("en-US", "commands.config.avatar.image_description"),
				)
				.setDescriptionLocalizations({
					ja: localizer("ja", "commands.config.avatar.image_description"),
				})
				.setRequired(false),
		);

/**
 * Validates if the provided attachment is a valid image
 * @param attachment - Discord attachment to validate
 * @returns Object with isValid boolean and error message if invalid
 */
function validateImage(attachment: Attachment): {
	isValid: boolean;
	error?: string;
} {
	// 1. Check file size (Discord's limit is 8MB for bots)
	const maxSize = 8 * 1024 * 1024; // 8MB in bytes
	if (attachment.size > maxSize) {
		return {
			isValid: false,
			error: "FILE_TOO_LARGE",
		};
	}

	// 2. Check content type
	const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/gif"];
	if (
		!attachment.contentType ||
		!allowedTypes.includes(attachment.contentType)
	) {
		return {
			isValid: false,
			error: "INVALID_FORMAT",
		};
	}

	// 3. Check file extension as backup validation
	const allowedExtensions = [".png", ".jpg", ".jpeg", ".gif"];
	const fileExtension = attachment.name?.toLowerCase().split(".").pop();
	if (!fileExtension || !allowedExtensions.includes(`.${fileExtension}`)) {
		return {
			isValid: false,
			error: "INVALID_EXTENSION",
		};
	}

	return { isValid: true };
}

/**
 * Converts an image attachment to a base64 data URI
 * @param attachment - Discord attachment to convert
 * @returns Promise resolving to data URI string
 */
async function attachmentToBase64DataUri(
	attachment: Attachment,
): Promise<string> {
	try {
		// 1. Fetch the image data
		const response = await fetch(attachment.url);
		if (!response.ok) {
			throw new Error(`Failed to fetch image: ${response.statusText}`);
		}

		// 2. Get the image buffer
		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		// 3. Convert to base64
		const base64 = buffer.toString("base64");

		// 4. Create data URI with proper MIME type
		const mimeType = attachment.contentType || "image/png";
		return `data:${mimeType};base64,${base64}`;
	} catch (error) {
		throw new Error(`Failed to convert image to base64: ${error}`);
	}
}

/**
 * Updates the bot's guild avatar using Discord's raw API
 * @param guildId - Guild ID where to update the avatar
 * @param avatarDataUri - Base64 data URI of the avatar image, or null to remove
 * @returns Promise resolving to success boolean
 */
async function updateGuildAvatar(
	guildId: string,
	avatarDataUri: string | null,
): Promise<boolean> {
	try {
		// 1. Prepare the API endpoint
		const endpoint = `https://discord.com/api/v10/guilds/${guildId}/members/@me`;

		// 2. Prepare the payload
		const payload = {
			avatar: avatarDataUri,
		};

		// 3. Make the API call
		const response = await fetch(endpoint, {
			method: "PATCH",
			headers: {
				Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const errorText = await response.text();
			log.error(
				`Failed to update guild avatar: ${response.status} ${response.statusText} - ${errorText}`,
			);
			return false;
		}

		return true;
	} catch (error) {
		log.error("Error updating guild avatar via Discord API", error);
		return false;
	}
}

/**
 * Sets or removes TomoriBot's custom avatar for the current guild
 * @param client - Discord client instance
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
	// 1. Ensure command is run in a guild
	if (!interaction.guild || !interaction.channel) {
		await replyInfoEmbed(interaction, userData.language_pref, {
			titleKey: "general.errors.guild_only_title",
			descriptionKey: "general.errors.guild_only_description",
			color: ColorCode.ERROR,
		});
		return;
	}

	// 2. Defer the reply to prevent timeout during image processing
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	try {
		// 3. Get the attachment option
		const imageAttachment = interaction.options.getAttachment("image");

		// 4. Handle avatar removal (no attachment provided)
		if (!imageAttachment) {
			const success = await updateGuildAvatar(interaction.guild.id, null);

			if (success) {
				await replyInfoEmbed(interaction, locale, {
					titleKey: "commands.config.avatar.removed_title",
					descriptionKey: "commands.config.avatar.removed_description",
					color: ColorCode.SUCCESS,
				});
			} else {
				await replyInfoEmbed(interaction, locale, {
					titleKey: "commands.config.avatar.api_error_title",
					descriptionKey: "commands.config.avatar.api_error_description",
					color: ColorCode.ERROR,
				});
			}
			return;
		}

		// 5. Validate the image attachment
		const validation = validateImage(imageAttachment);
		if (!validation.isValid) {
			let errorKey = "invalid_image_description";
			switch (validation.error) {
				case "FILE_TOO_LARGE":
					errorKey = "file_too_large_description";
					break;
				case "INVALID_FORMAT":
				case "INVALID_EXTENSION":
					errorKey = "invalid_format_description";
					break;
			}

			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.avatar.invalid_image_title",
				descriptionKey: `commands.config.avatar.${errorKey}`,
				color: ColorCode.ERROR,
			});
			return;
		}

		// 6. Convert image to base64 data URI
		let avatarDataUri: string;
		try {
			avatarDataUri = await attachmentToBase64DataUri(imageAttachment);
		} catch (error) {
			const context: ErrorContext = {
				errorType: "CommandExecutionError",
				metadata: {
					command: "config avatar",
					guildId: interaction.guild.id,
					attachmentSize: imageAttachment.size,
					attachmentType: imageAttachment.contentType,
				},
			};
			await log.error("Failed to convert image to base64", error, context);

			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.avatar.conversion_error_title",
				descriptionKey: "commands.config.avatar.conversion_error_description",
				color: ColorCode.ERROR,
			});
			return;
		}

		// 7. Update the guild avatar via Discord API
		const success = await updateGuildAvatar(
			interaction.guild.id,
			avatarDataUri,
		);

		if (success) {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.avatar.success_title",
				descriptionKey: "commands.config.avatar.success_description",
				color: ColorCode.SUCCESS,
			});
		} else {
			await replyInfoEmbed(interaction, locale, {
				titleKey: "commands.config.avatar.api_error_title",
				descriptionKey: "commands.config.avatar.api_error_description",
				color: ColorCode.ERROR,
			});
		}
	} catch (error) {
		const context: ErrorContext = {
			errorType: "CommandExecutionError",
			metadata: {
				command: "config avatar",
				guildId: interaction.guild.id,
			},
		};
		await log.error("Error in /config avatar command", error, context);

		await replyInfoEmbed(interaction, locale, {
			titleKey: "general.errors.unknown_error_title",
			descriptionKey: "general.errors.unknown_error_description",
			color: ColorCode.ERROR,
		});
	}
}
