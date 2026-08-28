import {
  ButtonStyle,
  ChannelType,
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
import type { PersonalSpotlightStatus } from "@/utils/db/repositories/UserRepository";
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
  SPOTLIGHT_REMOVE_PAGE_SIZE,
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

/** Discord rejects a String Select carrying more than 25 options. */
const PERSONA_SELECT_MAX_OPTIONS = 25;

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
    }
  | { kind: "impersonation-clear-confirm"; nonce: string }
  | {
      kind: "spotlight-set-review";
      channelId: string;
      hours: number;
      selectedPersonaIds: number[];
      autoTriggerPersonaId: number | null;
      mask: string;
      nonce: string;
    }
  | {
      kind: "spotlight-remove-range";
      rangePage: number;
      totalOptions: number;
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

export interface PersonalConfigSpotlightDisplayInfo {
  activeSpotlights: PersonalSpotlightStatus[];
  personas: Array<{ id: number; name: string; isAlter: boolean }>;
}

export interface PersonalConfigPanelRenderInput {
  locale: string;
  category: PersonalConfigCategory;
  page: PersonalConfigPage;
  user: UserRow;
  resolvedNickname: string;
  personas: TomoriState[];
  guildId: string | null;
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
  spotlightDisplayInfo?: PersonalConfigSpotlightDisplayInfo;
  serverTriggerBehavior?: { deliberate_trigger_mode: boolean; deliberate_tool_mode: boolean } | null;
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

export function buildImpersonationModal(
  locale: string,
  nonce: string,
  currentPrompt: string | null,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalConfigCustomId("impersonation-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.impersonation_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.impersonation_modal_label"), 45),
        description: safeModalLocalizer(locale, "commands.personal.config.impersonation_modal_desc"),
        component: {
          type: 4,
          custom_id: buildPersonalConfigModalFieldId("prompt", nonce),
          style: TextInputStyle.Paragraph,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.config.impersonation_modal_placeholder"),
            100,
          ),
          max_length: 4000,
          required: false,
          value: currentPrompt ?? "",
        },
      },
    ],
  };
}

export function buildSpotlightSetModal(
  locale: string,
  nonce: string,
  personas: Array<{ id: number; name: string; isAlter: boolean }>,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const components: RawDiscordComponent[] = [
    {
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_channel_label"), 45),
      description: safeModalLocalizer(locale, "commands.personal.config.spotlight_channel_desc"),
      component: {
        type: 8,
        custom_id: buildPersonalConfigModalFieldId("channel", nonce),
        channel_types: [ChannelType.GuildText],
        min_values: 1,
        max_values: 1,
        required: true,
      },
    },
    {
      type: 18,
      label: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_hours_label"), 45),
      description: safeModalLocalizer(locale, "commands.personal.config.spotlight_hours_desc"),
      component: {
        type: 4,
        custom_id: buildPersonalConfigModalFieldId("hours", nonce),
        style: TextInputStyle.Short,
        placeholder: safeSelectOptionText(
          localizer(locale, "commands.personal.config.spotlight_hours_placeholder"),
          100,
        ),
        max_length: 6,
        required: true,
        value: "0",
      },
    },
  ];

  const maxGroups = 3;
  for (let g = 0; g < maxGroups && g * 10 < personas.length; g++) {
    const chunk = personas.slice(g * 10, (g + 1) * 10);
    components.push({
      type: 18,
      label: safeSelectOptionText(
        localizer(
          locale,
          g === 0
            ? "commands.personal.config.spotlight_personas_label"
            : "commands.personal.config.spotlight_personas_label_continued",
        ),
        45,
      ),
      description: g === 0 ? safeModalLocalizer(locale, "commands.personal.config.spotlight_personas_desc") : undefined,
      component: {
        type: 22,
        custom_id: buildPersonalConfigModalFieldId(`personas_${g}`, nonce),
        min_values: 0,
        max_values: chunk.length,
        required: false,
        options: chunk.map((p) => ({
          label: safeSelectOptionText(p.name, 100),
          value: String(p.id),
          description: safeSelectOptionText(
            localizer(
              locale,
              p.isAlter
                ? "commands.shared.persona_select.alter_persona_description"
                : "commands.shared.persona_select.main_persona_description",
            ),
            100,
          ),
          default: false,
        })),
      },
    });
  }

  return {
    custom_id: buildPersonalConfigCustomId("spotlight-set-submit", locale, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_set_modal_title"), 45),
    components,
  };
}

export function buildSpotlightAutoTriggerModal(
  locale: string,
  nonce: string,
  channelId: string,
  hours: number,
  mask: string,
  selectedPersonas: Array<{ id: number; name: string; isAlter: boolean }>,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const options = [
    {
      value: "0",
      label: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_auto_none"), 100),
      default: true,
    },
    ...selectedPersonas.slice(0, 24).map((p) => ({
      value: String(p.id),
      label: safeSelectOptionText(p.name, 100),
      description: safeSelectOptionText(
        localizer(
          locale,
          p.isAlter
            ? "commands.shared.persona_select.alter_persona_description"
            : "commands.shared.persona_select.main_persona_description",
        ),
        100,
      ),
    })),
  ];

  return {
    custom_id: buildPersonalConfigCustomId("spot-set-auto-sub", locale, channelId, hours, mask, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_auto_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_auto_select_label"), 45),
        description: safeModalLocalizer(locale, "commands.personal.config.spotlight_auto_select_desc"),
        component: {
          type: 21,
          custom_id: buildPersonalConfigModalFieldId("auto_trigger", nonce),
          required: true,
          options,
        },
      },
    ],
  };
}

