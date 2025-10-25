import {
	ActionRowBuilder,
	ButtonBuilder,
	ComponentType,
	EmbedBuilder,
	type ButtonInteraction,
	type TextChannel,
	type NewsChannel,
	type DMChannel,
	type Message,
	type APIEmbedField,
	type BaseGuildTextChannel,
} from "discord.js";
import { ColorCode } from "../misc/logger";
import { localizer } from "../text/localizer";
import type {
	StandardEmbedOptions,
	SummaryEmbedOptions,
	TranslationEmbedOptions,
} from "../../types/discord/embed";
import {
	TRANSLATOR_COLORS,
	TRANSLATOR_STYLES,
	TranslationProvider,
} from "../../types/discord/embed";

type Provider = keyof typeof TRANSLATOR_COLORS;

/**
 * Discord's maximum field value length for embeds
 */
const MAX_FIELD_VALUE_LENGTH = 1024;

/**
 * Truncates a field value to Discord's maximum allowed length.
 * Adds ellipsis if truncation occurs.
 * @param value - The field value to truncate
 * @returns Truncated value that fits within Discord's limits
 */
function truncateFieldValue(value: string): string {
	if (value.length <= MAX_FIELD_VALUE_LENGTH) {
		return value;
	}
	// Reserve 3 characters for ellipsis
	return `${value.substring(0, MAX_FIELD_VALUE_LENGTH - 3)}...`;
}

/**
 * Creates a standard info embed for non-interaction contexts.
 * This is a low-level utility - prefer using sendStandardEmbed for consistency.
 * @param locale - The locale to use for strings
 * @param options - Configuration for the embed
 * @returns EmbedBuilder instance
 */
export function createStandardEmbed(
	locale: string,
	options: StandardEmbedOptions,
): EmbedBuilder {
	const {
		titleKey,
		titleVars = {},
		descriptionKey,
		descriptionVars = {},
		color = ColorCode.INFO,
		footerKey,
		footerVars = {},
		thumbnailUrl,
	} = options;

	const embed = new EmbedBuilder()
		.setColor(color)
		.setTitle(localizer(locale, titleKey, titleVars))
		.setDescription(localizer(locale, descriptionKey, descriptionVars));

	if (footerKey) {
		embed.setFooter({
			text: localizer(locale, footerKey, footerVars),
		});
	}

	if (thumbnailUrl) {
		embed.setThumbnail(thumbnailUrl);
	}

	return embed;
}

export function createSummaryEmbed(
	locale: string,
	options: SummaryEmbedOptions,
): EmbedBuilder {
	const {
		titleKey,
		descriptionKey,
		descriptionVars = {},
		color = ColorCode.INFO,
		footerKey,
		footerVars = {},
		thumbnailUrl,
		timestamp,
		fields,
	} = options;

	const embed = new EmbedBuilder()
		.setColor(color)
		.setTitle(localizer(locale, titleKey))
		.setDescription(localizer(locale, descriptionKey, descriptionVars))
		.addFields(
			// 1. Map over the fields provided in options
			fields.map(
				// 2. Define the transformation for each field
				(field): APIEmbedField => {
					// 3. Determine the field name: Use localized nameKey if present, otherwise use direct name, fallback to empty string
					const name = field.nameKey
						? localizer(locale, field.nameKey, field.nameVars) // Use nameVars for name
						: (field.name ?? "");

					// 4. Determine the field value: Use localized valueKey if present, otherwise use direct value
					const rawValue = field.valueKey
						? localizer(locale, field.valueKey, field.valueVars) // Localize valueKey using valueVars
						: (field.value ?? ""); // Otherwise, use the value directly

					// 5. Truncate value to Discord's maximum field value length (1024 chars)
					const value = truncateFieldValue(rawValue);

					// 6. Return the structured APIEmbedField object
					return {
						name,
						value,
						inline: field.inline ?? false,
					};
				},
			),
		);

	if (footerKey) {
		embed.setFooter({
			text: localizer(locale, footerKey, footerVars),
		});
	}

	if (thumbnailUrl) {
		embed.setThumbnail(thumbnailUrl);
	}

	if (timestamp) {
		embed.setTimestamp();
	}

	return embed;
}

/**
 * Shows a standard embed in a text channel. This follows the pattern of interactionHelpers
 * by handling the sending of the embed directly.
 * @param channel - The channel to send the embed to
 * @param locale - The locale to use for strings
 * @param options - Configuration for the embed
 * @returns Promise<void>
 */
export async function sendStandardEmbed(
	channel: TextChannel | NewsChannel | DMChannel | BaseGuildTextChannel,
	locale: string,
	options: StandardEmbedOptions,
): Promise<void> {
	const embed = createStandardEmbed(locale, options);
	await channel.send({ embeds: [embed] });
}

const TRANSLATION_TIMEOUT = 90000;
/**
 * Creates an embed with translation buttons that cycle between different translations.
 * Returns a promise that resolves when the buttons are disabled (timeout or all providers shown).
 * @param message - The message to reply to
 * @param options - Configuration for the translation embed
 * @returns Promise<void>
 */
export async function sendTranslationEmbed(
	message: Message,
	options: TranslationEmbedOptions,
): Promise<void> {
	const {
		translations,
		initialProvider = TranslationProvider.GOOGLE,
		timeout = TRANSLATION_TIMEOUT,
	} = options;

	// Create buttons for each provider with their brand colors
	const createButtons = (activeProvider: Provider) => {
		const buttons = Object.values(TranslationProvider).map((provider) => {
			return new ButtonBuilder()
				.setLabel(provider.charAt(0).toUpperCase() + provider.slice(1))
				.setStyle(TRANSLATOR_STYLES[provider])
				.setCustomId(`${provider}-trans`)
				.setDisabled(provider === activeProvider);
		});
		return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
	};

	// Create embed with initial translation
	const embed = new EmbedBuilder()
		.setColor(TRANSLATOR_COLORS[initialProvider])
		.setDescription(translations[initialProvider]);

	// Send initial message
	const sentMessage = await message.reply({
		embeds: [embed],
		components: [createButtons(initialProvider)],
	});

	// Set up collector
	const collector = sentMessage.createMessageComponentCollector({
		componentType: ComponentType.Button,
		time: timeout,
	});

	collector.on("collect", async (interaction: ButtonInteraction) => {
		const provider = interaction.customId.split("-")[0] as Provider;

		embed.setColor(TRANSLATOR_COLORS[provider]);
		embed.setDescription(translations[provider]);

		await interaction.update({
			embeds: [embed],
			components: [createButtons(provider)],
		});
	});

	collector.on("end", async () => {
		const disabledButtons = createButtons(initialProvider);
		for (const button of disabledButtons.components) {
			button.setDisabled(true);
		}

		await sentMessage.edit({
			embeds: [embed],
			components: [disabledButtons],
		});
	});
}
