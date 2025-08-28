import type { ModalSubmitInteraction, TextInputStyle } from "discord.js";

/**
 * Options for string select menu choices
 */
export interface SelectOption {
	label: string;
	value: string;
	description?: string;
	emoji?: {
		name: string;
	};
}

/**
 * Options for text input fields in a modal
 */
export interface ModalInputField {
	customId: string;
	labelKey: string;
	descriptionKey?: string; // New: description for the text input
	style?: TextInputStyle;
	placeholder?: string;
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	value?: string;
}

/**
 * Options for string select fields in a modal
 */
export interface ModalSelectField {
	customId: string;
	labelKey: string;
	descriptionKey?: string; // New: description for the select menu
	placeholder?: string;
	required?: boolean;
	options: SelectOption[];
}

/**
 * Union type for all modal component types
 */
export type ModalComponent = ModalInputField | ModalSelectField;

/**
 * Type guard for text input fields
 */
export function isModalInputField(component: ModalComponent): component is ModalInputField {
	return 'style' in component;
}

/**
 * Type guard for select fields
 */
export function isModalSelectField(component: ModalComponent): component is ModalSelectField {
	return 'options' in component;
}

/**
 * Configuration options for creating a modal
 * Discord handles modal timeouts naturally (~15 minutes), so no timeout option is needed
 */
export interface ModalOptions {
	modalTitleKey: string;
	modalCustomId: string;
	components: ModalComponent[]; // Changed from inputs to components
}

/**
 * Result type for modal interactions
 */
export type ModalResult = {
	outcome: "submit" | "timeout";
	values?: Record<string, string>; // The collected field values if outcome is 'submit'
	interaction?: ModalSubmitInteraction; // Add this property
};
