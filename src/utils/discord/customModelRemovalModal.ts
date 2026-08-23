import type { CustomEndpointCapability, CustomEndpointRow } from "@/types/db/schema";
import type { CheckboxGroupOption, ModalCheckboxGroupField } from "@/types/discord/modal";

const MAX_OPTIONS_PER_GROUP = 10;
export const MAX_CUSTOM_MODEL_GROUPS = 5;
const CUSTOM_MODEL_REMOVE_CHECKBOX_PREFIX = "custom_model_remove_group";

function truncateModalText(value: string | null | undefined, maxLength = 100): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function getCapabilityLabelKey(
  localeKeyRoot: string,
  capability: CustomEndpointCapability,
  continued: boolean,
): string {
  switch (capability) {
    case "text":
      return continued ? `${localeKeyRoot}.checkbox_text_label_continued` : `${localeKeyRoot}.checkbox_text_label`;
    case "embedding":
      return continued
        ? `${localeKeyRoot}.checkbox_embedding_label_continued`
        : `${localeKeyRoot}.checkbox_embedding_label`;
    case "image":
      return continued ? `${localeKeyRoot}.checkbox_image_label_continued` : `${localeKeyRoot}.checkbox_image_label`;
    case "video":
      return continued ? `${localeKeyRoot}.checkbox_video_label_continued` : `${localeKeyRoot}.checkbox_video_label`;
    case "speech":
      return continued ? `${localeKeyRoot}.checkbox_speech_label_continued` : `${localeKeyRoot}.checkbox_speech_label`;
    case "transcription":
      return continued
        ? `${localeKeyRoot}.checkbox_transcription_label_continued`
        : `${localeKeyRoot}.checkbox_transcription_label`;
  }
}

function buildCheckboxOptions(endpoints: CustomEndpointRow[]): CheckboxGroupOption[] {
  return endpoints.map((endpoint) => {
    // A label may host several models; include model_name in the label so each option is distinct.
    const modelName = endpoint.model_name?.trim();
    const optionLabel = modelName ? `${modelName} (${endpoint.label})` : endpoint.label;
    return {
      value: endpoint.custom_endpoint_id?.toString() ?? `${endpoint.capability}:${endpoint.label}`,
      label: truncateModalText(optionLabel, 100),
      description: truncateModalText(endpoint.model_name?.trim() || endpoint.label, 100),
      default: true,
    };
  });
}

export function buildCustomEndpointCheckboxGroups(
  endpoints: CustomEndpointRow[],
  localeKeyRoot: string,
): ModalCheckboxGroupField[] {
  const groups: ModalCheckboxGroupField[] = [];
  const groupedCapabilities: CustomEndpointCapability[] = [
    "text",
    "embedding",
    "image",
    "video",
    "speech",
    "transcription",
  ];
  let firstGroup = true;

  for (const capability of groupedCapabilities) {
    const capabilityEndpoints = endpoints.filter((endpoint) => endpoint.capability === capability);
    if (capabilityEndpoints.length === 0) {
      continue;
    }

    for (let i = 0; i < capabilityEndpoints.length; i += MAX_OPTIONS_PER_GROUP) {
      const chunk = capabilityEndpoints.slice(i, i + MAX_OPTIONS_PER_GROUP);
      const chunkIndex = Math.floor(i / MAX_OPTIONS_PER_GROUP);

      groups.push({
        kind: "checkboxGroup",
        customId: `${CUSTOM_MODEL_REMOVE_CHECKBOX_PREFIX}_${groups.length}`,
        labelKey: getCapabilityLabelKey(localeKeyRoot, capability, chunkIndex > 0),
        descriptionKey: firstGroup ? `${localeKeyRoot}.checkbox_description` : undefined,
        minValues: 0,
        required: false,
        options: buildCheckboxOptions(chunk),
      });

      firstGroup = false;
    }
  }

  return groups;
}

export function collectCheckedCustomEndpointValues(
  multiValues: Record<string, string[]> | undefined,
  groupCount: number,
): Set<string> {
  const checkedValues = new Set<string>();

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const values = multiValues?.[`${CUSTOM_MODEL_REMOVE_CHECKBOX_PREFIX}_${groupIndex}`] ?? [];
    for (const value of values) {
      checkedValues.add(value);
    }
  }

  return checkedValues;
}
