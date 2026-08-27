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
import {
  PrivacyLevel,
  type UserRow,
  type TomoriState,
  type UserSavedProviderConfigRow,
  type FallbackModelRef,
  type PersonalProviderCapability,
} from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { UserPersonaNamingPreference } from "@/types/personaNaming";
import {
  PERSONA_NAMING_VALUE_MAX_LENGTH,
  USER_IDENTITY_FIELD_MAX_LENGTH,
  USER_NICKNAME_MAX_LENGTH,
} from "@/types/personaNaming";
import {
  buildPersonalConfigCustomId,
  DEFAULT_PAGE_FOR_CATEGORY,
  encodeProviderParam,
  type PersonalConfigCategory,
  type PersonalConfigManagedCapability,
  type PersonalConfigPage,
} from "@/utils/discord/personalConfigPanelCatalog";
import { buildCategoryButtonRow, buildPanelContainer, buildPanelReceiptContainer } from "@/utils/discord/ui/panel";
import { safeModalLocalizer, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { escapeDiscordMarkdown } from "@/utils/discord/interactions/panelController";
import { formatImageTagsForModalValue, TAGS_MODAL_MAX_LENGTH } from "@/utils/image/tagHelpers";
import { formatUTCOffset } from "@/utils/text/timezoneHelper";
import { localizer } from "@/utils/text/localizer";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import {
  getActivePersonalProviderForCapability,
  getStoredPersonalProviderForCapability,
} from "@/utils/provider/personalProviderHelpers";
import { getFallbackModelRefKey } from "@/utils/provider/fallbackModelIdentity";
import { THINKING_LEVEL_LOCALIZER_KEYS, THINKING_LEVEL_VALUES } from "@/constants/thinkingLevels";

export interface PersonalConfigPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export type PersonalConfigPanelView =
  | { kind: "main" }
  | {
      kind: "model-range";
      capability: PersonalConfigManagedCapability;
      provider: string;
      rangePage: number;
      totalOptions: number;
    }
  | {
      kind: "fallbacks-range";
      provider: string;
      rangePage: number;
      totalOptions: number;
    }
  | {
      kind: "model-activate-confirm";
      capability: PersonalConfigManagedCapability;
      provider: string;
      modelId: number;
      modelName: string;
      nonce: string;
    }
  | {
      kind: "quick-toggle-confirm";
      mask: string;
      newlyEnabledCaps: PersonalProviderCapability[];
      nonce: string;
    };

export interface PersonalConfigRoutingRow {
  capability: PersonalConfigManagedCapability;
  activeModelName: string | null;
  storedProvider: string | null;
  storedModelName: string | null;
}

export interface PersonalConfigFallbackDisplaySlot {
  slot: number;
  modelName: string | null;
}

export interface PersonalConfigModelDisplayInfo {
  routingRows: Record<PersonalConfigManagedCapability, PersonalConfigRoutingRow>;
  availableCapabilities: PersonalConfigManagedCapability[];
  eligibleProvidersForCapability: Record<PersonalConfigManagedCapability, string[]>;
  parametersProviders: string[];
  selectedParametersConfig?: UserSavedProviderConfigRow | null;
  fallbacksProviders: string[];
  selectedFallbacksConfig?: UserSavedProviderConfigRow | null;
  primaryModelName?: string | null;
  fallbackSlots: PersonalConfigFallbackDisplaySlot[];
  randomizerEnabled: boolean;
  canEnableRandomizer: boolean;
}

export interface PersonalConfigPanelRenderInput {
  locale: string;
  category: PersonalConfigCategory;
  page: PersonalConfigPage;
  user: UserRow;
  resolvedNickname: string;
  personas: TomoriState[];
  selectedLineageId?: number;
  personaNamingPreference?: UserPersonaNamingPreference | null;
  memoryCount: number;
  stmCount: number;
  readStatus: PanelReadStatus;
  receipt?: PanelReceipt;
  savedProviders?: UserSavedProviderConfigRow[];
  selectedCapability?: PersonalConfigManagedCapability;
  selectedParametersProvider?: string;
  selectedFallbacksProvider?: string;
  modelDisplayInfo?: PersonalConfigModelDisplayInfo;
  view?: PersonalConfigPanelView;
}

export function buildPersonalConfigModalFieldId(field: string, nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildLanguageModal(
  locale: string,
  nonce: string,
  currentLanguage: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalConfigCustomId("language-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.language_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.language_select_label"), 45),
        component: {
          type: 21,
          custom_id: buildPersonalConfigModalFieldId("language", nonce),
          required: true,
          options: [
            {
              value: "en-US",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.language_en"), 100),
              default: currentLanguage === "en-US",
            },
            {
              value: "ja",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.language_ja"), 100),
              default: currentLanguage === "ja",
            },
          ],
        },
      },
    ],
  };
}

export function buildTimezoneModal(
  locale: string,
  nonce: string,
  currentOffset: number | null,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalConfigCustomId("timezone-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.timezone_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.timezone_input_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.config.timezone_input_description"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("timezone", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.timezone_input_placeholder"),
            100,
          ),
          max_length: 10,
          required: true,
          value: currentOffset !== null ? String(currentOffset) : "",
        },
      },
    ],
  };
}

export function buildNamingModal(
  locale: string,
  nonce: string,
  current: { nickname: string | null; prefix: string | null; suffix: string | null },
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalConfigCustomId("naming-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.naming_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_nickname_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.config.modal_nickname_description"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("nickname", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_nickname_placeholder"),
            100,
          ),
          max_length: USER_NICKNAME_MAX_LENGTH,
          required: false,
          value: current.nickname ?? "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_prefix_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_prefix_description"), 100),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("prefix", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_prefix_placeholder"),
            100,
          ),
          max_length: PERSONA_NAMING_VALUE_MAX_LENGTH,
          required: false,
          value: current.prefix ?? "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_suffix_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_suffix_description"), 100),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("suffix", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_suffix_placeholder"),
            100,
          ),
          max_length: PERSONA_NAMING_VALUE_MAX_LENGTH,
          required: false,
          value: current.suffix ?? "",
        },
      },
    ],
  };
}

