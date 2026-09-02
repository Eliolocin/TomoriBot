import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  TextInputStyle,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type SelectMenuComponentOptionData,
  type StringSelectMenuComponentData,
  type TopLevelComponentData,
} from "discord.js";
import type {
  ProviderPanelCapability,
  ProviderPanelCapabilitySection,
  ProviderPanelEntry,
  ProviderPanelModel,
} from "@/types/discord/providerPanel";
import type { CustomEndpointApiStyle, CustomEndpointCapability } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { resolveRangeSelection } from "@/utils/discord/interactions/panelController";
import { escapeDiscordMarkdown } from "@/utils/text/discordMarkdown";
import {
  buildProvidersRouteId,
  buildProvidersRouteSegments,
  PROVIDERS_ROUTE_NAMESPACE,
  PROVIDERS_ROUTE_VERSION,
  type ProvidersRouteNamespace,
} from "@/utils/discord/providersPanelCatalog";
import {
  buildPanelContainer,
  buildPanelReceiptContainer,
  buildPaginationRow,
  withLinePrefix,
} from "@/utils/discord/ui/panel";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import type { ImageEndpointSupports } from "@/utils/provider/customImageEndpointSupport";
import {
  SPEECH_SCRIPT_MARKUPS,
  SPEECH_VOICE_MODES,
  type SpeechEndpointSettings,
} from "@/utils/provider/customSpeechEndpointSettings";
import {
  getAllProviderChoices,
  getProviderAddChoiceDescriptionKey,
  providerUsesApiFamily,
} from "@/utils/provider/providerInfoRegistry";
import { providerRequiresAlternation, providerRequiresPrefixCompletion } from "@/providers/utils/strictChatCompat";
import { localizer } from "@/utils/text/localizer";

export const PROVIDERS_ENTRIES_PER_SELECTOR_PAGE = 23;
const MAX_MODELS_PER_SELECTOR_PAGE = 19;
export const PROVIDERS_ADD_PROVIDER_VALUE = "action:add-provider";
export const PROVIDERS_ADD_ENDPOINT_VALUE = "action:add-endpoint";

export type AddProviderModalField = "provider" | "api-key";

