import type { TextInputStyle } from "discord.js";

/**
 * Options for text input fields in a modal
 */
export interface ModalInputField {
	customId: string;
	labelKey: string;
	style?: TextInputStyle;
	placeholder?: string;
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	value?: string;
}

/**
 * Configuration options for creating a modal
 */
export interface ModalOptions {
	modalTitleKey: string;
	modalCustomId: string;
	inputs: ModalInputField[];
	timeout?: number;
}

/**
 * Result type for modal interactions
 */
export type ModalResult = {
	outcome: "submit" | "timeout";
	values?: Record<string, string>; // The collected field values if outcome is 'submit'
};