export function buildPersonaNamingModal(
  locale: string,
  lineageId: number,
  nonce: string,
  current: { nickname: string | null; prefix: string | null; suffix: string | null },
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalConfigCustomId("persona-naming-submit", locale, lineageId, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.persona_naming_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_nickname_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.config.modal_nickname_description"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("nickname", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_nickname_placeholder"),
            100,
          ),
          max_length: USER_NICKNAME_MAX_LENGTH,
          required: false,
          value: current.nickname ?? "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_prefix_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_prefix_description"), 100),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("prefix", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_prefix_placeholder"),
            100,
          ),
          max_length: PERSONA_NAMING_VALUE_MAX_LENGTH,
          required: false,
          value: current.prefix ?? "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_suffix_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_suffix_description"), 100),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("suffix", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_suffix_placeholder"),
            100,
          ),
          max_length: PERSONA_NAMING_VALUE_MAX_LENGTH,
          required: false,
          value: current.suffix ?? "",
        },
      },
    ],
  };
}

export function buildAboutModal(
  locale: string,
  nonce: string,
  current: { genderIdentity: string | null; pronouns: string | null; addressingStyle: string | null },
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalConfigCustomId("about-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.about_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_gender_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_gender_description"), 100),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("gender_identity", nonce),
          style: TextInputStyle.Short,
          max_length: USER_IDENTITY_FIELD_MAX_LENGTH,
          required: false,
          value: current.genderIdentity ?? "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_pronouns_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.config.modal_pronouns_description"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("pronouns", nonce),
          style: TextInputStyle.Short,
          max_length: USER_IDENTITY_FIELD_MAX_LENGTH,
          required: false,
          value: current.pronouns ?? "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_style_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_style_description"), 100),
        component: {
          type: 21,
          custom_id: buildPersonalConfigModalFieldId("addressing_style", nonce),
          required: true,
          options: [
            {
              value: "neutral",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.style_neutral"), 100),
              default: !current.addressingStyle || current.addressingStyle === "neutral",
            },
            {
              value: "masculine",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.style_masculine"), 100),
              default: current.addressingStyle === "masculine",
            },
            {
              value: "feminine",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.style_feminine"), 100),
              default: current.addressingStyle === "feminine",
            },
          ],
        },
      },
    ],
  };
}

export function buildAppearanceModal(
  locale: string,
  nonce: string,
  currentTags: string[],
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalConfigCustomId("appearance-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.appearance_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_tags_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_tags_description"), 100),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("tags", nonce),
          style: TextInputStyle.Paragraph,
          placeholder: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_tags_placeholder"), 100),
          max_length: TAGS_MODAL_MAX_LENGTH,
          required: false,
          value: formatImageTagsForModalValue(currentTags),
        },
      },
    ],
  };
}

export function buildPrivacyLevelModal(
  locale: string,
  nonce: string,
  currentLevel: PrivacyLevel,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalConfigCustomId("privacy-level-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.privacy_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_privacy_select_label"), 45),
        description: safeModalLocalizer(locale, "commands.personal.config.modal_privacy_select_description"),
        component: {
          type: 21,
          custom_id: buildPersonalConfigModalFieldId("privacy_level", nonce),
          required: true,
          options: [
            {
              value: "0",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.privacy_level_minimal"), 100),
              description: safeSelectOptionText(
                localizer(locale, "commands.personal.config.privacy_level_desc_minimal"),
                100,
              ),
              default: currentLevel === PrivacyLevel.MINIMAL,
            },
            {
              value: "1",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.privacy_level_partial"), 100),
              description: safeSelectOptionText(
                localizer(locale, "commands.personal.config.privacy_level_desc_partial"),
                100,
              ),
              default: currentLevel === PrivacyLevel.PARTIAL,
            },
            {
              value: "2",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.privacy_level_full"), 100),
              description: safeSelectOptionText(
                localizer(locale, "commands.personal.config.privacy_level_desc_full"),
                100,
              ),
              default: currentLevel === PrivacyLevel.FULL,
            },
          ],
        },
      },
    ],
  };
}

export function buildQuickToggleModal(
  locale: string,
  nonce: string,
  savedProviders: UserSavedProviderConfigRow[],
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const textActive = Boolean(getActivePersonalProviderForCapability(savedProviders, "text"));
  const embedActive = Boolean(getActivePersonalProviderForCapability(savedProviders, "embedding"));
  const imageActive = Boolean(getActivePersonalProviderForCapability(savedProviders, "image"));
  const videoActive = Boolean(getActivePersonalProviderForCapability(savedProviders, "video"));
  const visionActive = Boolean(getActivePersonalProviderForCapability(savedProviders, "vision"));

  const textStored = getStoredPersonalProviderForCapability(savedProviders, "text");
  const embedStored = getStoredPersonalProviderForCapability(savedProviders, "embedding");
  const imageStored = getStoredPersonalProviderForCapability(savedProviders, "image");
  const videoStored = getStoredPersonalProviderForCapability(savedProviders, "video");
  const visionStored = getStoredPersonalProviderForCapability(savedProviders, "vision");

  const getDesc = (stored: UserSavedProviderConfigRow | null): string =>
    stored
      ? localizer(locale, "commands.personal.config.quick_toggle_provider_desc", {
          provider: getProviderDisplayName(stored.provider),
        })
      : localizer(locale, "commands.personal.config.quick_toggle_none_desc");

  return {
    custom_id: buildPersonalConfigCustomId("quick-toggle-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.quick_toggle_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.quick_toggle_group_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.config.quick_toggle_group_description"),
          100,
        ),
        component: {
          type: 22,
          custom_id: buildPersonalConfigModalFieldId("capabilities", nonce),
          min_values: 0,
          max_values: 5,
          required: false,
          options: [
            {
              value: "text",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_text"), 100),
              description: safeSelectOptionText(getDesc(textStored), 100),
              default: textActive,
            },
            {
              value: "embedding",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_embedding"), 100),
              description: safeSelectOptionText(getDesc(embedStored), 100),
              default: embedActive,
            },
            {
              value: "image",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_image"), 100),
              description: safeSelectOptionText(getDesc(imageStored), 100),
              default: imageActive,
            },
            {
              value: "video",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_video"), 100),
              description: safeSelectOptionText(getDesc(videoStored), 100),
              default: videoActive,
            },
            {
              value: "vision",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_vision"), 100),
              description: safeSelectOptionText(getDesc(visionStored), 100),
              default: visionActive,
            },
          ],
        },
      },
    ],
  };
}