export function buildAddProviderModalFieldId(field: AddProviderModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildAddProviderModal(
  locale: string,
  nonce: string,
  routeNamespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
  includeBrave = true,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const curatedOptions = getAllProviderChoices()
    .filter((provider) => provider.value !== "custom")
    .map((provider) => {
      const descriptionKey = getProviderAddChoiceDescriptionKey(provider.value);
      return {
        label: safeSelectOptionText(provider.name, 100),
        value: provider.value,
        description: descriptionKey ? safeSelectOptionText(localizer(locale, descriptionKey), 100) : undefined,
      };
    });
  return {
    custom_id: buildProvidersRouteId(routeNamespace, { action: "add-submit", locale, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.providers.add_provider_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.providers.provider_label"), 45),
        description: safeSelectOptionText(
          localizer(
            locale,
            includeBrave
              ? "commands.providers.provider_description"
              : "commands.providers.provider_description_personal",
          ),
          100,
        ),
        component: {
          type: 3,
          custom_id: buildAddProviderModalFieldId("provider", nonce),
          required: true,
          options: [
            ...curatedOptions,
            {
              label: localizer(locale, "commands.providers.provider_elevenlabs"),
              value: "elevenlabs",
              description: localizer(locale, "commands.providers.provider_elevenlabs_description"),
            },
            ...(includeBrave
              ? [
                  {
                    label: localizer(locale, "commands.providers.provider_brave"),
                    value: "brave",
                    description: localizer(locale, "commands.providers.provider_brave_description"),
                  },
                ]
              : []),
          ],
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.providers.api_key_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.providers.api_key_description"), 100),
        component: {
          type: 4,
          custom_id: buildAddProviderModalFieldId("api-key", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(localizer(locale, "commands.providers.api_key_placeholder"), 100),
          min_length: 10,
          max_length: 500,
          required: true,
        },
      },
    ],
  };
}

const ENDPOINT_API_STYLES: Readonly<Record<CustomEndpointCapability, readonly CustomEndpointApiStyle[]>> = {
  text: ["openai-compatible", "ollama-native"],
  embedding: ["openai-compatible", "ollama-native"],
  image: ["openai-compatible", "comfyui"],
  video: ["openai-compatible", "comfyui"],
  speech: ["tts-clone"],
  transcription: ["openai-compatible-transcription"],
};

export type AddEndpointModalField = "label" | "url" | "api-style" | "auth-token";

export function buildAddEndpointModalFieldId(field: AddEndpointModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

function endpointTextInput(
  locale: string,
  nonce: string,
  field: Exclude<AddEndpointModalField, "api-style">,
  required: boolean,
): RawDiscordComponent {
  return {
    type: 18,
    label: safeSelectOptionText(localizer(locale, `commands.providers.endpoint_${field}_label`), 45),
    description: safeSelectOptionText(localizer(locale, `commands.providers.endpoint_${field}_description`), 100),
    component: {
      type: 4,
      custom_id: buildAddEndpointModalFieldId(field, nonce),
      style: field === "auth-token" ? TextInputStyle.Paragraph : TextInputStyle.Short,
      placeholder: safeSelectOptionText(localizer(locale, `commands.providers.endpoint_${field}_placeholder`), 100),
      max_length: field === "label" ? 40 : 500,
      required,
    },
  };
}

export function buildAddEndpointModal(
  locale: string,
  nonce: string,
  routeNamespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildProvidersRouteId(routeNamespace, { action: "endpoint-submit", locale, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.providers.add_endpoint_modal_title"), 45),
    components: [
      endpointTextInput(locale, nonce, "label", true),
      endpointTextInput(locale, nonce, "url", true),
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_api_style_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_api_style_description"), 100),
        component: {
          type: 21,
          custom_id: buildAddEndpointModalFieldId("api-style", nonce),
          required: true,
          options: [...new Set(Object.values(ENDPOINT_API_STYLES).flat())].map((style, index) => ({
            value: style,
            label: localizer(locale, `commands.providers.api_styles.${style}`),
            description: localizer(locale, `commands.providers.api_style_descriptions.${style}`),
            default: index === 0,
          })),
        },
      },
      endpointTextInput(locale, nonce, "auth-token", false),
    ],
  };
}

export type EditProviderModalField = "api-key" | "rotation-key" | "delete-rotation";

export function buildEditProviderModalFieldId(field: EditProviderModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildEditProviderModal(
  locale: string,
  provider: string,
  rotationKeyCount: number,
  nonce: string,
  routeNamespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
  allowRotation = true,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const credentialField = (field: "api-key" | "rotation-key"): RawDiscordComponent => ({
    type: 18,
    label: safeSelectOptionText(localizer(locale, `commands.providers.edit_${field}_label`), 45),
    description: safeSelectOptionText(localizer(locale, `commands.providers.edit_${field}_description`), 100),
    component: {
      type: 4,
      custom_id: buildEditProviderModalFieldId(field, nonce),
      style: TextInputStyle.Paragraph,
      placeholder: safeSelectOptionText(localizer(locale, `commands.providers.edit_${field}_placeholder`), 100),
      min_length: 10,
      max_length: 500,
      required: false,
    },
  });
  return {
    custom_id: buildProvidersRouteId(routeNamespace, {
      action: "edit-provider-submit",
      locale,
      provider,
      nonce,
    }),
    title: safeSelectOptionText(localizer(locale, "commands.providers.edit_provider_modal_title"), 45),
    components:
      provider === "brave" || !allowRotation
        ? [credentialField("api-key")]
        : [
            credentialField("api-key"),
            credentialField("rotation-key"),
            {
              type: 18,
              label: safeSelectOptionText(localizer(locale, "commands.providers.delete_rotation_label"), 45),
              description: safeSelectOptionText(
                localizer(locale, "commands.providers.delete_rotation_description", { count: rotationKeyCount }),
                100,
              ),
              component: {
                type: 21,
                custom_id: buildEditProviderModalFieldId("delete-rotation", nonce),
                required: true,
                options: [
                  { value: "keep", label: localizer(locale, "commands.providers.delete_rotation_keep"), default: true },
                  { value: "delete", label: localizer(locale, "commands.providers.delete_rotation_confirm") },
                ],
              },
            },
          ],
  };
}

export interface EditEndpointModalContext {
  connectionId: number;
  label: string;
  endpointUrl: string;
  apiStyles: string[];
  isPreset: boolean;
}

export type EditEndpointModalField = "label" | "url" | "auth-token";

export function buildEditEndpointModalFieldId(field: EditEndpointModalField, nonce: string): string {
  return `edit-${field}_${nonce}`;
}

export function buildEditEndpointModal(
  locale: string,
  context: EditEndpointModalContext,
  nonce: string,
  routeNamespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const components: RawDiscordComponent[] = context.isPreset
    ? [
        {
          type: 10,
          content: localizer(locale, "commands.providers.preset_endpoint_read_only", {
            label: context.label,
            url: context.endpointUrl,
            formats: context.apiStyles.join(", "),
          }),
        },
      ]
    : [
        {
          type: 18,
          label: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_label_label"), 45),
          description: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_label_description"), 100),
          component: {
            type: 4,
            custom_id: buildEditEndpointModalFieldId("label", nonce),
            style: TextInputStyle.Short,
            value: context.label,
            min_length: 1,
            max_length: 40,
            required: true,
          },
        },
        {
          type: 18,
          label: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_url_label"), 45),
          description: safeSelectOptionText(localizer(locale, "commands.providers.edit_endpoint_url_description"), 100),
          component: {
            type: 4,
            custom_id: buildEditEndpointModalFieldId("url", nonce),
            style: TextInputStyle.Short,
            value: context.endpointUrl,
            placeholder: safeSelectOptionText(localizer(locale, "commands.providers.endpoint_url_placeholder"), 100),
            max_length: 500,
            required: true,
          },
        },
      ];
  components.push({
    type: 18,
    label: safeSelectOptionText(localizer(locale, "commands.providers.edit_auth_token_label"), 45),
    description: safeSelectOptionText(localizer(locale, "commands.providers.edit_auth_token_description"), 100),
    component: {
      type: 4,
      custom_id: buildEditEndpointModalFieldId("auth-token", nonce),
      style: TextInputStyle.Paragraph,
      placeholder: safeSelectOptionText(localizer(locale, "commands.providers.edit_auth_token_placeholder"), 100),
      max_length: 500,
      required: false,
    },
  });
  return {
    custom_id: buildProvidersRouteId(routeNamespace, {
      action: "edit-endpoint-submit",
      locale,
      connectionId: context.connectionId,
      nonce,
    }),
    title: safeSelectOptionText(localizer(locale, "commands.providers.edit_endpoint_modal_title"), 45),
    components,
  };
}

export type ProvidersPanelPage =
  | { kind: "entry"; entryId?: string; modelRangeIndex?: number }
  | { kind: "add-provider" }
  | { kind: "remove"; entryId: string };

export type ProviderModelModalField =
  | "code-name"
  | "num-ctx"
  | "flags"
  | "compat"
  | "image-supports"
  | "voice-mode"
  | "script-markup"
  | "supports-instruct"
  | "workflow";

const MODEL_SELECTION_CAPABILITIES: readonly ProviderPanelCapability[] = [
  "text",
  "image",
  "embedding",
  "video",
  "speech",
  "transcription",
];

const TEXT_CAPABILITY_FLAGS = ["tools", "images", "structured"] as const;
const CHAT_COMPAT_FLAGS = ["strict-roles", "prefix"] as const;

/**
 * Strict role alternation and prefix completion describe the backend's parser, not the model, and
 * only the OpenAI-compatible and Anthropic adapters read their columns. A flag the request path
 * either ignores or force-overrides is a control that cannot change anything, so it is not offered.
 * Re-derive this at submit time too: a panel may outlive the answer.
 */
export function offeredChatCompatFlags(
  entryKind: "provider" | "endpoint",
  entryKey: string,
): ReadonlyArray<(typeof CHAT_COMPAT_FLAGS)[number]> {
  // A custom endpoint is served by the `custom` provider, whose OpenAI-compatible adapter reads both
  // columns. These toggles were introduced for exactly that case and must keep working there.
  const provider = entryKind === "endpoint" ? "custom" : entryKey;
  if (!providerUsesApiFamily(provider, "openai-compatible")) return [];
  return CHAT_COMPAT_FLAGS.filter((flag) =>
    flag === "strict-roles" ? !providerRequiresAlternation(provider) : !providerRequiresPrefixCompletion(provider),
  );
}

const IMAGE_SUPPORT_FIELDS: ReadonlyArray<keyof ImageEndpointSupports> = [
  "txt2img",
  "img2img",
  "inpaint",
  "negative_prompt",
];

export interface ProviderModelModalDefaults {
  codeName?: string;
  text?: ProviderPanelModel["textSettings"];
  image?: { supports: ImageEndpointSupports; allowInpaint: boolean };
  speech?: { settings: SpeechEndpointSettings; allowVoiceMode: boolean };
}

export interface ModelSelectionValue {
  mode: "add" | "edit";
  capability: ProviderPanelCapability;
  editingModelId: number | null;
}

export function buildModelSelectionValue(
  mode: "add" | "edit",
  capability: ProviderPanelCapability,
  model?: ProviderPanelModel,
): string {
  return mode === "add" ? `add:${capability}` : `edit:${capability}:${model?.id ?? 0}`;
}

function isModelSelectionCapability(value: string | undefined): value is ProviderPanelCapability {
  return MODEL_SELECTION_CAPABILITIES.includes(value as ProviderPanelCapability);
}

export function parseModelSelectionValue(raw: string | undefined): ModelSelectionValue | null {
  const [mode, capability, rawModelId] = raw?.split(":") ?? [];
  if (mode !== "add" && mode !== "edit") return null;
  if (!isModelSelectionCapability(capability)) return null;
  if (mode === "add") return { mode, capability, editingModelId: null };

  const editingModelId = Number(rawModelId);
  if (!Number.isSafeInteger(editingModelId) || editingModelId <= 0) return null;
  return { mode, capability, editingModelId };
}

export function buildProviderModelModalFieldId(field: ProviderModelModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

function entryRouteFields(entry: ProviderPanelEntry): { entryKind: "provider" | "endpoint"; entryKey: string } | null {
  if (entry.kind === "provider") return { entryKind: "provider", entryKey: entry.provider };
  if (entry.kind === "endpoint") return { entryKind: "endpoint", entryKey: String(entry.connectionIds[0] ?? 0) };
  return null;
}

function removalRouteFields(entry: ProviderPanelEntry): {
  entryKind: "provider" | "endpoint" | "brave";
  entryKey: string;
} {
  if (entry.kind === "provider") return { entryKind: "provider", entryKey: entry.provider };
  if (entry.kind === "endpoint") return { entryKind: "endpoint", entryKey: String(entry.connectionIds[0] ?? 0) };
  return { entryKind: "brave", entryKey: "brave" };
}

export function buildProviderModelModal(
  locale: string,
  entryKind: "provider" | "endpoint",
  entryKey: string,
  capability: ProviderPanelCapabilitySection["capability"],
  editingModelId: number | null,
  nonce: string,
  defaults?: ProviderModelModalDefaults,
  routeNamespace: ProvidersRouteNamespace = PROVIDERS_ROUTE_NAMESPACE,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const components: RawDiscordComponent[] = [
    {
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.providers.model_code_label"), 45),
      description: safeSelectOptionText(localizer(locale, "commands.providers.model_code_description"), 100),
      component: {
        type: 4,
        custom_id: buildProviderModelModalFieldId("code-name", nonce),
        style: TextInputStyle.Short,
        placeholder: safeSelectOptionText(
          localizer(locale, `commands.providers.model_code_placeholders.${capability}`),
          100,
        ),
        min_length: 1,
        max_length: 200,
        required: true,
        value: defaults?.codeName,
      },
    },
  ];
  if (capability === "text" && entryKind === "endpoint") {
    components.push({
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.providers.model_num_ctx_label"), 45),
      description: safeSelectOptionText(localizer(locale, "commands.providers.model_num_ctx_description"), 100),
      component: {
        type: 4,
        custom_id: buildProviderModelModalFieldId("num-ctx", nonce),
        style: TextInputStyle.Short,
        placeholder: "8192",
        value: defaults?.text?.numCtx ? String(defaults.text.numCtx) : undefined,
        max_length: 8,
        required: false,
      },
    });
  }
  if (capability === "text") {
    const storedFlags: Record<string, boolean | undefined> = {
      tools: defaults?.text?.hasTools,
      images: defaults?.text?.seesImages,
      structured: defaults?.text?.supportsStructOutput,
      "strict-roles": defaults?.text?.strictRoleAlternation,
      prefix: defaults?.text?.supportsPrefixCompletion,
    };
    const flagOption = (value: string) => ({
      value,
      label: safeSelectOptionText(localizer(locale, `commands.providers.model_flags.${value}`), 100),
      description: safeSelectOptionText(localizer(locale, `commands.providers.model_flag_descriptions.${value}`), 100),
      default: Boolean(storedFlags[value]),
    });
    components.push({
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.providers.model_flags_label"), 45),
      description: safeSelectOptionText(localizer(locale, "commands.providers.model_flags_description"), 100),
      component: {
        type: 22,
        custom_id: buildProviderModelModalFieldId("flags", nonce),
        min_values: 0,
        max_values: TEXT_CAPABILITY_FLAGS.length,
        required: false,
        options: TEXT_CAPABILITY_FLAGS.map(flagOption),
      },
    });
    const compatFlags = offeredChatCompatFlags(entryKind, entryKey);
    if (compatFlags.length > 0) {
      components.push({
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.providers.model_compat_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.providers.model_compat_description"), 100),
        component: {
          type: 22,
          custom_id: buildProviderModelModalFieldId("compat", nonce),
          min_values: 0,
          max_values: compatFlags.length,
          required: false,
          options: compatFlags.map(flagOption),
        },
      });
    }
  }
  // A curated provider has no speech capability at all, so these only ever reach an endpoint. The
  // clone/VoiceDesign/Auto split describes a `tts-clone` server, which is why the ElevenLabs preset
  // gets script markup without it.
  if (capability === "speech" && defaults?.speech) {
    const speech = defaults.speech;
    if (speech.allowVoiceMode) {
      components.push({
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.providers.model_voice_mode_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.providers.model_voice_mode_description"), 100),
        component: {
          type: 21,
          custom_id: buildProviderModelModalFieldId("voice-mode", nonce),
          required: true,
          options: SPEECH_VOICE_MODES.map((mode) => ({
            value: mode,
            label: safeSelectOptionText(localizer(locale, `commands.providers.voice_modes.${mode}`), 100),
            description: safeSelectOptionText(
              localizer(locale, `commands.providers.voice_mode_descriptions.${mode}`),
              100,
            ),
            default: mode === speech.settings.voiceMode,
          })),
        },
      });
    }
    components.push({
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.providers.model_script_markup_label"), 45),
      description: safeSelectOptionText(localizer(locale, "commands.providers.model_script_markup_description"), 100),
      component: {
        type: 21,
        custom_id: buildProviderModelModalFieldId("script-markup", nonce),
        required: true,
        options: SPEECH_SCRIPT_MARKUPS.map((markup) => ({
          value: markup,
          label: safeSelectOptionText(localizer(locale, `commands.providers.script_markups.${markup}`), 100),
          description: safeSelectOptionText(
            localizer(locale, `commands.providers.script_markup_descriptions.${markup}`),
            100,
          ),
          default: markup === speech.settings.scriptMarkup,
        })),
      },
    });
    if (speech.allowVoiceMode) {
      components.push({
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.providers.model_supports_instruct_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.providers.model_supports_instruct_description"),
          100,
        ),
        component: {
          type: 22,
          custom_id: buildProviderModelModalFieldId("supports-instruct", nonce),
          min_values: 0,
          max_values: 1,
          required: false,
          options: [
            {
              value: "supports-instruct",
              label: safeSelectOptionText(localizer(locale, "commands.providers.model_supports_instruct_option"), 100),
              description: safeSelectOptionText(
                localizer(locale, "commands.providers.model_supports_instruct_option_description"),
                100,
              ),
              default: speech.settings.supportsInstruct,
            },
          ],
        },
      });
    }
  }
  if (capability === "image" || capability === "video") {
    components.push({
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.providers.model_workflow_label"), 45),
      description: safeSelectOptionText(localizer(locale, "commands.providers.model_workflow_description"), 100),
      component: {
        type: 19,
        custom_id: buildProviderModelModalFieldId("workflow", nonce),
        min_values: 0,
        max_values: 1,
        required: false,
      },
    });
  }
  // The caller omits `image` when nothing would store the declaration: a curated provider whose image
  // path never consults these flags, such as NovelAI's own tool.
  if (capability === "image" && defaults?.image) {
    const offered = IMAGE_SUPPORT_FIELDS.filter((field) => field !== "inpaint" || defaults.image?.allowInpaint);
    components.push({
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.providers.model_image_supports_label"), 45),
      description: safeSelectOptionText(localizer(locale, "commands.providers.model_image_supports_description"), 100),
      component: {
        type: 22,
        custom_id: buildProviderModelModalFieldId("image-supports", nonce),
        min_values: 1,
        max_values: offered.length,
        required: true,
        options: offered.map((field) => ({
          value: field,
          label: localizer(locale, `commands.providers.model_image_supports.${field}`),
          default: defaults.image?.supports[field] ?? false,
        })),
      },
    });
  }
  return {
    custom_id: buildProvidersRouteId(routeNamespace, {
      action: "model-submit",
      locale,
      entryKind,
      entryKey,
      capability,
      editingModelId: editingModelId ?? null,
      nonce,
    }),
    title: safeSelectOptionText(
      localizer(
        locale,
        editingModelId ? "commands.providers.edit_model_modal_title" : "commands.providers.add_model_modal_title",
      ),
      45,
    ),
    components,
  };
}

export interface ProvidersPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export interface ProvidersPanelRenderInput {
  locale: string;
  entries: ProviderPanelEntry[];
  initialEntryId: string | null;
  readStatus: PanelReadStatus;
  page: ProvidersPanelPage;
  rangeIndex?: number;
  receipt?: PanelReceipt;
  enabledActions?: ReadonlySet<"add-provider" | "add-endpoint" | "model" | "edit" | "remove">;
  routeNamespace?: ProvidersRouteNamespace;
  footerCommand?: { root: string; subcommandGroup?: string; subcommand?: string };
}

function buildRetryRow(locale: string, routeNamespace: ProvidersRouteNamespace): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildProvidersRouteId(routeNamespace, { action: "retry", locale }),
        label: localizer(locale, "commands.providers.retry"),
      },
    ],
  };
}

function buildPayload(components: ComponentInContainerData[], receipt?: PanelReceipt): ProvidersPanelPayload {
  return {
    components: [...(receipt ? [buildPanelReceiptContainer(receipt)] : []), buildPanelContainer(components)],
    flags: MessageFlags.IsComponentsV2,
  };
}

function buildModelLine(locale: string, model: ProviderPanelModel, routeNamespace: ProvidersRouteNamespace): string {
  const markers: string[] = [];
  const personal = routeNamespace !== PROVIDERS_ROUTE_NAMESPACE;
  if (model.isWorkspaceActive) {
    markers.push(
      localizer(
        locale,
        personal ? "commands.providers.marker_personal_active" : "commands.providers.marker_workspace_active",
      ),
    );
  }
  if (model.isWorkspaceFallback) {
    markers.push(
      localizer(
        locale,
        personal ? "commands.providers.marker_personal_fallback" : "commands.providers.marker_workspace_fallback",
      ),
    );
  }
  if (model.isProviderFallback) markers.push(localizer(locale, "commands.providers.marker_provider_fallback"));
  if (model.isCustomRegistration) {
    markers.push(localizer(locale, "commands.providers.marker_custom_registration"));
  }
  const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
  const codeName = model.codeName.replaceAll("`", "ˋ").replaceAll(/\s+/g, " ").trim();
  return `> \`${codeName}\`${suffix}`;
}

/**
 * Leaves room for the model-selector guidance that is appended to this body, inside Discord's
 * 4000-character TextDisplay limit.
 */
const ENTRY_BODY_LIMIT = 3600;

function buildCapabilitySection(
  locale: string,
  section: ProviderPanelCapabilitySection,
  routeNamespace: ProvidersRouteNamespace,
): string {
  const label = localizer(locale, `commands.providers.capabilities.${section.capability}`);
  return [
    `**${label}**`,
    localizer(locale, "commands.providers.capability_models_explanation"),
    ...section.models.map((model) => buildModelLine(locale, model, routeNamespace)),
  ].join("\n");
}

function buildEntryBody(locale: string, entry: ProviderPanelEntry, routeNamespace: ProvidersRouteNamespace): string {
  if (entry.kind === "brave") {
    return [
      localizer(locale, "commands.providers.brave_description"),
      `> ${localizer(locale, "commands.providers.brave_configured")}`,
    ].join("\n");
  }

  // A sparse entry would otherwise print one empty block per unpopulated capability, so absence is
  // stated once for the whole page instead.
  const populated = entry.capabilities.filter((section) => section.models.length > 0);
  if (populated.length === 0) return localizer(locale, "commands.providers.entry_no_models");
  const body = populated.map((section) => buildCapabilitySection(locale, section, routeNamespace)).join("\n\n");
  return capEntryBody(locale, body);
}

/**
 * Discord rejects a TextDisplay over 4000 characters, and the model list under each capability is
 * unbounded, so a catalog-sized provider made the whole panel fail with BASE_TYPE_BAD_LENGTH rather
 * than render. Trimming at a line boundary and stating the omitted count keeps the panel usable
 * without hiding models silently. Selector pagination keeps the panel usable while the body
 * remains bounded to Discord's TextDisplay limit.
 */
function capEntryBody(locale: string, body: string): string {
  if (body.length <= ENTRY_BODY_LIMIT) return body;

  const lines = body.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > ENTRY_BODY_LIMIT) break;
    kept.push(line);
    used += line.length + 1;
  }

  const omitted = lines.length - kept.length;
  return `${kept.join("\n")}\n${localizer(locale, "commands.providers.entry_truncated", { count: omitted })}`;
}

