/**
 * Capability-specific modal component builder and field parser for custom endpoint add/edit flows.
 *
 * Phase 4.5 (updated): uses ModalComponent[] (raw modal components) instead of discord.js ModalBuilder,
 * enabling Radio Group (type 21), Checkbox Group (type 22), and Checkbox (type 23) inputs.
 *
 * Field layout per capability:
 *   text:          model_name (text), num_ctx (text), text_capabilities (checkbox group)
 *   embedding:     model_name (text)
 *   speech:        voice_mode (radio group), script_markup (radio group)
 *   transcription: transcription_model (text), transcription_language (text)
 *   image/video:   model_name (text) + workflow_json file upload (separate path via promptWithRawModal)
 *
 * For the add flow, endpoint_url and auth_token come from the initial slash params.
 * The edit flow includes endpoint_url and auth_token as editable text inputs.
 */

import type { CustomEndpointApiStyle, CustomEndpointCapability } from "@/types/db/schema";
import type { ModalComponent } from "@/types/discord/modal";
import { buildImageEndpointSupportsComponent } from "@/utils/provider/customImageEndpointSupport";
import { localizer } from "@/utils/text/localizer";

/** Custom ID for the workflow JSON file upload field (used in ComfyUI image/video edit modals). */
export const WORKFLOW_UPLOAD_ID = "workflow_json";

/** Custom IDs for each modal field */
export const ModalFieldId = {
  model_name: "model_name",
  num_ctx: "num_ctx",
  text_capabilities: "text_capabilities",
  voice_mode: "voice_mode",
  script_markup: "script_markup",
  supports_instruct: "supports_instruct",
  transcription_model: "transcription_model",
  transcription_language: "transcription_language",
  endpoint_url: "endpoint_url",
  auth_token: "auth_token",
} as const;

/** Parse a context window integer; returns null if blank or invalid (<512). */
function parseNumCtxField(value: string): number | null {
  const v = value.trim();
  if (!v || v === "-") return null;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) || n < 512 ? null : n;
}

export interface ParsedCapabilityModalFields {
  modelName: string | null;
  endpointUrl: string | null;
  authToken: string | null;
  numCtx: number | null;
  hasTools: boolean;
  seesImages: boolean;
  supportsStructOutput: boolean;
  strictRoleAlternation: boolean;
  supportsPrefixCompletion: boolean;
  scriptMarkup: "plain" | "bracket-tags" | "emoji";
  voiceMode: "clone" | "voice-design" | "auto";
  supportsInstruct: boolean;
  transcriptionModel: string | null;
  transcriptionLanguage: string | null;
}

/**
 * Parse modal submission values into typed fields.
 */
export function parseCapabilityModalFields(
  values: Record<string, string>,
  multiValues: Record<string, string[]>,
  capability: CustomEndpointCapability,
): ParsedCapabilityModalFields {
  const result: ParsedCapabilityModalFields = {
    modelName: null,
    endpointUrl: values[ModalFieldId.endpoint_url]?.trim() || null,
    authToken: values[ModalFieldId.auth_token]?.trim() || null,
    numCtx: null,
    hasTools: false,
    seesImages: false,
    supportsStructOutput: false,
    strictRoleAlternation: false,
    supportsPrefixCompletion: false,
    scriptMarkup: "plain",
    voiceMode: "clone",
    supportsInstruct: false,
    transcriptionModel: null,
    transcriptionLanguage: null,
  };

  switch (capability) {
    case "text": {
      result.modelName = values[ModalFieldId.model_name]?.trim() || null;
      result.numCtx = parseNumCtxField(values[ModalFieldId.num_ctx] ?? "");
      const selectedCaps = new Set(multiValues[ModalFieldId.text_capabilities] ?? []);
      result.hasTools = selectedCaps.has("tools");
      result.seesImages = selectedCaps.has("vision");
      result.supportsStructOutput = selectedCaps.has("structoutput");
      result.strictRoleAlternation = selectedCaps.has("rolealt");
      result.supportsPrefixCompletion = selectedCaps.has("prefixcompletion");
      break;
    }
    case "embedding": {
      result.modelName = values[ModalFieldId.model_name]?.trim() || null;
      break;
    }
    case "image":
    case "video": {
      result.modelName = values[ModalFieldId.model_name]?.trim() || null;
      break;
    }
    case "speech": {
      const rawVoiceMode = values[ModalFieldId.voice_mode]?.trim().toLowerCase();
      result.voiceMode = rawVoiceMode === "voice-design" || rawVoiceMode === "auto" ? rawVoiceMode : "clone";
      const rawMarkup = values[ModalFieldId.script_markup]?.trim().toLowerCase();
      result.scriptMarkup = rawMarkup === "bracket-tags" || rawMarkup === "emoji" ? rawMarkup : "plain";
      result.supportsInstruct =
        result.voiceMode === "voice-design" ||
        result.voiceMode === "auto" ||
        values[ModalFieldId.supports_instruct] === "true";
      break;
    }
    case "transcription": {
      result.transcriptionModel = values[ModalFieldId.transcription_model]?.trim() || null;
      result.transcriptionLanguage = values[ModalFieldId.transcription_language]?.trim() || null;
      break;
    }
  }

  return result;
}