export function buildModelSelectModal(
  locale: string,
  nonce: string,
  capability: PersonalConfigManagedCapability,
  provider: string,
  availableModels: Array<{ id: number; name: string; description?: string }>,
  currentModelId: number | null,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const capName = localizer(
    locale,
    `commands.personal.config.routing_${capability === "image_nai" ? "image_nai" : capability === "image" ? "image_standard" : capability}`,
  );
  const options = availableModels.slice(0, 25).map((m) => ({
    value: String(m.id),
    label: safeSelectOptionText(m.name, 100),
    description: m.description ? safeSelectOptionText(m.description, 100) : undefined,
    default: m.id === currentModelId,
  }));

  return {
    custom_id: buildPersonalConfigCustomId(
      "model-modal-submit",
      locale,
      capability,
      encodeProviderParam(provider),
      nonce,
    ),
    title: safeSelectOptionText(
      localizer(locale, "commands.personal.config.model_modal_title", { capability: capName }),
      45,
    ),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.model_modal_select_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.config.model_modal_select_description", {
            provider: getProviderDisplayName(provider),
          }),
          100,
        ),
        component: {
          type: 21,
          custom_id: buildPersonalConfigModalFieldId("model", nonce),
          required: true,
          options,
        },
      },
    ],
  };
}

export function buildParameters1Modal(
  locale: string,
  nonce: string,
  provider: string,
  currentConfig: UserSavedProviderConfigRow | null,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalConfigCustomId("parameters-1-submit", locale, encodeProviderParam(provider), nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.params_1_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_param_temperature_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.config.modal_param_temperature_desc"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("temperature", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_param_temperature_placeholder"),
            100,
          ),
          max_length: 10,
          required: false,
          value:
            currentConfig?.llm_temperature !== null && currentConfig?.llm_temperature !== undefined
              ? String(currentConfig.llm_temperature)
              : "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_param_min_p_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_param_min_p_desc"), 100),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("min_p", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_param_min_p_placeholder"),
            100,
          ),
          max_length: 10,
          required: false,
          value:
            currentConfig?.llm_min_p !== null && currentConfig?.llm_min_p !== undefined
              ? String(currentConfig.llm_min_p)
              : "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_param_top_p_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_param_top_p_desc"), 100),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("top_p", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_param_top_p_placeholder"),
            100,
          ),
          max_length: 10,
          required: false,
          value:
            currentConfig?.llm_top_p !== null && currentConfig?.llm_top_p !== undefined
              ? String(currentConfig.llm_top_p)
              : "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_param_top_k_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_param_top_k_desc"), 100),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("top_k", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_param_top_k_placeholder"),
            100,
          ),
          max_length: 10,
          required: false,
          value:
            currentConfig?.llm_top_k !== null && currentConfig?.llm_top_k !== undefined
              ? String(currentConfig.llm_top_k)
              : "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(
          localizer(locale, "commands.personal.config.modal_param_frequency_penalty_label"),
          45,
        ),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.config.modal_param_frequency_penalty_desc"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("frequency_penalty", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_param_frequency_penalty_placeholder"),
            100,
          ),
          max_length: 10,
          required: false,
          value:
            currentConfig?.llm_frequency_penalty !== null && currentConfig?.llm_frequency_penalty !== undefined
              ? String(currentConfig.llm_frequency_penalty)
              : "",
        },
      },
    ],
  };
}

export function buildParameters2Modal(
  locale: string,
  nonce: string,
  provider: string,
  currentConfig: UserSavedProviderConfigRow | null,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const currentThinking = currentConfig?.thinking_level ?? "auto";

  return {
    custom_id: buildPersonalConfigCustomId("parameters-2-submit", locale, encodeProviderParam(provider), nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.params_2_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(
          localizer(locale, "commands.personal.config.modal_param_presence_penalty_label"),
          45,
        ),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.config.modal_param_presence_penalty_desc"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("presence_penalty", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_param_presence_penalty_placeholder"),
            100,
          ),
          max_length: 10,
          required: false,
          value:
            currentConfig?.llm_presence_penalty !== null && currentConfig?.llm_presence_penalty !== undefined
              ? String(currentConfig.llm_presence_penalty)
              : "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_param_max_tokens_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.config.modal_param_max_tokens_desc"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("max_output_tokens", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.modal_param_max_tokens_placeholder"),
            100,
          ),
          max_length: 10,
          required: false,
          value:
            currentConfig?.llm_max_output_tokens !== null && currentConfig?.llm_max_output_tokens !== undefined
              ? String(currentConfig.llm_max_output_tokens)
              : "",
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.modal_param_thinking_level_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.config.modal_param_thinking_level_desc"),
          100,
        ),
        component: {
          type: 21,
          custom_id: buildPersonalConfigModalFieldId("thinking_level", nonce),
          required: true,
          options: THINKING_LEVEL_VALUES.map((val) => ({
            value: val,
            label: localizer(locale, THINKING_LEVEL_LOCALIZER_KEYS[val]),
            default: currentThinking === val,
          })),
        },
      },
    ],
  };
}

export function buildFallbacksModal(
  locale: string,
  nonce: string,
  provider: string,
  availableOptions: Array<{ refKey: string; label: string }>,
  currentRefs: FallbackModelRef[],
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const components: RawDiscordComponent[] = [];

  for (let slot = 1; slot <= 5; slot++) {
    const currentRefForSlot = currentRefs[slot - 1] ?? null;
    const currentRefKey = currentRefForSlot ? getFallbackModelRefKey(currentRefForSlot) : null;

    const options = [
      {
        value: "__none__",
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.fallback_none_option"), 100),
        description: safeSelectOptionText(localizer(locale, "commands.personal.config.fallback_none_desc"), 100),
        default: currentRefKey === null,
      },
      ...availableOptions.slice(0, 24).map((opt) => ({
        value: opt.refKey,
        label: safeSelectOptionText(opt.label, 100),
        default: currentRefKey === opt.refKey,
      })),
    ];

    components.push({
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.personal.config.fallback_slot_label", { slot }), 45),
      description: safeSelectOptionText(
        localizer(locale, "commands.personal.config.fallback_slot_desc", { slot }),
        100,
      ),
      component: {
        type: 21,
        custom_id: buildPersonalConfigModalFieldId(`slot_${slot}`, nonce),
        required: false,
        options,
      },
    });
  }

  return {
    custom_id: buildPersonalConfigCustomId("fallbacks-submit", locale, encodeProviderParam(provider), nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.fallbacks_modal_title"), 45),
    components,
  };
}

function buildRetryRow(
  locale: string,
  category: PersonalConfigCategory,
  page: PersonalConfigPage,
  lineageId?: number,
  capability?: PersonalConfigManagedCapability,
  provider?: string,
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildPersonalConfigCustomId(
          "retry",
          locale,
          category,
          page,
          ...(lineageId ? [lineageId] : capability ? [capability] : provider ? [encodeProviderParam(provider)] : []),
        ),
        label: localizer(locale, "commands.personal.config.retry"),
      },
    ],
  };
}