function buildEntryActions(
  locale: string,
  entry: ProviderPanelEntry,
  readStatus: PanelReadStatus,
  enabledActions: ProvidersPanelRenderInput["enabledActions"],
  routeNamespace: ProvidersRouteNamespace,
): ActionRowData<ButtonComponentData> {
  const unavailable = readStatus !== "fresh";
  const buttons: ButtonComponentData[] = [];
  buttons.push(
    {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId:
        entry.kind === "endpoint"
          ? buildProvidersRouteId(routeNamespace, {
              action: "edit-endpoint-open",
              locale,
              connectionId: entry.connectionIds[0] ?? 0,
            })
          : entry.kind === "provider"
            ? buildProvidersRouteId(routeNamespace, {
                action: "edit-provider-open",
                locale,
                provider: entry.provider,
                rotationKeyCount: entry.rotationKeyCount,
              })
            : buildProvidersRouteId(routeNamespace, {
                action: "edit-provider-open",
                locale,
                provider: "brave",
                rotationKeyCount: 0,
              }),
      label:
        entry.kind === "endpoint"
          ? localizer(locale, "commands.providers.edit_endpoint")
          : localizer(locale, "commands.providers.edit_provider"),
      disabled: unavailable || !enabledActions?.has("edit"),
    },
    {
      type: ComponentType.Button,
      style: ButtonStyle.Danger,
      customId: buildProvidersRouteId(routeNamespace, {
        action: "remove-prompt",
        locale,
        ...removalRouteFields(entry),
      }),
      label: localizer(
        locale,
        entry.kind === "endpoint"
          ? "commands.providers.remove_endpoint"
          : entry.kind === "brave"
            ? "commands.providers.remove_key"
            : "commands.providers.remove_provider",
      ),
      disabled: unavailable || !enabledActions?.has("remove"),
    },
  );
  return { type: ComponentType.ActionRow, components: buttons };
}

