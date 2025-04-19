import { EmbedBuilder } from "discord.js";
import { ColorScheme } from "./logBeautifier";
import { localizer } from "./textLocalizer";

/**
 * Options for creating standard embeds
 */
interface StandardEmbedOptions {
	titleKey: string;
	descriptionKey: string;
	descriptionVars?: Record<string, string | number>;
	color?: (typeof ColorScheme)[keyof typeof ColorScheme];
	/**
	 * Optional footer localization key
	 */
	footerKey?: string;
	/**
	 * Optional footer variables
	 */
	footerVars?: Record<string, string | number>;
	/**
	 * Optional thumbnail URL
	 */
	thumbnailUrl?: string;
}

/**
 * Creates a standard info embed for non-interaction contexts
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
		color = ColorScheme.INFO,
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