function buildPayload(components: ComponentInContainerData[], receipt?: PanelReceipt): PersonalConfigPanelPayload {
  return {
    components: [...(receipt ? [buildPanelReceiptContainer(receipt)] : []), buildPanelContainer(components)],
    flags: MessageFlags.IsComponentsV2,
  };
}

function getPageOptionsForCategory(
  locale: string,
  category: PersonalConfigCategory,
  currentPage: PersonalConfigPage,
): SelectMenuComponentOptionData[] {
  switch (category) {
    case "profile":
      return [
        {
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.page_general"), 100),
          value: "general",
          default: currentPage === "general",
        },
        {
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.page_persona"), 100),
          value: "persona",
          default: currentPage === "persona",
        },
        {
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.page_appearance"), 100),
          value: "appearance",
          default: currentPage === "appearance",
        },
      ];
    case "privacy":
      return [
        {
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.page_privacy_controls"), 100),
          value: "controls",
          default: currentPage === "controls",
        },
      ];
    case "models":
      return [
        {
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.page_switch_models"), 100),
          value: "switch",
          default: currentPage === "switch",
        },
        {
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.page_parameters"), 100),
          value: "parameters",
          default: currentPage === "parameters",
        },
        {
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.page_fallbacks"), 100),
          value: "fallbacks",
          default: currentPage === "fallbacks",
        },
      ];
    case "advanced":
      return [
        {
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.page_response_modes"), 100),
          value: "response-modes",
          default: currentPage === "response-modes",
        },
        {
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.page_impersonation"), 100),
          value: "impersonation",
          default: currentPage === "impersonation",
        },
        {
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.page_spotlight"), 100),
          value: "spotlight",
          default: currentPage === "spotlight",
        },
      ];
  }
}

function renderPanelView(
  input: PersonalConfigPanelRenderInput,
  view: Exclude<PersonalConfigPanelView, { kind: "main" }>,
): ComponentInContainerData[] {
  const locale = input.locale;
  switch (view.kind) {
    case "model-activate-confirm": {
      const capName = localizer(
        locale,
        `commands.personal.config.routing_${view.capability === "image_nai" ? "image_nai" : view.capability === "image" ? "image_standard" : view.capability}`,
      );
      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.provider.activation_confirm_title")}`,
        },
        {
          type: ComponentType.TextDisplay,
          content: localizer(locale, "commands.personal.provider.activation_confirm_description", {
            capability: capName,
            provider: getProviderDisplayName(view.provider),
            model: view.modelName,
          }),
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Success,
              customId: buildPersonalConfigCustomId(
                "model-act-confirm",
                locale,
                view.capability,
                encodeProviderParam(view.provider),
                view.modelId,
                view.nonce,
              ),
              label: localizer(locale, "commands.personal.provider.activation_confirm_continue"),
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildPersonalConfigCustomId("model-act-cancel", locale),
              label: localizer(locale, "commands.personal.provider.activation_confirm_cancel"),
            },
          ],
        },
      ];
    }
    case "quick-toggle-confirm": {
      const newlyEnabledText = view.newlyEnabledCaps
        .map((cap) => `• **${localizer(locale, `commands.personal.provider.capability_${cap}`)}**`)
        .join("\n");
      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.provider.toggle-models.confirm_title")}`,
        },
        {
          type: ComponentType.TextDisplay,
          content: localizer(locale, "commands.personal.provider.toggle-models.confirm_description", {
            newly_enabled: newlyEnabledText,
          }),
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Success,
              customId: buildPersonalConfigCustomId("quick-toggle-confirm", locale, view.mask, view.nonce),
              label: localizer(locale, "commands.personal.provider.activation_confirm_continue"),
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildPersonalConfigCustomId("quick-toggle-cancel", locale),
              label: localizer(locale, "commands.personal.provider.activation_confirm_cancel"),
            },
          ],
        },
      ];
    }
    case "model-range": {
      const capName = localizer(
        locale,
        `commands.personal.config.routing_${view.capability === "image_nai" ? "image_nai" : view.capability === "image" ? "image_standard" : view.capability}`,
      );
      const totalRanges = Math.ceil(view.totalOptions / 25);
      const startRange = view.rangePage * 5;
      const endRange = Math.min(startRange + 5, totalRanges);

      const buttons: ButtonComponentData[] = [];
      for (let r = startRange; r < endRange; r++) {
        const start = r * 25 + 1;
        const end = Math.min((r + 1) * 25, view.totalOptions);
        buttons.push({
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildPersonalConfigCustomId(
            "model-range-open",
            locale,
            view.capability,
            encodeProviderParam(view.provider),
            r * 25,
          ),
          label: `${start} - ${end}`,
        });
      }

      const rows: ActionRowData<ButtonComponentData>[] = [];
      if (buttons.length > 0) {
        rows.push({
          type: ComponentType.ActionRow,
          components: buttons,
        });
      }

      const navButtons: ButtonComponentData[] = [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildPersonalConfigCustomId("model-act-cancel", locale),
          label: localizer(locale, "general.pagination.cancel"),
        },
      ];

      rows.push({
        type: ComponentType.ActionRow,
        components: navButtons,
      });

      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.model_range_title", { capability: capName })}
${localizer(locale, "commands.personal.config.model_range_desc", { provider: getProviderDisplayName(view.provider) })}`,
        },
        ...rows,
      ];
    }
    case "fallbacks-range": {
      const totalRanges = Math.ceil(view.totalOptions / 24);
      const startRange = view.rangePage * 5;
      const endRange = Math.min(startRange + 5, totalRanges);

      const buttons: ButtonComponentData[] = [];
      for (let r = startRange; r < endRange; r++) {
        const start = r * 24 + 1;
        const end = Math.min((r + 1) * 24, view.totalOptions);
        buttons.push({
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildPersonalConfigCustomId(
            "fallbacks-range-open",
            locale,
            encodeProviderParam(view.provider),
            r * 24,
          ),
          label: `${start} - ${end}`,
        });
      }

      const rows: ActionRowData<ButtonComponentData>[] = [];
      if (buttons.length > 0) {
        rows.push({
          type: ComponentType.ActionRow,
          components: buttons,
        });
      }

      const navButtons: ButtonComponentData[] = [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildPersonalConfigCustomId("model-act-cancel", locale),
          label: localizer(locale, "general.pagination.cancel"),
        },
      ];

      rows.push({
        type: ComponentType.ActionRow,
        components: navButtons,
      });

      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.fallbacks_range_title")}
${localizer(locale, "commands.personal.config.fallbacks_range_desc", { provider: getProviderDisplayName(view.provider) })}`,
        },
        ...rows,
      ];
    }
  }
}