function buildEntryModelSelector(
  locale: string,
  entry: ProviderPanelEntry,
  readStatus: PanelReadStatus,
  rangeIndex = 0,
  enabledActions: ProvidersPanelRenderInput["enabledActions"],
  routeNamespace: ProvidersRouteNamespace,
): ComponentInContainerData[] {
  const entryFields = entryRouteFields(entry);
  if (!entryFields || entry.kind === "brave") return [];
  const customModels = entry.capabilities.flatMap((section) =>
    section.models
      .filter((model) => model.isCustomRegistration)
      .map((model) => ({ capability: section.capability, model })),
  );
  const selection = resolveRangeSelection(customModels, rangeIndex, MAX_MODELS_PER_SELECTOR_PAGE);
  // A capability the entry does not expose cannot be registered: the shared-provider path answers
  // `unsupported-capability` and the endpoint path `not-found`, so offering it is a dead end.
  const offeredCapabilities = MODEL_SELECTION_CAPABILITIES.filter((capability) =>
    entry.capabilities.some((section) => section.capability === capability && section.availability !== "unavailable"),
  );
  const addOptions: SelectMenuComponentOptionData[] = offeredCapabilities.map((capability) => ({
    label: safeSelectOptionText(
      localizer(locale, "commands.providers.add_capability_model", {
        capability: localizer(locale, `commands.providers.capabilities.${capability}`),
      }),
      100,
    ),
    value: buildModelSelectionValue("add", capability),
  }));
  const options: SelectMenuComponentOptionData[] = [
    ...addOptions,
    ...selection.visibleItems.map(({ capability, model }) => ({
      label: safeSelectOptionText(model.codeName, 100),
      value: buildModelSelectionValue("edit", capability, model),
      description: safeSelectOptionText(
        `${localizer(locale, `commands.providers.capabilities.${capability}`)} · ${localizer(
          locale,
          "commands.providers.marker_custom_registration",
        )}`,
        100,
      ),
    })),
  ];
  // Discord rejects a String Select with no options, so an entry exposing nothing renders none.
  if (options.length === 0) return [];
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildProvidersRouteId(routeNamespace, {
            action: "model-select",
            locale,
            ...entryFields,
          }),
          placeholder: localizer(locale, "commands.providers.manage_models_placeholder"),
          options,
          disabled: readStatus !== "fresh" || !enabledActions?.has("model"),
        },
      ],
    },
  ];
  const modelPaginationRow = buildPaginationRow({
    locale,
    rangeIndex: selection.rangeIndex,
    rangeCount: selection.rangeCount,
    namespace: routeNamespace,
    version: PROVIDERS_ROUTE_VERSION,
    disabled: readStatus !== "fresh" || !enabledActions?.has("model"),
    buildSegments: {
      page: (rangeIndex) =>
        buildProvidersRouteSegments({
          action: "model-range",
          locale,
          ...entryFields,
          rangeIndex,
        }),
    },
  });
  if (modelPaginationRow) {
    components.push(modelPaginationRow);
  }
  return components;
}