/**
 * Build ModalComponent[] for the capability-specific add modal.
 * Routing fields (endpoint_url, auth_token) are captured via the slash command params.
 * image/video use a separate promptWithRawModal call in the command layer (file upload support).
 */
export function buildCapabilityAddModalComponents(
  capability: CustomEndpointCapability,
  locale: string,
): ModalComponent[] {
  switch (capability) {
    case "text":
      return [
        {
          customId: ModalFieldId.model_name,
          labelKey: "commands.config.custom_models.capability_modal.model_name_label",
          placeholder: localizer(locale, "commands.config.custom_models.capability_modal.model_name_placeholder"),
          required: true,
          maxLength: 200,
        },
        {
          customId: ModalFieldId.num_ctx,
          labelKey: "commands.config.custom_models.capability_modal.num_ctx_label",
          placeholder: localizer(locale, "commands.config.custom_models.capability_modal.num_ctx_placeholder"),
          required: false,
          maxLength: 8,
        },
        {
          kind: "checkboxGroup" as const,
          customId: ModalFieldId.text_capabilities,
          labelKey: "commands.config.custom_models.capability_modal.text_capabilities_label",
          descriptionKey: "commands.config.custom_models.capability_modal.text_capabilities_description",
          options: [
            {
              value: "tools",
              label: localizer(locale, "commands.config.custom_models.capability_modal.text_cap_tools"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.text_cap_tools_description",
              ),
            },
            {
              value: "vision",
              label: localizer(locale, "commands.config.custom_models.capability_modal.text_cap_vision"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.text_cap_vision_description",
              ),
            },
            {
              value: "structoutput",
              label: localizer(locale, "commands.config.custom_models.capability_modal.text_cap_structoutput"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.text_cap_structoutput_description",
              ),
            },
            {
              value: "rolealt",
              label: localizer(locale, "commands.config.custom_models.capability_modal.text_cap_rolealt"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.text_cap_rolealt_description",
              ),
            },
            {
              value: "prefixcompletion",
              label: localizer(locale, "commands.config.custom_models.capability_modal.text_cap_prefixcompletion"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.text_cap_prefixcompletion_description",
              ),
            },
          ],
          minValues: 0,
          required: false,
        },
      ];

    case "embedding":
      return [
        {
          customId: ModalFieldId.model_name,
          labelKey: "commands.config.custom_models.capability_modal.model_name_label",
          placeholder: localizer(locale, "commands.config.custom_models.capability_modal.model_name_placeholder"),
          required: true,
          maxLength: 200,
        },
      ];

    case "speech":
      return [
        {
          kind: "radioGroup" as const,
          customId: ModalFieldId.voice_mode,
          labelKey: "commands.config.custom_models.capability_modal.voice_mode_label",
          descriptionKey: "commands.config.custom_models.capability_modal.voice_mode_description",
          options: [
            {
              value: "clone",
              label: localizer(locale, "commands.config.custom_models.capability_modal.voice_mode_clone"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.voice_mode_clone_description",
              ),
              default: true,
            },
            {
              value: "voice-design",
              label: localizer(locale, "commands.config.custom_models.capability_modal.voice_mode_design"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.voice_mode_design_description",
              ),
            },
            {
              value: "auto",
              label: localizer(locale, "commands.config.custom_models.capability_modal.voice_mode_auto"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.voice_mode_auto_description",
              ),
            },
          ],
          required: true,
        },
        {
          kind: "radioGroup" as const,
          customId: ModalFieldId.script_markup,
          labelKey: "commands.config.custom_models.capability_modal.script_markup_label",
          descriptionKey: "commands.config.custom_models.capability_modal.script_markup_description",
          options: [
            {
              value: "plain",
              label: localizer(locale, "commands.config.custom_models.capability_modal.script_markup_plain"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.script_markup_plain_description",
              ),
              default: true,
            },
            {
              value: "bracket-tags",
              label: localizer(locale, "commands.config.custom_models.capability_modal.script_markup_bracket_tags"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.script_markup_bracket_tags_description",
              ),
            },
            {
              value: "emoji",
              label: localizer(locale, "commands.config.custom_models.capability_modal.script_markup_emoji"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.script_markup_emoji_description",
              ),
            },
          ],
          required: true,
        },
      ];

    case "transcription":
      return [
        {
          customId: ModalFieldId.transcription_model,
          labelKey: "commands.config.custom_models.capability_modal.transcription_model_label",
          placeholder: localizer(
            locale,
            "commands.config.custom_models.capability_modal.transcription_model_placeholder",
          ),
          required: true,
          maxLength: 100,
        },
        {
          customId: ModalFieldId.transcription_language,
          labelKey: "commands.config.custom_models.capability_modal.transcription_language_label",
          placeholder: localizer(
            locale,
            "commands.config.custom_models.capability_modal.transcription_language_placeholder",
          ),
          required: false,
          maxLength: 10,
        },
      ];

    case "image":
    case "video":
      return [];
  }
}