export function buildPersonalConfigPanelPayload(input: PersonalConfigPanelRenderInput): PersonalConfigPanelPayload {
  const {
    locale,
    category,
    page,
    user,
    resolvedNickname,
    personas,
    selectedLineageId,
    personaNamingPreference,
    memoryCount,
    stmCount,
    readStatus,
    receipt,
  } = input;
  const writesDisabled = readStatus !== "fresh";

  const categoryButtons = buildCategoryButtonRow<PersonalConfigCategory>(
    [
      {
        id: "profile",
        label: localizer(locale, "commands.personal.config.category_profile"),
        customId: buildPersonalConfigCustomId("category", locale, "profile", DEFAULT_PAGE_FOR_CATEGORY.profile),
      },
      {
        id: "privacy",
        label: localizer(locale, "commands.personal.config.category_privacy"),
        customId: buildPersonalConfigCustomId("category", locale, "privacy", DEFAULT_PAGE_FOR_CATEGORY.privacy),
      },
      {
        id: "models",
        label: localizer(locale, "commands.personal.config.category_models"),
        customId: buildPersonalConfigCustomId("category", locale, "models", DEFAULT_PAGE_FOR_CATEGORY.models),
      },
      {
        id: "advanced",
        label: localizer(locale, "commands.personal.config.category_advanced"),
        customId: buildPersonalConfigCustomId("category", locale, "advanced", DEFAULT_PAGE_FOR_CATEGORY.advanced),
      },
    ],
    category,
    readStatus === "unavailable",
  );

  const pageOptions = getPageOptionsForCategory(locale, category, page);
  const pageSelectorRow: ActionRowData<StringSelectMenuComponentData> = {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildPersonalConfigCustomId("page", locale, category, page),
        placeholder: localizer(locale, "commands.personal.config.page_select_placeholder"),
        options: pageOptions,
        disabled: writesDisabled,
      },
    ],
  };

  const components: ComponentInContainerData[] = [
    categoryButtons,
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    pageSelectorRow,
  ];

  if (readStatus === "unavailable") {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.personal.config.unavailable")}`,
      },
      buildRetryRow(locale, category, page, selectedLineageId),
    );
    return buildPayload(components, receipt);
  }

  // Render subview or body based on active category and page
  if (input.view && input.view.kind !== "main") {
    components.push(...renderPanelView(input, input.view));
  } else if (category === "profile") {
    if (page === "general") {
      const languageLabel =
        user.language_pref === "ja"
          ? localizer(locale, "commands.personal.config.language_ja")
          : localizer(locale, "commands.personal.config.language_en");
      const timezoneLabel =
        user.timezone_offset !== null && user.timezone_offset !== undefined
          ? formatUTCOffset(user.timezone_offset)
          : localizer(locale, "commands.personal.config.timezone_server_default");

      const prefixLabel = user.prefix_override
        ? `\`${escapeDiscordMarkdown(user.prefix_override)}\``
        : localizer(locale, "commands.personal.config.inherited_label");
      const suffixLabel = user.suffix_override
        ? `\`${escapeDiscordMarkdown(user.suffix_override)}\``
        : localizer(locale, "commands.personal.config.inherited_label");

      const genderLabel = user.gender_identity
        ? escapeDiscordMarkdown(user.gender_identity)
        : localizer(locale, "commands.personal.config.not_set_label");
      const pronounsLabel = user.pronouns
        ? escapeDiscordMarkdown(user.pronouns)
        : localizer(locale, "commands.personal.config.not_set_label");
      const styleLabel =
        user.addressing_style === "masculine"
          ? localizer(locale, "commands.personal.config.style_masculine")
          : user.addressing_style === "feminine"
            ? localizer(locale, "commands.personal.config.style_feminine")
            : localizer(locale, "commands.personal.config.style_neutral");

      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.preferences_title")}
${localizer(locale, "commands.personal.config.preferences_description")}

**${localizer(locale, "commands.personal.config.interface_section")}**
> ${localizer(locale, "commands.personal.config.language_label")}: ${languageLabel}
> ${localizer(locale, "commands.personal.config.timezone_label")}: ${timezoneLabel}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("language-open", locale),
              label: localizer(locale, "commands.personal.config.change_language_button"),
              disabled: writesDisabled,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("timezone-open", locale),
              label: localizer(locale, "commands.personal.config.set_timezone_button"),
              disabled: writesDisabled,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("timezone-server", locale),
              label: localizer(locale, "commands.personal.config.use_server_timezone_button"),
              disabled: writesDisabled || user.timezone_offset === null,
            },
          ],
        },
        {
          type: ComponentType.TextDisplay,
          content: `**${localizer(locale, "commands.personal.config.naming_section")}**
> ${localizer(locale, "commands.personal.config.nickname_label")}: \`${escapeDiscordMarkdown(resolvedNickname)}\`
> ${localizer(locale, "commands.personal.config.prefix_label")}: ${prefixLabel}
> ${localizer(locale, "commands.personal.config.suffix_label")}: ${suffixLabel}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("naming-open", locale),
              label: localizer(locale, "commands.personal.config.edit_naming_button"),
              disabled: writesDisabled,
            },
          ],
        },
        {
          type: ComponentType.TextDisplay,
          content: `**${localizer(locale, "commands.personal.config.about_section")}**
> ${localizer(locale, "commands.personal.config.gender_label")}: ${genderLabel}
> ${localizer(locale, "commands.personal.config.pronouns_label")}: ${pronounsLabel}
> ${localizer(locale, "commands.personal.config.style_label")}: ${styleLabel}
-# ${localizer(locale, "commands.personal.config.teach_persona_hint").split("\n").join("\n-# ")}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("about-open", locale),
              label: localizer(locale, "commands.personal.config.edit_about_button"),
              disabled: writesDisabled,
            },
          ],
        },
      );
    } else if (page === "persona") {
      components.push({
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.personal.config.persona_naming_title")}
${localizer(locale, "commands.personal.config.persona_naming_description")}`,
      });

      if (personas.length === 0) {
        components.push({
          type: ComponentType.TextDisplay,
          content: localizer(locale, "commands.personal.config.no_personas"),
        });
      } else {
        const currentLineage = selectedLineageId ?? personas[0]?.persona_lineage_id ?? 0;
        const personaOptions: SelectMenuComponentOptionData[] = personas.map((p) => ({
          label: safeSelectOptionText(
            p.persona_nickname || localizer(locale, "commands.personal.config.persona_default_name"),
            100,
          ),
          value: String(p.persona_lineage_id),
          description: safeSelectOptionText(
            localizer(
              locale,
              p.is_alter
                ? "commands.personal.config.persona_alter_description"
                : "commands.personal.config.persona_main_description",
            ),
            100,
          ),
          default: p.persona_lineage_id === currentLineage,
        }));

        components.push({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: buildPersonalConfigCustomId("persona-select", locale, currentLineage),
              placeholder: localizer(locale, "commands.personal.config.persona_select_placeholder"),
              options: personaOptions,
              disabled: writesDisabled,
            },
          ],
        });

        const nicknameOverrideLabel = personaNamingPreference?.nickname_override
          ? `\`${escapeDiscordMarkdown(personaNamingPreference.nickname_override)}\``
          : localizer(locale, "commands.personal.config.inherited_label");
        const prefixOverrideLabel = personaNamingPreference?.prefix_override
          ? `\`${escapeDiscordMarkdown(personaNamingPreference.prefix_override)}\``
          : localizer(locale, "commands.personal.config.inherited_label");
        const suffixOverrideLabel = personaNamingPreference?.suffix_override
          ? `\`${escapeDiscordMarkdown(personaNamingPreference.suffix_override)}\``
          : localizer(locale, "commands.personal.config.inherited_label");

        components.push(
          {
            type: ComponentType.TextDisplay,
            content: `> ${localizer(locale, "commands.personal.config.nickname_label")} override: ${nicknameOverrideLabel}
> ${localizer(locale, "commands.personal.config.prefix_label")} override: ${prefixOverrideLabel}
> ${localizer(locale, "commands.personal.config.suffix_label")} override: ${suffixOverrideLabel}
-# ${localizer(locale, "commands.personal.config.teach_persona_hint").split("\n").join("\n-# ")}`,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildPersonalConfigCustomId("persona-naming-open", locale, currentLineage),
                label: localizer(locale, "commands.personal.config.edit_persona_naming_button"),
                disabled: writesDisabled,
              },
            ],
          },
        );
      }
    } else if (page === "appearance") {
      const tagsText =
        user.physical_appearance_tags && user.physical_appearance_tags.length > 0
          ? `\`${escapeDiscordMarkdown(user.physical_appearance_tags.join(", "))}\``
          : localizer(locale, "commands.personal.config.not_set_label");

      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.appearance_title")}
${localizer(locale, "commands.personal.config.appearance_description")}

> ${localizer(locale, "commands.personal.config.tags_label")}: ${tagsText}
-# ${localizer(locale, "commands.personal.config.teach_persona_hint").split("\n").join("\n-# ")}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("appearance-open", locale),
              label: localizer(locale, "commands.personal.config.edit_appearance_button"),
              disabled: writesDisabled,
            },
          ],
        },
      );
    }
  } else if (category === "privacy") {
    const privacyLevel = user.privacy_level ?? PrivacyLevel.MINIMAL;
    const levelLabel =
      privacyLevel === PrivacyLevel.FULL
        ? localizer(locale, "commands.personal.config.privacy_level_full")
        : privacyLevel === PrivacyLevel.PARTIAL
          ? localizer(locale, "commands.personal.config.privacy_level_partial")
          : localizer(locale, "commands.personal.config.privacy_level_minimal");

    const yesLabel = localizer(locale, "commands.personal.config.yes");
    const noLabel = localizer(locale, "commands.personal.config.no");

    const msgVisible = privacyLevel === PrivacyLevel.FULL ? noLabel : yesLabel;
    const memoriesVisible = privacyLevel === PrivacyLevel.MINIMAL ? yesLabel : noLabel;
    const statusVisible = privacyLevel === PrivacyLevel.MINIMAL ? yesLabel : noLabel;
    const canTrigger = privacyLevel === PrivacyLevel.FULL ? noLabel : yesLabel;

    const isCrossServerOn = Boolean(user.shortterm_cache_crossserver_opt_in);

    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.personal.config.privacy_title")}
${localizer(locale, "commands.personal.config.privacy_description")}

> ${localizer(locale, "commands.personal.config.privacy_level_label")}: ${levelLabel}
> ${localizer(locale, "commands.personal.config.privacy_msg_visible")}: ${msgVisible}
> ${localizer(locale, "commands.personal.config.privacy_memories_visible")}: ${memoriesVisible}
> ${localizer(locale, "commands.personal.config.privacy_status_visible")}: ${statusVisible}
> ${localizer(locale, "commands.personal.config.privacy_can_trigger")}: ${canTrigger}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildPersonalConfigCustomId("privacy-level-open", locale),
            label: localizer(locale, "commands.personal.config.change_privacy_level_button"),
            disabled: writesDisabled,
          },
        ],
      },
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.personal.config.your_data_section")}**
${localizer(locale, "commands.personal.config.memories_count_label", { count: memoryCount })}
-# ${localizer(locale, "commands.personal.config.memories_manage_hint")}