export function buildSpotlightRemoveModal(
  locale: string,
  nonce: string,
  start: number,
  activeSpotlights: PersonalSpotlightStatus[],
  personas: Array<{ id: number; name: string; isAlter: boolean }>,
  guildChannels: Map<string, { name: string }> | undefined,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const personaMap = new Map(personas.map((p) => [p.id, p.name]));
  const components: RawDiscordComponent[] = [];

  for (let g = 0; g < 5 && g * 10 < activeSpotlights.length; g++) {
    const chunk = activeSpotlights.slice(g * 10, (g + 1) * 10);
    components.push({
      type: 18,
      label: safeSelectOptionText(
        localizer(
          locale,
          g === 0
            ? "commands.personal.config.spotlight_remove_label"
            : "commands.personal.config.spotlight_remove_label_continued",
        ),
        45,
      ),
      description: g === 0 ? safeModalLocalizer(locale, "commands.personal.config.spotlight_remove_desc") : undefined,
      component: {
        type: 22,
        custom_id: buildPersonalConfigModalFieldId(`spotlights_${g}`, nonce),
        min_values: 0,
        max_values: chunk.length,
        required: false,
        options: chunk.map((entry) => {
          const chName = guildChannels?.get(entry.channelDiscId)?.name ?? "unknown";
          const durStr =
            entry.expiresAt === null
              ? localizer(locale, "commands.personal.config.spotlight_duration_permanent")
              : localizer(locale, "commands.personal.config.spotlight_duration_until", {
                  expires_at: `<t:${Math.floor(entry.expiresAt.getTime() / 1000)}:R>`,
                });
          const autoStr =
            entry.autoTriggerPersonaId !== null
              ? (personaMap.get(entry.autoTriggerPersonaId) ?? String(entry.autoTriggerPersonaId))
              : localizer(locale, "commands.personal.config.spotlight_auto_none");
          const autoLabel = localizer(locale, "commands.personal.config.spotlight_auto_label");
          const countStr = localizer(locale, "commands.personal.config.spotlight_persona_count", {
            count: entry.personaIds.length,
          });
          return {
            label: safeSelectOptionText(`#${chName}`, 100),
            value: entry.channelDiscId,
            description: safeSelectOptionText(`${durStr} · ${autoLabel}: ${autoStr} · ${countStr}`, 100),
            default: true,
          };
        }),
      },
    });
  }

  return {
    custom_id: buildPersonalConfigCustomId("spotlight-remove-submit", locale, start, nonce),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_remove_modal_title"), 45),
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
  guildId: string | null,
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
    case "advanced": {
      const options: SelectMenuComponentOptionData[] = [
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
      ];
      if (guildId !== null) {
        options.push({
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.page_spotlight"), 100),
          value: "spotlight",
          default: currentPage === "spotlight",
        });
      }
      return options;
    }
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
    case "impersonation-clear-confirm": {
      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.impersonation_clear_confirm_title")}
${localizer(locale, "commands.personal.config.impersonation_clear_confirm_desc")}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildPersonalConfigCustomId("impersonation-clear-confirm", locale, view.nonce),
              label: localizer(locale, "commands.personal.config.impersonation_clear_button"),
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("impersonation-clear-cancel", locale),
              label: localizer(locale, "commands.personal.config.cancel"),
            },
          ],
        },
      ];
    }
    case "spotlight-set-review": {
      const personas = input.spotlightDisplayInfo?.personas ?? [];
      const personaMap = new Map(personas.map((p) => [p.id, p.name]));
      const selectedPersonas = personas.filter((p) => view.selectedPersonaIds.includes(p.id));
      const durationText =
        view.hours === 0
          ? localizer(locale, "commands.personal.config.spotlight_duration_permanent")
          : localizer(locale, "commands.personal.config.spotlight_duration_hours", {
              hours: view.hours,
            });
      const personaNamesList = selectedPersonas.map((p) => `**${p.name}**`).join(", ");
      const autoTriggerName = view.autoTriggerPersonaId
        ? (personaMap.get(view.autoTriggerPersonaId) ?? String(view.autoTriggerPersonaId))
        : localizer(locale, "commands.personal.config.spotlight_auto_none");
      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.spotlight_review_title")}

> Channel: <#${view.channelId}>
> Duration: ${durationText}
> Personas: ${personaNamesList}
> Auto-trigger: ${autoTriggerName}

${localizer(locale, "commands.personal.config.spotlight_review_prompt")}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Success,
              customId: buildPersonalConfigCustomId(
                "spot-set-cf",
                locale,
                view.channelId,
                view.hours,
                view.autoTriggerPersonaId ?? 0,
                view.mask,
                view.nonce,
              ),
              label: localizer(locale, "commands.personal.config.spotlight_save_button"),
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              customId: buildPersonalConfigCustomId(
                "spot-set-auto",
                locale,
                view.channelId,
                view.hours,
                view.mask,
                view.nonce,
              ),
              label: localizer(locale, "commands.personal.config.spotlight_auto_button"),
              disabled: selectedPersonas.length <= 1,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("spotlight-set-cancel", locale),
              label: localizer(locale, "commands.personal.config.cancel"),
            },
          ],
        },
      ];
    }
    case "spotlight-remove-range": {
      const totalRanges = Math.ceil(view.totalOptions / SPOTLIGHT_REMOVE_PAGE_SIZE);
      const startRange = view.rangePage * 5;
      const endRange = Math.min(startRange + 5, totalRanges);

      const buttons: ButtonComponentData[] = [];
      for (let r = startRange; r < endRange; r++) {
        const start = r * SPOTLIGHT_REMOVE_PAGE_SIZE + 1;
        const end = Math.min((r + 1) * SPOTLIGHT_REMOVE_PAGE_SIZE, view.totalOptions);
        buttons.push({
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildPersonalConfigCustomId("spot-rem-range", locale, r * SPOTLIGHT_REMOVE_PAGE_SIZE),
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
          customId: buildPersonalConfigCustomId("spotlight-remove-cancel", locale),
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
          content: `### ${localizer(locale, "commands.personal.config.spotlight_remove_range_title")}
${localizer(locale, "commands.personal.config.spotlight_remove_range_desc")}`,
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

  const pageOptions = getPageOptionsForCategory(locale, category, page, input.guildId);
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
        : localizer(locale, "commands.personal.config.general_naming_inherited");
      const suffixLabel = user.suffix_override
        ? `\`${escapeDiscordMarkdown(user.suffix_override)}\``
        : localizer(locale, "commands.personal.config.general_naming_inherited");

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
${localizer(locale, "commands.personal.config.interface_description")}
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
${localizer(locale, "commands.personal.config.naming_description")}
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
${localizer(locale, "commands.personal.config.about_description")}
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

        // Naming preferences are keyed by lineage, not by persona, and two personas in one server can
        // share a lineage. Emitting one option per persona then repeats an option value, which Discord
        // rejects outright with COMPONENT_OPTION_VALUE_DUPLICATED.
        const personasByLineage = new Map<number, TomoriState[]>();
        for (const p of personas) {
          const lineage = p.persona_lineage_id;
          if (lineage === undefined || lineage === null) continue;
          const bucket = personasByLineage.get(lineage);
          if (bucket) bucket.push(p);
          else personasByLineage.set(lineage, [p]);
        }

        const lineageEntries = [...personasByLineage.entries()];
        const visibleLineages = lineageEntries.slice(0, PERSONA_SELECT_MAX_OPTIONS);
        const hiddenLineageCount = lineageEntries.length - visibleLineages.length;

        const personaOptions: SelectMenuComponentOptionData[] = visibleLineages.map(([lineage, sharing]) => {
          const first = sharing[0];
          return {
            label: safeSelectOptionText(
              first?.persona_nickname || localizer(locale, "commands.personal.config.persona_default_name"),
              100,
            ),
            value: String(lineage),
            description: safeSelectOptionText(
              sharing.length > 1
                ? localizer(locale, "commands.personal.config.persona_shared_lineage_description", {
                    count: sharing.length,
                  })
                : localizer(
                    locale,
                    first?.is_alter
                      ? "commands.personal.config.persona_alter_description"
                      : "commands.personal.config.persona_main_description",
                  ),
              100,
            ),
            default: lineage === currentLineage,
          };
        });

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

        if (hiddenLineageCount > 0) {
          components.push({
            type: ComponentType.TextDisplay,
            content: `-# ${localizer(locale, "commands.personal.config.persona_select_truncated", {
              count: hiddenLineageCount,
            })}`,
          });
        }

        const nicknameOverrideLabel = personaNamingPreference?.nickname_override
          ? `\`${escapeDiscordMarkdown(personaNamingPreference.nickname_override)}\``
          : localizer(locale, "commands.personal.config.persona_naming_inherited");
        const prefixOverrideLabel = personaNamingPreference?.prefix_override
          ? `\`${escapeDiscordMarkdown(personaNamingPreference.prefix_override)}\``
          : localizer(locale, "commands.personal.config.persona_naming_inherited");
        const suffixOverrideLabel = personaNamingPreference?.suffix_override
          ? `\`${escapeDiscordMarkdown(personaNamingPreference.suffix_override)}\``
          : localizer(locale, "commands.personal.config.persona_naming_inherited");

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
-# ${localizer(locale, "commands.personal.config.stm_clear_hint")}`,
      },
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.personal.config.crossserver_section_title")}**
${
  isCrossServerOn
    ? localizer(locale, "commands.personal.config.crossserver_stm_on")
    : localizer(locale, "commands.personal.config.crossserver_stm_off")
}
-# ${localizer(locale, "commands.personal.config.crossserver_stm_footer")}`,
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
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.capability_option_text"), 100),
          default: selectedCap === "text",
        },
        {
          value: "vision",
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.capability_option_vision"), 100),
          default: selectedCap === "vision",
        },
        {
          value: "embedding",
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.capability_option_embedding"), 100),
          default: selectedCap === "embedding",
        },
        {
          value: "image",
          label: safeSelectOptionText(
            localizer(locale, "commands.personal.config.capability_option_image_standard"),
            100,
          ),
          default: selectedCap === "image",
        },
        {
          value: "image_nai",
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.capability_option_image_nai"), 100),
          default: selectedCap === "image_nai",
        },
        {
          value: "video",
          label: safeSelectOptionText(localizer(locale, "commands.personal.config.capability_option_video"), 100),
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
    if (page === "response-modes") {
      const dtmMode = user.personal_dtm ?? "follow";
      const toolMode = user.personal_deliberate_tool_mode ?? "follow";
      const isGuild = input.guildId !== null;

      const serverDtm = input.serverTriggerBehavior?.deliberate_trigger_mode ?? false;
      const serverToolMode = input.serverTriggerBehavior?.deliberate_tool_mode ?? false;

      let dtmEffectText: string;
      let dtmStatusText: string;
      if (!isGuild) {
        dtmEffectText = localizer(locale, "commands.personal.config.dtm_effect_dm");
        dtmStatusText =
          dtmMode === "on"
            ? localizer(locale, "commands.personal.config.mode_status_on")
            : dtmMode === "off"
              ? localizer(locale, "commands.personal.config.mode_status_off")
              : localizer(locale, "commands.personal.config.mode_status_follow_dm");
      } else {
        const isDtmActive = dtmMode === "on" || (dtmMode === "follow" && serverDtm);
        dtmEffectText = isDtmActive
          ? localizer(locale, "commands.personal.config.dtm_effect_active")
          : localizer(locale, "commands.personal.config.dtm_effect_inactive");

        if (dtmMode === "on") {
          dtmStatusText = localizer(locale, "commands.personal.config.mode_status_on");
        } else if (dtmMode === "off") {
          dtmStatusText = localizer(locale, "commands.personal.config.mode_status_off");
        } else {
          dtmStatusText = serverDtm
            ? localizer(locale, "commands.personal.config.mode_status_follow_server_on")
            : localizer(locale, "commands.personal.config.mode_status_follow_server_off");
        }
      }

      const isToolModeActive = toolMode === "on" || (toolMode === "follow" && (isGuild ? serverToolMode : false));
      const toolEffectText = isToolModeActive
        ? localizer(locale, "commands.personal.config.tool_mode_effect_active")
        : localizer(locale, "commands.personal.config.tool_mode_effect_inactive");

      let toolStatusText: string;
      if (toolMode === "on") {
        toolStatusText = localizer(locale, "commands.personal.config.mode_status_on");
      } else if (toolMode === "off") {
        toolStatusText = localizer(locale, "commands.personal.config.mode_status_off");
      } else if (isGuild) {
        toolStatusText = serverToolMode
          ? localizer(locale, "commands.personal.config.mode_status_follow_server_on")
          : localizer(locale, "commands.personal.config.mode_status_follow_server_off");
      } else {
        toolStatusText = localizer(locale, "commands.personal.config.mode_status_follow_dm");
      }

      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.response_modes_title")}`,
        },
        {
          type: ComponentType.TextDisplay,
          content: `**[${localizer(locale, "commands.personal.config.dtm_section_title")}](https://docs.tomoribot.app/en/features/chatting-personality/chatting-and-triggers/#deliberate-trigger-mode)**\n${localizer(locale, "commands.personal.config.dtm_description")}\n> ${dtmEffectText}\n> ${dtmStatusText}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: dtmMode === "off" ? ButtonStyle.Primary : ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("trigger-mode-set", locale, "off"),
              label: localizer(locale, "commands.personal.config.mode_off"),
              disabled: writesDisabled || dtmMode === "off",
            },
            {
              type: ComponentType.Button,
              style: dtmMode === "follow" ? ButtonStyle.Primary : ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("trigger-mode-set", locale, "follow"),
              label: localizer(locale, "commands.personal.config.mode_follow"),
              disabled: writesDisabled || dtmMode === "follow",
            },
            {
              type: ComponentType.Button,
              style: dtmMode === "on" ? ButtonStyle.Primary : ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("trigger-mode-set", locale, "on"),
              label: localizer(locale, "commands.personal.config.mode_on"),
              disabled: writesDisabled || dtmMode === "on",
            },
          ],
        },
        { type: ComponentType.Separator, divider: true, spacing: 1 },
        {
          type: ComponentType.TextDisplay,
          content: `**[${localizer(locale, "commands.personal.config.tool_mode_section_title")}](https://docs.tomoribot.app/en/features/capabilities/tools-and-extensions/#deliberate-tool-mode)** (EXPERIMENTAL)\n${localizer(locale, "commands.personal.config.tool_mode_description")}\n> ${toolEffectText}\n> ${toolStatusText}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: toolMode === "off" ? ButtonStyle.Primary : ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("tool-mode-set", locale, "off"),
              label: localizer(locale, "commands.personal.config.mode_off"),
              disabled: writesDisabled || toolMode === "off",
            },
            {
              type: ComponentType.Button,
              style: toolMode === "follow" ? ButtonStyle.Primary : ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("tool-mode-set", locale, "follow"),
              label: localizer(locale, "commands.personal.config.mode_follow"),
              disabled: writesDisabled || toolMode === "follow",
            },
            {
              type: ComponentType.Button,
              style: toolMode === "on" ? ButtonStyle.Primary : ButtonStyle.Secondary,
              customId: buildPersonalConfigCustomId("tool-mode-set", locale, "on"),
              label: localizer(locale, "commands.personal.config.mode_on"),
              disabled: writesDisabled || toolMode === "on",
            },
          ],
        },
      );
    } else if (page === "impersonation") {
      const prompt = user.impersonation_prompt?.trim();
      let previewText: string;
      if (!prompt) {
        previewText = localizer(locale, "commands.personal.config.impersonation_no_prompt");
      } else {
        const truncated = prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt;
        previewText = escapeDiscordMarkdown(truncated);
      }

      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.impersonation_title")}\n${localizer(locale, "commands.personal.config.impersonation_description")}\n> ${previewText}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              customId: buildPersonalConfigCustomId("impersonation-open", locale),
              label: localizer(locale, "commands.personal.config.impersonation_edit_button"),
              disabled: writesDisabled,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildPersonalConfigCustomId("impersonation-clear-view", locale),
              label: localizer(locale, "commands.personal.config.impersonation_clear_button"),
              disabled: writesDisabled || !prompt,
            },
          ],
        },
      );
    } else if (page === "spotlight") {
      if (input.guildId === null) {
        components.push({
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.spotlight_title")}\n${localizer(locale, "commands.personal.config.spotlight_guild_only_detail")}`,
        });
      } else {
        const activeSpotlights = input.spotlightDisplayInfo?.activeSpotlights ?? [];
        const personas = input.spotlightDisplayInfo?.personas ?? [];
        const personaMap = new Map(personas.map((p) => [p.id, p.name]));

        let spotlightRowsText = "";
        if (activeSpotlights.length === 0) {
          spotlightRowsText = `> ${localizer(locale, "commands.personal.config.spotlight_none_active")}`;
        } else {
          const rows = activeSpotlights.map((entry) => {
            const durationStr =
              entry.expiresAt === null
                ? localizer(locale, "commands.personal.config.spotlight_duration_permanent")
                : localizer(locale, "commands.personal.config.spotlight_duration_until", {
                    expires_at: `<t:${Math.floor(entry.expiresAt.getTime() / 1000)}:R>`,
                  });
            const countStr = localizer(locale, "commands.personal.config.spotlight_persona_count", {
              count: entry.personaIds.length,
            });
            const autoStr =
              entry.autoTriggerPersonaId !== null
                ? (personaMap.get(entry.autoTriggerPersonaId) ?? String(entry.autoTriggerPersonaId))
                : localizer(locale, "commands.personal.config.spotlight_auto_none");
            const autoLabel = localizer(locale, "commands.personal.config.spotlight_auto_label");
            return `> <#${entry.channelDiscId}> · ${durationStr} · ${countStr} · ${autoLabel}: ${autoStr}`;
          });
          spotlightRowsText = rows.join("\n");
        }

        components.push(
          {
            type: ComponentType.TextDisplay,
            content: `### ${localizer(locale, "commands.personal.config.spotlight_title")}\n${localizer(locale, "commands.personal.config.spotlight_description")}\n${spotlightRowsText}`,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Primary,
                customId: buildPersonalConfigCustomId("spotlight-set-open", locale),
                label: localizer(locale, "commands.personal.config.spotlight_set_button"),
                disabled: writesDisabled,
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Danger,
                customId: buildPersonalConfigCustomId("spotlight-remove-open", locale),
                label: localizer(locale, "commands.personal.config.spotlight_remove_button"),
                disabled: writesDisabled || activeSpotlights.length === 0,
              },
            ],
          },
        );
      }
    }
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