function selectedEntryId(input: ProvidersPanelRenderInput): string | null {
  if (input.page.kind === "entry") return input.page.entryId ?? input.initialEntryId;
  if (input.page.kind === "remove") return input.page.entryId;
  return null;
}

export function buildProvidersPanelPayload(input: ProvidersPanelRenderInput): ProvidersPanelPayload {
  const { locale, entries, readStatus } = input;
  const routeNamespace = input.routeNamespace ?? PROVIDERS_ROUTE_NAMESPACE;
  const titleKey =
    routeNamespace === PROVIDERS_ROUTE_NAMESPACE ? "commands.providers.title" : "commands.providers.personal_title";
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `## ${localizer(locale, titleKey)}\n${localizer(locale, "commands.providers.selector_guidance")}`,
    },
  ];

  if (readStatus === "unavailable") {
    components.push(
      { type: ComponentType.TextDisplay, content: localizer(locale, "commands.providers.unavailable") },
      buildRetryRow(locale, routeNamespace),
    );
    return buildPayload(components, input.receipt);
  }

  const selectedId = selectedEntryId(input);
  const selectedIndex = selectedId ? entries.findIndex((entry) => entry.id === selectedId) : -1;
  const implicitRangeIndex = selectedIndex < 0 ? 0 : Math.floor(selectedIndex / PROVIDERS_ENTRIES_PER_SELECTOR_PAGE);
  const selection = resolveRangeSelection(
    entries,
    input.rangeIndex ?? implicitRangeIndex,
    PROVIDERS_ENTRIES_PER_SELECTOR_PAGE,
  );
  const options: SelectMenuComponentOptionData[] = [
    {
      label: localizer(locale, "commands.providers.select_add_provider"),
      value: PROVIDERS_ADD_PROVIDER_VALUE,
      description: localizer(locale, "commands.providers.select_add_provider_description"),
      default: input.page.kind === "add-provider",
    },
    {
      label: localizer(locale, "commands.providers.select_add_endpoint"),
      value: PROVIDERS_ADD_ENDPOINT_VALUE,
      description: localizer(locale, "commands.providers.select_add_endpoint_description"),
    },
    ...selection.visibleItems.map((entry) => ({
      label: safeSelectOptionText(entry.displayName, 100),
      value: entry.id,
      description: localizer(locale, `commands.providers.entry_kind_${entry.kind}`),
      default: entry.id === selectedId,
    })),
  ];
  const selectRow: ActionRowData<StringSelectMenuComponentData> = {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildProvidersRouteId(routeNamespace, { action: "select", locale }),
        placeholder: localizer(locale, "commands.providers.select_placeholder"),
        options,
        disabled: readStatus !== "fresh",
      },
    ],
  };
  components.push(selectRow);

  const paginationRow = buildPaginationRow({
    locale,
    rangeIndex: selection.rangeIndex,
    rangeCount: selection.rangeCount,
    namespace: routeNamespace,
    version: PROVIDERS_ROUTE_VERSION,
    disabled: readStatus !== "fresh",
    buildSegments: {
      page: (rangeIndex) => buildProvidersRouteSegments({ action: "range", locale, rangeIndex }),
    },
  });
  if (paginationRow) {
    components.push(paginationRow);
  }

  components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
  if (input.page.kind === "remove") {
    const removalPage = input.page;
    const entry = entries.find((candidate) => candidate.id === removalPage.entryId);
    if (entry) {
      const removalFields = removalRouteFields(entry);
      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.providers.remove_title")}
${localizer(locale, `commands.providers.remove_impact_${entry.kind}`, {
  name: escapeDiscordMarkdown(entry.displayName),
})}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildProvidersRouteId(routeNamespace, {
                action: "remove-confirm",
                locale,
                ...removalFields,
              }),
              label: localizer(locale, "commands.providers.remove_confirm"),
              disabled: readStatus !== "fresh",
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildProvidersRouteId(routeNamespace, {
                action: "remove-cancel",
                locale,
                ...removalFields,
              }),
              label: localizer(locale, "commands.providers.cancel"),
            },
          ],
        },
      );
    } else {
      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.providers.changed_receipt_detail"),
      });
    }
  } else if (input.page.kind === "add-provider") {
    components.push({
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.providers.select_add_provider")}\n${localizer(
        locale,
        "commands.providers.read_only_action_pending",
      )}`,
    });
  } else {
    const entry = entries.find((candidate) => candidate.id === selectedId) ?? entries[0];
    if (entry) {
      const modelSelector = buildEntryModelSelector(
        locale,
        entry,
        readStatus,
        input.page.kind === "entry" ? input.page.modelRangeIndex : 0,
        input.enabledActions,
        routeNamespace,
      );
      const body = buildEntryBody(locale, entry, routeNamespace);
      components.push(
        {
          type: ComponentType.TextDisplay,
          content:
            modelSelector.length > 0
              ? `${body}\n\n${localizer(locale, "commands.providers.model_selector_guidance")}`
              : body,
        },
        ...modelSelector,
        buildEntryActions(locale, entry, readStatus, input.enabledActions, routeNamespace),
      );
    } else {
      components.push({
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.providers.empty_heading")}\n${localizer(
          locale,
          "commands.providers.empty_description",
        )}`,
      });
    }
  }

  components.push(
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    {
      type: ComponentType.TextDisplay,
      content: `-# ${localizer(locale, "commands.providers.routing_hint", {
        command: commandRegistry.getCommandMention(
          input.footerCommand?.root ?? "model",
          input.footerCommand?.subcommandGroup ?? input.footerCommand?.subcommand ?? "text",
          input.footerCommand?.subcommandGroup ? input.footerCommand.subcommand : undefined,
        ),
      })}`,
    },
  );

  if (readStatus === "stale") {
    components.push(buildRetryRow(locale, routeNamespace), {
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.providers.stale_warning")),
    });
  }
  return buildPayload(components, input.receipt);
}