export function buildImageVideoAddModalComponents(
  capability: "image" | "video",
  locale: string,
  apiStyle: CustomEndpointApiStyle,
): ModalComponent[] {
  return [
    {
      customId: ModalFieldId.model_name,
      labelKey: "commands.config.custom_models.capability_modal.model_name_label",
      placeholder: localizer(locale, "commands.config.custom_models.capability_modal.model_name_placeholder"),
      required: true,
      maxLength: 200,
    },
    {
      customId: WORKFLOW_UPLOAD_ID,
      labelKey: "commands.config.custom_models.capability_modal.workflow_json_label",
      descriptionKey: "commands.config.custom_models.capability_modal.workflow_json_description",
      minValues: 0,
      maxValues: 1,
      required: false,
    },
    ...(capability === "image" ? [buildImageEndpointSupportsComponent(locale, apiStyle)] : []),
  ];
}

export interface EditModalExistingValues {
  modelName?: string | null;
  endpointUrl?: string | null;
  numCtx?: number | null;
  hasTools?: boolean;
  seesImages?: boolean;
  supportsStructOutput?: boolean;
  strictRoleAlternation?: boolean;
  supportsPrefixCompletion?: boolean;
  voiceMode?: string | null;
  scriptMarkup?: string | null;
  supportsInstruct?: boolean;
  transcriptionModel?: string | null;
  transcriptionLanguage?: string | null;
}

/**
 * Build ModalComponent[] for the capability-specific edit modal, pre-filled with existing values.
 * For image/video: ComfyUI endpoints include a workflow_json upload slot instead of auth_token
 * (auth token changes are rare for self-hosted ComfyUI; workflow iteration is the common edit).
 * Non-ComfyUI image/video endpoints keep auth_token and omit the workflow upload slot.
 */
