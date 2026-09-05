export const SUPPORTED_PARAM_VALUES = [
  "temperature",
  "topP",
  "topK",
  "frequencyPenalty",
  "presencePenalty",
  "minP",
] as const;

export type SupportedParamValue = (typeof SUPPORTED_PARAM_VALUES)[number];
export const SUPPORTED_PARAM_STATUS_FIELD_KEYS = {
  temperature: "commands.status.field_temperature",
  topP: "commands.status.field_top_p",
  topK: "commands.status.field_top_k",
  minP: "commands.status.field_min_p",
  frequencyPenalty: "commands.status.field_frequency_penalty",
  presencePenalty: "commands.status.field_presence_penalty",
} as const;

export function isSupportedParamValue(value: string): value is SupportedParamValue {
  return SUPPORTED_PARAM_VALUES.includes(value as SupportedParamValue);
}
