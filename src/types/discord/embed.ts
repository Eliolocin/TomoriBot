import { ButtonStyle } from "discord.js";
import type {
	ButtonInteraction,
	ColorResolvable,
	APIEmbedField,
	EmbedField,
} from "discord.js";

/**
 * Standard options for creating an info embed
 */
export interface StandardEmbedOptions {
	titleKey: string;
	descriptionKey: string;
	descriptionVars?: Record<string, string | number>;
	color?: `#${string}`;
	footerKey?: string;
	footerVars?: Record<string, string | number>;
	thumbnailUrl?: string;
}

/**
 * Options for translation embeds
 */
export interface TranslationEmbedOptions {
	text: string;
	translations: Record<TranslationProvider, string>;
	initialProvider?: TranslationProvider;
	timeout?: number;
}

/**
 * Options for confirmation embeds with buttons
 */
export interface ConfirmationOptions {
	embedTitleKey: string;
	embedDescriptionKey: string;
	embedDescriptionVars?: Record<string, string | number>;
	embedColor?: ColorResolvable;
	continueLabelKey: string;
	cancelLabelKey: string;
	continueCustomId: string;
	cancelCustomId: string;
	timeout?: number;
}

/**
 * Result type for confirmation interactions
 */
export type ConfirmationResult = {
	outcome: "continue" | "cancel" | "timeout";
	interaction?: ButtonInteraction; // The button interaction if outcome is 'continue'
};

/**
 * Available translation providers
 */
export enum TranslationProvider {
	GOOGLE = "google",
	DEEPL = "deepl",
	BING = "bing",
}

/**
 * Brand colors for translation providers
 */
export const TRANSLATOR_COLORS = {
	[TranslationProvider.GOOGLE]: "#DE3163", // Google red
	[TranslationProvider.DEEPL]: "#09B1CE", // DeepL blue
	[TranslationProvider.BING]: "#7DDA58", // Bing green
} as const satisfies Record<TranslationProvider, `#${string}`>;

/**
 * Discord button styles for translation providers
 */
export const TRANSLATOR_STYLES = {
	[TranslationProvider.GOOGLE]: ButtonStyle.Danger,
	[TranslationProvider.DEEPL]: ButtonStyle.Primary,
	[TranslationProvider.BING]: ButtonStyle.Success,
} as const satisfies Record<TranslationProvider, ButtonStyle>;

/**
 * Helper type for accessing translator properties
 */
export type Provider = keyof typeof TRANSLATOR_COLORS;

/**
 * Field pair for summary embeds
 */
export interface SummaryField {
	nameKey: string;
	value: string | number | APIEmbedField | EmbedField;
	vars?: Record<string, string | number>;
}

/**
 * Options for summary embeds
 */
export interface SummaryEmbedOptions {
	titleKey: string;
	descriptionKey: string;
	descriptionVars?: Record<string, string | number>;
	color?: ColorResolvable;
	fields: SummaryField[];
}
