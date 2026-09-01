import type { ButtonStyle } from "discord.js";
import type { ButtonInteraction, ColorResolvable, EmbedBuilder, MessageFlags } from "discord.js";

/**
 * Options for creating a standard info/status embed.
 */
export interface StandardEmbedOptions {
  titleKey: string;
  titleVars?: Record<string, string | number | boolean>; // Added
  descriptionKey?: string; // Made optional when description is provided
  description?: string; // Added: raw description text (takes precedence over descriptionKey)
  descriptionVars?: Record<string, string | number | boolean>; // Added
  color?: ColorResolvable;
  footerKey?: string;
  footerVars?: Record<string, string | number | boolean>;
  thumbnailUrl?: string;
  flags?: MessageFlags;
  timestamp?: boolean;
  /**
   * Optional atomic tip-item locale keys. When present, embed senders append a separate green
   * "💡 Tip" embed rendering these keys as a dashed bullet list. Prefer this over baking tips into
   * the main embed's description/footer , so a footer cannot render markdown or hyperlinks.
   */
  tipKeys?: string[];
  /** Shared interpolation vars applied to every tip item in {@link tipKeys}. */
  tipVars?: Record<string, string | number | boolean>;
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
  useComponentsV2?: boolean;
  continueLabelKey: string;
  cancelLabelKey: string;
  continueCustomId: string;
  cancelCustomId: string;
  timeout?: number;
  continueStyle?: ButtonStyle.Secondary | ButtonStyle.Danger;
  cancelStyle?: ButtonStyle.Secondary | ButtonStyle.Danger;
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
  BING = "bing",
}

/**
 * Brand colors for translation providers
 */
export const TRANSLATOR_COLORS = {
  [TranslationProvider.GOOGLE]: "#DE3163", // Google red
  [TranslationProvider.BING]: "#7DDA58", // Bing green
} as const satisfies Record<TranslationProvider, ColorResolvable>;

export interface SummaryEmbedOptions extends StandardEmbedOptions {
  docsPath?: string;
  docsLabelKey?: string;
  fields: Array<{
    nameKey?: string;
    name?: string; // Allow direct name string
    nameVars?: Record<string, string | number | boolean>; // Variables for the name
    valueKey?: string; // Localization key for the value
    value?: string; // Direct value string (used when valueKey is not provided)
    valueVars?: Record<string, string | number | boolean>; // Variables for the value localization
    inline?: boolean;
  }>;
  /**
   * Extra pre-built embeds to send alongside the summary embed in the same message
   * (e.g. a separate yellow "notes" embed). Sent after the main embed, in order.
   */
  appendEmbeds?: EmbedBuilder[];
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
  // When true, returns the selected button interaction unacknowledged so caller can show a modal.
  preserveSelectedInteraction?: boolean;
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
  interaction?: ButtonInteraction; // Selected button interaction (when preserveSelectedInteraction=true)
  reason?: "timeout" | "cancelled" | "error" | "fatal"; // Reason for failure if success is false; "fatal" means the Discord interaction token is dead and retrying will loop
}
