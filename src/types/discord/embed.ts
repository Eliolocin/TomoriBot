import { ButtonStyle } from "discord.js";
import type {
	ButtonInteraction,
	ColorResolvable,
	APIEmbedField,
	EmbedField,
	MessageFlags,
} from "discord.js";

/**
 * Options for creating a standard info/status embed.
 */
export interface StandardEmbedOptions {
	titleKey: string;
	titleVars?: Record<string, string | number | boolean>; // Added
	descriptionKey: string;
	descriptionVars?: Record<string, string | number | boolean>; // Added
	color?: ColorResolvable;
	footerKey?: string;
	footerVars?: Record<string, string | number | boolean>;
	thumbnailUrl?: string;
	flags?: MessageFlags;
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
	embedDescriptionVars?: Record<string, string | number | boolean>;
	embedColor?: ColorResolvable; // Allow number or hex
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
} as const satisfies Record<TranslationProvider, ColorResolvable>;

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

export interface SummaryEmbedOptions extends StandardEmbedOptions {
	fields: Array<{
		nameKey?: string;
		name?: string; // Allow direct name string
		nameVars?: Record<string, string | number | boolean>; // Variables for the name
		valueKey?: string; // Localization key for the value
		value?: string; // Direct value string (used when valueKey is not provided)
		valueVars?: Record<string, string | number | boolean>; // Variables for the value localization
		inline?: boolean;
	}>;
}

/**
 * Interface for paginated choice options
 */
export interface PaginatedChoiceOptions {
	titleKey: string; // Localization key for the embed title
	titleVars?: Record<string, string | number | boolean>; // Variables for the title localization
	descriptionKey: string; // Localization key for the embed description
	descriptionVars?: Record<string, string | number | boolean>; // Variables for the description localization
	items: string[]; // Array of items to display (e.g., trigger words)
	itemLabelKey?: string; // Optional key to label the items (e.g., "Trigger Words:")
	color?: ColorResolvable;
	onSelect: (index: number) => Promise<void>; // Callback function when an item is selected
	onCancel?: () => Promise<void>; // Optional callback when pagination is cancelled
	ephemeral?: boolean; // Whether the message should be ephemeral
	flags?: MessageFlags;
}

/**
 * Result of a paginated choice selection
 */
export interface PaginatedChoiceResult {
	success: boolean; // Whether a selection was made successfully
	selectedIndex?: number; // The index of the selected item (if success is true)
	selectedItem?: string; // The selected item value (if success is true)
	reason?: "timeout" | "cancelled" | "error"; // Reason for failure if success is false
}
