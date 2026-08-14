import type { ModalSubmitInteraction, TextInputStyle, APIAttachment } from "discord.js";

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
 * A single option within a Radio Group (type 21)
 * Note: Radio Group options do not support emojis in the current API
 */
export interface RadioGroupOption {
  /** Developer-defined value submitted on selection; max 100 chars */
  value: string;
  /** User-facing label displayed beside the radio button; max 100 chars */
  label: string;
  /** Optional description shown below the label; max 100 chars */
  description?: string;
  /** Whether this option is pre-selected when the modal opens */
  default?: boolean;
}

/**
 * A single option within a Checkbox Group (type 22)
 */
export interface CheckboxGroupOption {
  /** Developer-defined value submitted when checked; max 100 chars */
  value: string;
  /** User-facing label displayed beside the checkbox; max 100 chars */
  label: string;
  /** Optional description shown below the label; max 100 chars */
  description?: string;
  /** Whether this option is pre-checked when the modal opens */
  default?: boolean;
}

/**
 * Options for a Radio Group field in a modal (Discord component type 21)
 * Allows the user to select exactly one option from a fixed list (2-10 options).
 * Use the `kind` discriminant to identify this type in the ModalComponent union.
 */
export interface ModalRadioGroupField {
  kind: "radioGroup";
  customId: string;
  labelKey: string;
  descriptionKey?: string;
  /** List of options to display; min 2, max 10 */
  options: RadioGroupOption[];
  /** Whether a selection is required before submitting (default: true) */
  required?: boolean;
}

/**
 * Options for a Checkbox Group field in a modal (Discord component type 22)
 * Allows the user to select one or many options from a list (1-10 options).
 * Use a single option with `required: true` as a "required boolean" pattern.
 * Use the `kind` discriminant to identify this type in the ModalComponent union.
 */
export interface ModalCheckboxGroupField {
  kind: "checkboxGroup";
  customId: string;
  labelKey: string;
  descriptionKey?: string;
  /** List of options to display; min 1, max 10 */
  options: CheckboxGroupOption[];
  /** Minimum number of options that must be selected (default: 1) */
  minValues?: number;
  /** Maximum number of options that can be selected (default: options.length) */
  maxValues?: number;
  /** Whether the group is required to be interacted with before submitting (default: true) */
  required?: boolean;
}

/**
 * Options for a Checkbox field in a modal (Discord component type 23)
 * A single binary toggle , so cannot be set as required (use Checkbox Group with 1 option instead).
 * Use the `kind` discriminant to identify this type in the ModalComponent union.
 */
export interface ModalCheckboxField {
  kind: "checkbox";
  customId: string;
  labelKey: string;
  descriptionKey?: string;
  /** Whether the checkbox is pre-checked when the modal opens */
  default?: boolean;
}

/**
 * Options for file upload fields in a modal
 * Uses Discord Component Type 19 (FILE_UPLOAD) wrapped in Component Type 18 (LABEL)
 */
export interface ModalFileUploadField {
  customId: string;
  labelKey: string;
  descriptionKey?: string;
  minValues?: number; // Minimum number of files (0-10, defaults to 1)
  maxValues?: number; // Maximum number of files (1-10, defaults to 1)
  required?: boolean; // Whether files are required before submitting (defaults to true)
}

/**
 * Union type for all modal component types
 */
export type ModalComponent =
  | ModalInputField
  | ModalSelectField
  | ModalFileUploadField
  | ModalRadioGroupField
  | ModalCheckboxGroupField
  | ModalCheckboxField;

/**
 * Type guard for text input fields
 */
export function isModalInputField(component: ModalComponent): component is ModalInputField {
  return (
    "style" in component || (!("options" in component) && !("minValues" in component) && !("maxValues" in component))
  );
}

/**
 * Type guard for select fields
 */
export function isModalSelectField(component: ModalComponent): component is ModalSelectField {
  return "options" in component;
}

/**
 * Type guard for file upload fields
 */
export function isModalFileUploadField(component: ModalComponent): component is ModalFileUploadField {
  return "minValues" in component || "maxValues" in component;
}

/**
 * Type guard for Radio Group fields (type 21)
 * Uses the `kind` discriminant to avoid ambiguity with other option-bearing types.
 */
export function isModalRadioGroupField(component: ModalComponent): component is ModalRadioGroupField {
  return "kind" in component && (component as ModalRadioGroupField).kind === "radioGroup";
}

/**
 * Type guard for Checkbox Group fields (type 22)
 * Uses the `kind` discriminant to avoid ambiguity with other option-bearing types.
 */
export function isModalCheckboxGroupField(component: ModalComponent): component is ModalCheckboxGroupField {
  return "kind" in component && (component as ModalCheckboxGroupField).kind === "checkboxGroup";
}

/**
 * Type guard for Checkbox fields (type 23)
 * Uses the `kind` discriminant to distinguish from other non-option types.
 */
export function isModalCheckboxField(component: ModalComponent): component is ModalCheckboxField {
  return "kind" in component && (component as ModalCheckboxField).kind === "checkbox";
}

/**
 * Configuration options for creating a modal
 * Discord handles modal timeouts naturally (~15 minutes), so no timeout option is needed
 */
export interface ModalOptions {
  modalTitleKey: string;
  modalCustomId: string;
  components: ModalComponent[]; // Changed from inputs to components
  /**
   * Which `>25`-option page selector to render in `promptWithPaginatedModal`.
   *
   * - `"legacy"` (default): numbered page-button embed on the interaction's reply.
   * - `"componentsV2"`: the shared Components V2 range selector
   *   (`1-25`/`26-50` ranges + Previous/Cancel/Next), identical to the persona
   *   workflow's `>25` shell.
   *
   * At `<=25` options both styles are byte-identical (a direct modal), so this only
   * affects the paginated path. Defaults to `"legacy"` so existing callers are
   * unchanged by construction until they explicitly opt in.
   */
  selectorStyle?: "legacy" | "componentsV2";
}

/**
 * Result type for modal interactions
 */
export type ModalResult = {
  /**
   * `submit`: the user completed the modal. `timeout`: the selector or modal
   * expired. `error` : a delivery/collection failure (see {@link ModalResult.error}).
   * `cancelled` : the user clicked the Cancel button on the `componentsV2` range
   * selector (the legacy page selector has no Cancel button, so it never returns this).
   * Callers that gate on `outcome !== "submit"` already handle every non-submit case.
   */
  outcome: "submit" | "timeout" | "error" | "cancelled";
  /** Scalar string values from text inputs, radio groups (selected value), and checkboxes ("true"/"false") */
  values?: Record<string, string>;
  /** Array values from checkbox groups : keyed by customId, value is the array of selected option values */
  multiValues?: Record<string, string[]>;
  /** Resolved attachments from file upload components, keyed by customId */
  attachments?: Record<string, APIAttachment>;
  /** The raw modal submit interaction for further Discord API calls */
  interaction?: ModalSubmitInteraction;
  /** Preserved failure when displaying or collecting the modal fails for a reason other than timeout. */
  error?: unknown;
};