${localizer(locale, "commands.personal.config.stm_count_label", { count: stmCount })}
-# ${localizer(locale, "commands.personal.config.stm_clear_hint")}

${
  isCrossServerOn
    ? localizer(locale, "commands.personal.config.crossserver_stm_on")
    : localizer(locale, "commands.personal.config.crossserver_stm_off")
}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: isCrossServerOn ? ButtonStyle.Secondary : ButtonStyle.Primary,
            customId: buildPersonalConfigCustomId("crossserver-toggle", locale),
            label: isCrossServerOn
              ? localizer(locale, "commands.personal.config.disable_crossserver_button")
              : localizer(locale, "commands.personal.config.enable_crossserver_button"),
            disabled: writesDisabled,
          },
        ],
      },
    );
  } else if (category === "models") {
    if (page === "switch") {
      const info = input.modelDisplayInfo;
      const selectedCap: PersonalConfigManagedCapability = input.selectedCapability ?? "text";
      const routing = info?.routingRows;

      const textDisplay = routing?.text.activeModelName ?? localizer(locale, "commands.personal.config.server_default");
      const visionDisplay =
        routing?.vision.activeModelName ?? localizer(locale, "commands.personal.config.server_default");
      const embeddingDisplay =
        routing?.embedding.activeModelName ?? localizer(locale, "commands.personal.config.server_default");
      const imageStandardDisplay =
        routing?.image.activeModelName ?? localizer(locale, "commands.personal.config.server_default");
      const imageNaiDisplay =
        routing?.image_nai.activeModelName ?? localizer(locale, "commands.personal.config.server_default");
      const videoDisplay =
        routing?.video.activeModelName ?? localizer(locale, "commands.personal.config.server_default");

      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.models_title")}
${localizer(locale, "commands.personal.config.models_description")}

> ${localizer(locale, "commands.personal.config.routing_text")}: \`${textDisplay}\`
> ${localizer(locale, "commands.personal.config.routing_vision")}: \`${visionDisplay}\`
> ${localizer(locale, "commands.personal.config.routing_embedding")}: \`${embeddingDisplay}\`
> ${localizer(locale, "commands.personal.config.routing_image_standard")}: \`${imageStandardDisplay}\`
> ${localizer(locale, "commands.personal.config.routing_image_nai")}: \`${imageNaiDisplay}\`
> ${localizer(locale, "commands.personal.config.routing_video")}: \`${videoDisplay}\`
-# ${localizer(locale, "commands.personal.config.manage_providers_hint")}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              customId: buildPersonalConfigCustomId("quick-toggle-open", locale),
              label: localizer(locale, "commands.personal.config.quick_toggle_button"),
              disabled: writesDisabled,
            },
          ],
        },
        { type: ComponentType.Separator, divider: true, spacing: 1 },
      );

      const capRow = routing?.[selectedCap];
      const isActive = Boolean(capRow?.activeModelName);
      const storedDesc = capRow?.storedModelName ?? localizer(locale, "commands.personal.config.saved_assignment_none");
      const statusDesc = isActive
        ? localizer(locale, "commands.personal.config.override_status_personal")
        : localizer(locale, "commands.personal.config.override_status_server_default");

      const capName = localizer(
        locale,
        `commands.personal.config.routing_${selectedCap === "image_nai" ? "image_nai" : selectedCap === "image" ? "image_standard" : selectedCap}`,
      );

      const capabilityOptions: SelectMenuComponentOptionData[] = [
        {
          value: "text",
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_text"), 100),
          default: selectedCap === "text",
        },
        {
          value: "vision",
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_vision"), 100),
          default: selectedCap === "vision",
        },
        {
          value: "embedding",
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_embedding"), 100),
          default: selectedCap === "embedding",
        },
        {
          value: "image",
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_image_standard"), 100),
          default: selectedCap === "image",
        },
        {
          value: "image_nai",
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_image_nai"), 100),
          default: selectedCap === "image_nai",
        },
        {
          value: "video",
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_video"), 100),
          default: selectedCap === "video",
        },
      ];

      components.push(
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: buildPersonalConfigCustomId("capability-select", locale),
              placeholder: safeSelectOptionText(
                localizer(locale, "commands.personal.config.capability_select_placeholder"),
                100,
              ),
              options: capabilityOptions,
              disabled: writesDisabled,
            },
          ],
        },
        {
          type: ComponentType.TextDisplay,
          content: `**${localizer(locale, "commands.personal.config.manage_capability_heading", { capability: capName })}**
> ${localizer(locale, "commands.personal.config.override_status_label")}: ${statusDesc}
> ${localizer(locale, "commands.personal.config.saved_assignment_label")}: ${storedDesc}`,
        },
      );

      const eligibleProviders = info?.eligibleProvidersForCapability?.[selectedCap] ?? [];
      const providerOptions: SelectMenuComponentOptionData[] = [
        {
          value: "__server_default__",
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.use_server_default_option"), 100),
        },
        ...eligibleProviders.map((p) => ({
          value: encodeProviderParam(p),
          label: safeSelectOptionText(getProviderDisplayName(p), 100),
        })),
      ];

      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildPersonalConfigCustomId("model-provider-select", locale, selectedCap),
            placeholder: safeSelectOptionText(
              localizer(locale, "commands.personal.config.choose_model_placeholder"),
              100,
            ),
            options: providerOptions,
            disabled: writesDisabled || eligibleProviders.length === 0,
          },
        ],
      });

      const actionButtons: ButtonComponentData[] = [];
      if (isActive) {
        actionButtons.push({
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildPersonalConfigCustomId("model-default", locale, selectedCap),
          label: localizer(locale, "commands.personal.config.use_server_default_button"),
          disabled: writesDisabled,
        });
      } else if (capRow?.storedModelName) {
        actionButtons.push({
          type: ComponentType.Button,
          style: ButtonStyle.Primary,
          customId: buildPersonalConfigCustomId("model-enable", locale, selectedCap),
          label: localizer(locale, "commands.personal.config.enable_saved_override_button"),
          disabled: writesDisabled,
        });
      }

      if (actionButtons.length > 0) {
        components.push({
          type: ComponentType.ActionRow,
          components: actionButtons,
        });
      }
    } else if (page === "parameters") {
      const selectedProvider = input.selectedParametersProvider ?? input.modelDisplayInfo?.parametersProviders[0] ?? "";
      const config = input.modelDisplayInfo?.selectedParametersConfig;

      if (!selectedProvider || !config) {
        components.push({
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.parameters_title")}
${localizer(locale, "commands.personal.config.no_text_providers")}`,
        });
      } else {
        components.push({
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.parameters_title")}
${localizer(locale, "commands.personal.config.parameters_description")}`,
        });

        if (input.modelDisplayInfo && input.modelDisplayInfo.parametersProviders.length > 1) {
          components.push({
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.StringSelect,
                customId: buildPersonalConfigCustomId("parameters-provider-select", locale),
                placeholder: safeSelectOptionText(
                  localizer(locale, "commands.personal.config.provider_select_placeholder"),
                  100,
                ),
                options: input.modelDisplayInfo.parametersProviders.map((p) => ({
                  value: encodeProviderParam(p),
                  label: safeSelectOptionText(getProviderDisplayName(p), 100),
                  default: p.toLowerCase() === selectedProvider.toLowerCase(),
                })),
                disabled: writesDisabled,
              },
            ],
          });
        }

        const encodedP = encodeProviderParam(selectedProvider);
        const tempStr =
          config.llm_temperature !== null && config.llm_temperature !== undefined
            ? String(config.llm_temperature)
            : "0.7";
        const minPStr = config.llm_min_p !== null && config.llm_min_p !== undefined ? String(config.llm_min_p) : "0.05";
        const topPStr = config.llm_top_p !== null && config.llm_top_p !== undefined ? String(config.llm_top_p) : "0.95";
        const topKStr = config.llm_top_k !== null && config.llm_top_k !== undefined ? String(config.llm_top_k) : "0";
        const freqStr =
          config.llm_frequency_penalty !== null && config.llm_frequency_penalty !== undefined
            ? String(config.llm_frequency_penalty)
            : "0";
        const presStr =
          config.llm_presence_penalty !== null && config.llm_presence_penalty !== undefined
            ? String(config.llm_presence_penalty)
            : "0";
        const maxTokStr =
          config.llm_max_output_tokens !== null && config.llm_max_output_tokens !== undefined
            ? String(config.llm_max_output_tokens)
            : "None (provider default)";
        const thinkStr = config.thinking_level ?? "auto";

        components.push(
          {
            type: ComponentType.TextDisplay,
            content: `> ${localizer(locale, "commands.personal.config.provider_label")}: \`${getProviderDisplayName(selectedProvider)}\`
> ${localizer(locale, "commands.personal.config.param_temperature")}: \`${tempStr}\`
> ${localizer(locale, "commands.personal.config.param_min_p")}: \`${minPStr}\`
> ${localizer(locale, "commands.personal.config.param_top_p")}: \`${topPStr}\`
> ${localizer(locale, "commands.personal.config.param_top_k")}: \`${topKStr}\`
> ${localizer(locale, "commands.personal.config.param_frequency_penalty")}: \`${freqStr}\``,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildPersonalConfigCustomId("parameters-1-open", locale, encodedP),
                label: localizer(locale, "commands.personal.config.edit_params_1_button"),
                disabled: writesDisabled,
              },
            ],
          },
          {
            type: ComponentType.TextDisplay,
            content: `> ${localizer(locale, "commands.personal.config.param_presence_penalty")}: \`${presStr}\`
> ${localizer(locale, "commands.personal.config.param_max_output_tokens")}: \`${maxTokStr}\`
> ${localizer(locale, "commands.personal.config.param_thinking_level")}: \`${thinkStr}\``,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildPersonalConfigCustomId("parameters-2-open", locale, encodedP),
                label: localizer(locale, "commands.personal.config.edit_params_2_button"),
                disabled: writesDisabled,
              },
            ],
          },
        );
      }
    } else if (page === "fallbacks") {
      const selectedProvider = input.selectedFallbacksProvider ?? input.modelDisplayInfo?.fallbacksProviders[0] ?? "";
      const config = input.modelDisplayInfo?.selectedFallbacksConfig;

      if (!selectedProvider || !config) {
        components.push({
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.fallbacks_title")}
${localizer(locale, "commands.personal.config.no_text_providers_fallbacks")}`,
        });
      } else {
        components.push({
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.fallbacks_title")}
${localizer(locale, "commands.personal.config.fallbacks_description")}`,
        });

        if (input.modelDisplayInfo && input.modelDisplayInfo.fallbacksProviders.length > 1) {
          components.push({
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.StringSelect,
                customId: buildPersonalConfigCustomId("fallbacks-provider-select", locale),
                placeholder: safeSelectOptionText(
                  localizer(locale, "commands.personal.config.provider_select_placeholder"),
                  100,
                ),
                options: input.modelDisplayInfo.fallbacksProviders.map((p) => ({
                  value: encodeProviderParam(p),
                  label: safeSelectOptionText(getProviderDisplayName(p), 100),
                  default: p.toLowerCase() === selectedProvider.toLowerCase(),
                })),
                disabled: writesDisabled,
              },
            ],
          });
        }

        const encodedP = encodeProviderParam(selectedProvider);
        const primaryName =
          input.modelDisplayInfo?.primaryModelName ??
          localizer(locale, "commands.personal.config.saved_assignment_none");
        const slots = input.modelDisplayInfo?.fallbackSlots ?? [];
        const slotLines = slots
          .map(
            (s) =>
              `> ${s.slot}. \`${s.modelName ?? localizer(locale, "commands.personal.config.saved_assignment_none")}\``,
          )
          .join("\n");

        components.push(
          {
            type: ComponentType.TextDisplay,
            content: `> ${localizer(locale, "commands.personal.config.provider_label")}: \`${getProviderDisplayName(selectedProvider)}\`
> ${localizer(locale, "commands.personal.config.fallbacks_primary_label")}: \`${primaryName}\`
${slotLines}`,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildPersonalConfigCustomId("fallbacks-open", locale, encodedP),
                label: localizer(locale, "commands.personal.config.edit_fallbacks_button"),
                disabled: writesDisabled,
              },
            ],
          },
          { type: ComponentType.Separator, divider: true, spacing: 1 },
        );

        const isRandomizerOn = Boolean(input.modelDisplayInfo?.randomizerEnabled);
        const statusStr = isRandomizerOn
          ? localizer(locale, "commands.personal.config.randomizer_status_enabled")
          : localizer(locale, "commands.personal.config.randomizer_status_disabled");

        components.push(
          {
            type: ComponentType.TextDisplay,
            content: `**${localizer(locale, "commands.personal.config.randomizer_section_title")}**
${localizer(locale, "commands.personal.config.randomizer_section_desc")}

${statusStr}`,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: isRandomizerOn ? ButtonStyle.Secondary : ButtonStyle.Primary,
                customId: buildPersonalConfigCustomId("randomizer-toggle", locale, encodedP),
                label: isRandomizerOn
                  ? localizer(locale, "commands.personal.config.disable_randomizer_button")
                  : localizer(locale, "commands.personal.config.enable_randomizer_button"),
                disabled: writesDisabled,
              },
            ],
          },
        );
      }
    }
  } else if (category === "advanced") {
    components.push({
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.personal.config.advanced_stub_title")}
${localizer(locale, "commands.personal.config.advanced_stub_description")}`,
    });
  }

  if (readStatus === "stale") {
    components.push(
      buildRetryRow(locale, category, page, selectedLineageId),
      { type: ComponentType.Separator, divider: true, spacing: 1 },
      {
        type: ComponentType.TextDisplay,
        content: `-# ${localizer(locale, "commands.personal.config.stale_warning")}`,
      },
    );
  }

  return buildPayload(components, receipt);
}