export function buildCapabilityEditModalComponents(
  capability: CustomEndpointCapability,
  locale: string,
  existing: EditModalExistingValues,
  isComfyUi = false,
): ModalComponent[] {
  const urlComponent: ModalComponent = {
    customId: ModalFieldId.endpoint_url,
    labelKey: "commands.config.custom_models.capability_modal.endpoint_url_label",
    placeholder: localizer(locale, "commands.config.custom_models.capability_modal.endpoint_url_placeholder"),
    required: false,
    maxLength: 500,
    value: existing.endpointUrl ?? undefined,
  };

  switch (capability) {
    case "text":
      return [
        {
          customId: ModalFieldId.model_name,
          labelKey: "commands.config.custom_models.capability_modal.model_name_label",
          placeholder: localizer(locale, "commands.config.custom_models.capability_modal.model_name_placeholder"),
          required: false,
          maxLength: 200,
          value: existing.modelName ?? undefined,
        },
        {
          customId: ModalFieldId.num_ctx,
          labelKey: "commands.config.custom_models.capability_modal.num_ctx_label",
          placeholder: localizer(locale, "commands.config.custom_models.capability_modal.num_ctx_placeholder"),
          required: false,
          maxLength: 8,
          value: existing.numCtx != null ? String(existing.numCtx) : undefined,
        },
        {
          kind: "checkboxGroup" as const,
          customId: ModalFieldId.text_capabilities,
          labelKey: "commands.config.custom_models.capability_modal.text_capabilities_label",
          descriptionKey: "commands.config.custom_models.capability_modal.text_capabilities_description",
          options: [
            {
              value: "tools",
              label: localizer(locale, "commands.config.custom_models.capability_modal.text_cap_tools"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.text_cap_tools_description",
              ),
              default: existing.hasTools ?? false,
            },
            {
              value: "vision",
              label: localizer(locale, "commands.config.custom_models.capability_modal.text_cap_vision"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.text_cap_vision_description",
              ),
              default: existing.seesImages ?? false,
            },
            {
              value: "structoutput",
              label: localizer(locale, "commands.config.custom_models.capability_modal.text_cap_structoutput"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.text_cap_structoutput_description",
              ),
              default: existing.supportsStructOutput ?? false,
            },
            {
              value: "rolealt",
              label: localizer(locale, "commands.config.custom_models.capability_modal.text_cap_rolealt"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.text_cap_rolealt_description",
              ),
              default: existing.strictRoleAlternation ?? false,
            },
            {
              value: "prefixcompletion",
              label: localizer(locale, "commands.config.custom_models.capability_modal.text_cap_prefixcompletion"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.text_cap_prefixcompletion_description",
              ),
              default: existing.supportsPrefixCompletion ?? false,
            },
          ],
          minValues: 0,
          required: false,
        },
        urlComponent,
      ];

    case "embedding":
      return [
        {
          customId: ModalFieldId.model_name,
          labelKey: "commands.config.custom_models.capability_modal.model_name_label",
          placeholder: localizer(locale, "commands.config.custom_models.capability_modal.model_name_placeholder"),
          required: false,
          maxLength: 200,
          value: existing.modelName ?? undefined,
        },
        urlComponent,
        {
          customId: ModalFieldId.auth_token,
          labelKey: "commands.config.custom_models.capability_modal.auth_token_label",
          placeholder: localizer(locale, "commands.config.custom_models.capability_modal.auth_token_placeholder"),
          required: false,
          maxLength: 500,
        },
      ];

    case "speech": {
      const currentMarkup = existing.scriptMarkup?.toLowerCase();
      const currentVoiceMode = existing.voiceMode?.toLowerCase();
      return [
        urlComponent,
        {
          customId: ModalFieldId.auth_token,
          labelKey: "commands.config.custom_models.capability_modal.auth_token_label",
          placeholder: localizer(locale, "commands.config.custom_models.capability_modal.auth_token_placeholder"),
          required: false,
          maxLength: 500,
        },
        {
          kind: "radioGroup" as const,
          customId: ModalFieldId.voice_mode,
          labelKey: "commands.config.custom_models.capability_modal.voice_mode_label",
          descriptionKey: "commands.config.custom_models.capability_modal.voice_mode_description",
          options: [
            {
              value: "clone",
              label: localizer(locale, "commands.config.custom_models.capability_modal.voice_mode_clone"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.voice_mode_clone_description",
              ),
              default: !currentVoiceMode || currentVoiceMode === "clone",
            },
            {
              value: "voice-design",
              label: localizer(locale, "commands.config.custom_models.capability_modal.voice_mode_design"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.voice_mode_design_description",
              ),
              default: currentVoiceMode === "voice-design",
            },
            {
              value: "auto",
              label: localizer(locale, "commands.config.custom_models.capability_modal.voice_mode_auto"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.voice_mode_auto_description",
              ),
              default: currentVoiceMode === "auto",
            },
          ],
          required: true,
        },
        {
          kind: "radioGroup" as const,
          customId: ModalFieldId.script_markup,
          labelKey: "commands.config.custom_models.capability_modal.script_markup_label",
          descriptionKey: "commands.config.custom_models.capability_modal.script_markup_description",
          options: [
            {
              value: "plain",
              label: localizer(locale, "commands.config.custom_models.capability_modal.script_markup_plain"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.script_markup_plain_description",
              ),
              default: !currentMarkup || currentMarkup === "plain",
            },
            {
              value: "bracket-tags",
              label: localizer(locale, "commands.config.custom_models.capability_modal.script_markup_bracket_tags"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.script_markup_bracket_tags_description",
              ),
              default: currentMarkup === "bracket-tags",
            },
            {
              value: "emoji",
              label: localizer(locale, "commands.config.custom_models.capability_modal.script_markup_emoji"),
              description: localizer(
                locale,
                "commands.config.custom_models.capability_modal.script_markup_emoji_description",
              ),
              default: currentMarkup === "emoji",
            },
          ],
          required: true,
        },
      ];
    }

    case "transcription":
      return [
        urlComponent,
        {
          customId: ModalFieldId.auth_token,
          labelKey: "commands.config.custom_models.capability_modal.auth_token_label",
          placeholder: localizer(locale, "commands.config.custom_models.capability_modal.auth_token_placeholder"),
          required: false,
          maxLength: 500,
        },
        {
          customId: ModalFieldId.transcription_model,
          labelKey: "commands.config.custom_models.capability_modal.transcription_model_label",
          placeholder: localizer(
            locale,
            "commands.config.custom_models.capability_modal.transcription_model_placeholder",
          ),
          required: false,
          maxLength: 100,
          value: existing.transcriptionModel ?? undefined,
        },
        {
          customId: ModalFieldId.transcription_language,
          labelKey: "commands.config.custom_models.capability_modal.transcription_language_label",
          placeholder: localizer(
            locale,
            "commands.config.custom_models.capability_modal.transcription_language_placeholder",
          ),
          required: false,
          maxLength: 10,
          value: existing.transcriptionLanguage ?? undefined,
        },
      ];

    case "image":
    case "video": {
      const baseComponents: ModalComponent[] = [
        {
          customId: ModalFieldId.model_name,
          labelKey: "commands.config.custom_models.capability_modal.model_name_label",
          placeholder: localizer(locale, "commands.config.custom_models.capability_modal.model_name_placeholder"),
          required: false,
          maxLength: 200,
          value: existing.modelName ?? undefined,
        },
        urlComponent,
      ];

      if (isComfyUi) {
        // Workflow upload replaces auth_token for ComfyUI: token changes are rare,
        // workflow iteration is the common edit operation for self-hosted ComfyUI instances.
        baseComponents.push({
          customId: WORKFLOW_UPLOAD_ID,
          labelKey: "commands.config.custom_models.capability_modal.workflow_json_label",
          descriptionKey: "commands.config.custom_models.capability_modal.workflow_json_description",
          minValues: 0,
          maxValues: 1,
          required: false,
        });
      } else {
        baseComponents.push({
          customId: ModalFieldId.auth_token,
          labelKey: "commands.config.custom_models.capability_modal.auth_token_label",
          placeholder: localizer(locale, "commands.config.custom_models.capability_modal.auth_token_placeholder"),
          required: false,
          maxLength: 500,
        });
      }

      return baseComponents;
    }
  }
}
