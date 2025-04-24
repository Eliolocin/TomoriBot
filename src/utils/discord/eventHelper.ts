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
} from "discord.js";
import { ColorCode } from "../misc/logger";
import { localizer } from "../text/localizer";
import type {
	StandardEmbedOptions,
	TranslationEmbedOptions,
} from "../../types/discord/embed";
import {
	TRANSLATOR_COLORS,
	TRANSLATOR_STYLES,
	TranslationProvider,
} from "../../types/discord/embed";

type Provider = keyof typeof TRANSLATOR_COLORS;

/**
 * Creates a standard info embed for non-interaction contexts.
 * This is a low-level utility - prefer using showEventEmbed for consistency.
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
		descriptionKey,
		descriptionVars = {},
		color = ColorCode.INFO,
		footerKey,
		footerVars = {},
		thumbnailUrl,
	} = options;

	const embed = new EmbedBuilder()
		.setColor(color)
		.setTitle(localizer(locale, titleKey))
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

/**
 * Shows a standard embed in a text channel. This follows the pattern of interactionHelpers
 * by handling the sending of the embed directly.
 * @param channel - The channel to send the embed to
 * @param locale - The locale to use for strings
 * @param options - Configuration for the embed
 * @returns Promise<void>
 */
export async function showEventEmbed(
	channel: TextChannel | NewsChannel | DMChannel,
	locale: string,
	options: StandardEmbedOptions,
): Promise<void> {
	const embed = createStandardEmbed(locale, options);
	await channel.send({ embeds: [embed] });
}

/**
 * Creates an embed with translation buttons that cycle between different translations.
 * Returns a promise that resolves when the buttons are disabled (timeout or all providers shown).
 * @param message - The message to reply to
 * @param options - Configuration for the translation embed
 * @returns Promise<void>
 */
export async function showTranslationEmbed(
	message: Message,
	options: TranslationEmbedOptions,
): Promise<void> {
	const {
		translations,
		initialProvider = TranslationProvider.GOOGLE,
		timeout = 90000,
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
