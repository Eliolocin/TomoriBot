import { ChannelType, TextInputStyle } from "discord.js";
import { PrivacyLevel, type FallbackModelRef, type UserSavedProviderConfigRow } from "@/types/db/schema";
import type { PersonalSpotlightStatus } from "@/utils/db/repositories/UserRepository";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import {
  PERSONA_NAMING_VALUE_MAX_LENGTH,
  USER_IDENTITY_FIELD_MAX_LENGTH,
  USER_NICKNAME_MAX_LENGTH,
} from "@/types/personaNaming";
import {
  buildPersonalConfigRouteId,
  PERSONAL_FALLBACK_PAGE_SIZE,
  PERSONAL_MODEL_PAGE_SIZE,
  ROUTING_CAPABILITY_LOCALE_KEYS,
  SPOTLIGHT_PERSONA_PAGE_SIZE,
  SPOTLIGHT_REMOVE_PAGE_SIZE,
  type PersonalConfigManagedCapability,
} from "@/utils/discord/personalConfigPanelCatalog";
import { safeModalLocalizer, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { formatStoredParameterValue } from "@/utils/discord/ui/personalConfigParameterControls";
import { formatImageTagsForModalValue, TAGS_MODAL_MAX_LENGTH } from "@/utils/image/tagHelpers";
import { localizer } from "@/utils/text/localizer";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import {
  getActivePersonalProviderForCapability,
  getStoredPersonalProviderForCapability,
} from "@/utils/provider/personalProviderHelpers";
import { getFallbackModelRefKey } from "@/utils/provider/fallbackModelIdentity";
import { THINKING_LEVEL_LOCALIZER_KEYS, THINKING_LEVEL_VALUES } from "@/constants/thinkingLevels";

export function buildPersonalConfigModalFieldId(field: string, nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildLanguageModal(
  locale: string,
  nonce: string,
  currentLanguage: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalConfigRouteId({ action: "language-submit", locale, nonce }),
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
    custom_id: buildPersonalConfigRouteId({ action: "timezone-submit", locale, nonce }),
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
    custom_id: buildPersonalConfigRouteId({ action: "naming-submit", locale, nonce }),
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
    custom_id: buildPersonalConfigRouteId({ action: "persona-naming-submit", locale, lineageId, nonce }),
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
    custom_id: buildPersonalConfigRouteId({ action: "about-submit", locale, nonce }),
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
    custom_id: buildPersonalConfigRouteId({ action: "appearance-submit", locale, nonce }),
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
    custom_id: buildPersonalConfigRouteId({ action: "privacy-level-submit", locale, nonce }),
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
  const visionActive = Boolean(getActivePersonalProviderForCapability(savedProviders, "vision"));
  const embedActive = Boolean(getActivePersonalProviderForCapability(savedProviders, "embedding"));
  const imageActive = Boolean(getActivePersonalProviderForCapability(savedProviders, "image"));
  const imageNaiActive = Boolean(getActivePersonalProviderForCapability(savedProviders, "image_nai"));
  const videoActive = Boolean(getActivePersonalProviderForCapability(savedProviders, "video"));

  const textStored = getStoredPersonalProviderForCapability(savedProviders, "text");
  const visionStored = getStoredPersonalProviderForCapability(savedProviders, "vision");
  const embedStored = getStoredPersonalProviderForCapability(savedProviders, "embedding");
  const imageStored = getStoredPersonalProviderForCapability(savedProviders, "image");
  const imageNaiStored = getStoredPersonalProviderForCapability(savedProviders, "image_nai");
  const videoStored = getStoredPersonalProviderForCapability(savedProviders, "video");

  const getDesc = (stored: UserSavedProviderConfigRow | null): string =>
    stored
      ? localizer(locale, "commands.personal.config.quick_toggle_provider_desc", {
          provider: getProviderDisplayName(stored.provider),
        })
      : localizer(locale, "commands.personal.config.quick_toggle_none_desc");

  return {
    custom_id: buildPersonalConfigRouteId({ action: "quick-toggle-submit", locale, nonce }),
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
          max_values: 6,
          required: false,
          options: [
            {
              value: "text",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_text"), 100),
              description: safeSelectOptionText(getDesc(textStored), 100),
              default: textActive,
            },
            {
              value: "vision",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_vision"), 100),
              description: safeSelectOptionText(getDesc(visionStored), 100),
              default: visionActive,
            },
            {
              value: "embedding",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_embedding"), 100),
              description: safeSelectOptionText(getDesc(embedStored), 100),
              default: embedActive,
            },
            {
              value: "image",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_image_standard"), 100),
              description: safeSelectOptionText(getDesc(imageStored), 100),
              default: imageActive,
            },
            {
              value: "image_nai",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_image_nai"), 100),
              description: safeSelectOptionText(getDesc(imageNaiStored), 100),
              default: imageNaiActive,
            },
            {
              value: "video",
              label: safeSelectOptionText(localizer(locale, "commands.personal.config.routing_video"), 100),
              description: safeSelectOptionText(getDesc(videoStored), 100),
              default: videoActive,
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
  const capName = localizer(locale, ROUTING_CAPABILITY_LOCALE_KEYS[capability]);
  const options = availableModels.slice(0, PERSONAL_MODEL_PAGE_SIZE).map((m) => ({
    value: String(m.id),
    label: safeSelectOptionText(m.name, 100),
    description: m.description ? safeSelectOptionText(m.description, 100) : undefined,
    default: m.id === currentModelId,
  }));

  return {
    custom_id: buildPersonalConfigRouteId({
      action: "model-modal-submit",
      locale,
      capability,
      provider,
      nonce,
    }),
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
          type: 3,
          custom_id: buildPersonalConfigModalFieldId("model", nonce),
          required: true,
          min_values: 1,
          max_values: 1,
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
    custom_id: buildPersonalConfigRouteId({ action: "parameters-1-submit", locale, provider, nonce }),
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
              ? formatStoredParameterValue(currentConfig.llm_temperature)
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
              ? formatStoredParameterValue(currentConfig.llm_min_p)
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
              ? formatStoredParameterValue(currentConfig.llm_top_p)
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
    custom_id: buildPersonalConfigRouteId({ action: "parameters-2-submit", locale, provider, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.params_2_modal_title"), 45),
    components: [
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
              ? formatStoredParameterValue(currentConfig.llm_frequency_penalty)
              : "",
        },
      },
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
              ? formatStoredParameterValue(currentConfig.llm_presence_penalty)
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
      ...availableOptions.slice(0, PERSONAL_FALLBACK_PAGE_SIZE).map((opt) => ({
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
        type: 3,
        custom_id: buildPersonalConfigModalFieldId(`slot_${slot}`, nonce),
        required: false,
        min_values: 0,
        max_values: 1,
        options,
      },
    });
  }

  return {
    custom_id: buildPersonalConfigRouteId({ action: "fallbacks-submit", locale, provider, nonce }),
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
    custom_id: buildPersonalConfigRouteId({ action: "impersonation-submit", locale, nonce }),
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

/**
 * Channel and duration take their own step so the persona modal that follows gets all five of
 * Discord's modal components as checkbox groups. A modal submit cannot open another modal, so the
 * persona step is reached through the message in between rather than directly from here.
 */
/**
 * Splits items into checkbox groups of at most ten. Sizes are balanced rather than greedy because a
 * greedy split leaves a remainder group of one, and Discord rejects a modal choice component holding
 * fewer than two options.
 */
function chunkForCheckboxGroups<T>(items: readonly T[], maxGroups: number): T[][] {
  const groupCount = Math.min(maxGroups, Math.max(1, Math.ceil(items.length / 10)));
  const base = Math.floor(items.length / groupCount);
  const remainder = items.length % groupCount;

  const groups: T[][] = [];
  let cursor = 0;
  for (let g = 0; g < groupCount; g += 1) {
    const size = base + (g < remainder ? 1 : 0);
    if (size === 0) break;
    groups.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

export function buildSpotlightStep1Modal(
  locale: string,
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalConfigRouteId({ action: "spotlight-set-step1", locale, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_set_modal_title"), 45),
    components: [
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
    ],
  };
}

export function buildSpotlightSetModal(
  locale: string,
  nonce: string,
  channelId: string,
  hours: number,
  blockIdx: number,
  fp: string,
  personas: Array<{ id: number; name: string; isAlter: boolean }>,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const components: RawDiscordComponent[] = [];

  const personaGroups = chunkForCheckboxGroups(personas, SPOTLIGHT_PERSONA_PAGE_SIZE / 10);
  for (const [g, chunk] of personaGroups.entries()) {
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
    custom_id: buildPersonalConfigRouteId({
      action: "spotlight-set-submit",
      locale,
      channelId,
      hours,
      blockIdx,
      fp,
      nonce,
    }),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_set_modal_title"), 45),
    components,
  };
}

export function buildSpotlightAutoTriggerModal(
  locale: string,
  nonce: string,
  channelId: string,
  hours: number,
  blockIdx: number,
  mask: string,
  fp: string,
  selectedPersonas: Array<{ id: number; name: string; isAlter: boolean }>,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const options = [
    {
      value: "0",
      label: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_auto_none"), 100),
      default: true,
    },
    ...selectedPersonas.map((p) => ({
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
    custom_id: buildPersonalConfigRouteId({
      action: "spot-set-auto-sub",
      locale,
      channelId,
      hours,
      blockIdx,
      mask,
      fp,
      nonce,
    }),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_auto_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_auto_select_label"), 45),
        description: safeModalLocalizer(locale, "commands.personal.config.spotlight_auto_select_desc"),
        component: {
          type: 3,
          custom_id: buildPersonalConfigModalFieldId("auto_trigger", nonce),
          required: true,
          min_values: 1,
          max_values: 1,
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
  fp: string,
  activeSpotlights: PersonalSpotlightStatus[],
  personas: Array<{ id: number; name: string; isAlter: boolean }>,
  guildChannels: Map<string, { name: string }> | undefined,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const personaMap = new Map(personas.map((p) => [p.id, p.name]));
  const components: RawDiscordComponent[] = [];

  const removalGroups = chunkForCheckboxGroups(activeSpotlights, SPOTLIGHT_REMOVE_PAGE_SIZE / 10);
  for (const [g, chunk] of removalGroups.entries()) {
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
    custom_id: buildPersonalConfigRouteId({
      action: "spotlight-remove-submit",
      locale,
      start,
      fp,
      nonce,
    }),
    title: safeSelectOptionText(localizer(locale, "commands.personal.config.spotlight_remove_modal_title"), 45),
    components,
  };
}
