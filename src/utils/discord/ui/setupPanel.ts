import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  TextInputStyle,
  type ComponentInContainerData,
  type SelectMenuComponentOptionData,
} from "discord.js";
import {
  isSetupDraftComplete,
  isSetupDraftProviderAccessComplete,
  type SetupDraftEndpointConnection,
  type SetupDraftEndpointModel,
  type SetupDraftRecord,
} from "@/types/discord/setupWizard";
import {
  buildSetupCancelRouteId,
  buildSetupEndpointConnectionRouteId,
  buildSetupEndpointConnectionSubmitRouteId,
  buildSetupEndpointModelRouteId,
  buildSetupEndpointModelSubmitRouteId,
  buildSetupFinishRouteId,
  buildSetupPoliciesRouteId,
  buildSetupProviderByokSubmitRouteId,
  buildSetupProviderCatalogSubmitRouteId,
  buildSetupProviderModeRouteId,
  buildSetupSettingsRouteId,
} from "@/utils/discord/interactions/setupRoutes";
import type { CustomEndpointApiStyle, SetupCustomEndpointCapability } from "@/types/db/schema";
import { buildNoticeContainer, validateAndFallbackPanelPayload } from "@/utils/discord/ui/interactionCore";
import { buildPanelContainer, withLinePrefix } from "@/utils/discord/ui/panel";
import {
  getAllProviderChoices,
  getProviderAddChoiceDescriptionKey,
  getProviderDisplayName,
} from "@/utils/provider/providerInfoRegistry";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import { ColorCode } from "@/utils/misc/logger";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { localizer } from "@/utils/text/localizer";
import type { ComponentsV2MessagePayload } from "@/utils/discord/ui/componentsV2Limits";

export interface SetupWizardPayloadInput {
  draft: SetupDraftRecord;
  locale: string;
  isHosted: boolean;
  nonce: string;
  notice?: string;
}

function resolveProviderSummary(draft: SetupDraftRecord, locale: string): string {
  const access = draft.providerAccess;
  if (!access) {
    return `> ${localizer(locale, "commands.setup.wizard.provider_pending")}`;
  }

  if (access.mode === "catalog") {
    const displayName = getProviderDisplayName(access.provider);
    return `> ${displayName}\n> ${localizer(locale, "commands.setup.wizard.provider_catalog_encrypted")}`;
  }

  if (access.mode === "user-byok") {
    return `> ${localizer(locale, "commands.setup.wizard.provider_byok_summary")}`;
  }

  if (access.connection && access.textModel) {
    return `> ${access.connection.label}\n> Model: ${access.textModel.modelCode}`;
  }

  return `> ${localizer(locale, "commands.setup.wizard.provider_custom_pending")}`;
}

function resolveSettingsSummary(draft: SetupDraftRecord, locale: string): string {
  const settings = draft.startingSettings;
  if (!settings) {
    return `> ${localizer(locale, "commands.setup.wizard.settings_pending")}`;
  }

  const presetName = settings.systemPrompt.kind === "preset" ? settings.systemPrompt.presetName : "Built-in";
  const tzFormatted = settings.timezoneOffset >= 0 ? `+${settings.timezoneOffset}` : String(settings.timezoneOffset);

  const line1 = localizer(locale, "commands.setup.wizard.settings_summary_preset", {
    preset: presetName,
  });
  const line2 = localizer(locale, "commands.setup.wizard.settings_summary_details", {
    humanizer: settings.humanizer,
    tz: tzFormatted,
  });

  return `> ${line1}\n> ${line2}`;
}

export function buildSetupWizardPayload(
  input: SetupWizardPayloadInput,
): ComponentsV2MessagePayload & { attachments: readonly [] } {
  const { draft, locale, isHosted, nonce, notice } = input;

  const components: ComponentInContainerData[] = [];
  if (notice) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", notice),
    });
  }

  const isComplete = isSetupDraftComplete(draft);

  const providerComplete = isSetupDraftProviderAccessComplete(draft.providerAccess);
  const settingsComplete = draft.startingSettings !== null;
  const policiesComplete = draft.policiesAccepted;

  const total = isHosted ? 3 : 2;
  const done = (isHosted && policiesComplete ? 1 : 0) + (providerComplete ? 1 : 0) + (settingsComplete ? 1 : 0);

  components.push({
    type: ComponentType.TextDisplay,
    content: isComplete
      ? `### ${localizer(locale, "commands.setup.wizard.title")}\n${localizer(locale, "commands.setup.wizard.intro_ready")}\n${localizer(locale, "commands.setup.wizard.progress", { done, total })}`
      : `### ${localizer(locale, "commands.setup.wizard.title")}\n${localizer(locale, "commands.setup.wizard.intro")}\n${localizer(locale, "commands.setup.wizard.progress", { done, total })}`,
  });

  if (isHosted) {
    const policiesStatus = policiesComplete ? "✓" : "○";
    const policiesQuote = policiesComplete
      ? localizer(locale, "commands.setup.wizard.policies_completed")
      : localizer(locale, "commands.setup.wizard.policies_pending");
    const policiesButtonLabel = localizer(
      locale,
      policiesComplete ? "commands.setup.wizard.policies_button_edit" : "commands.setup.wizard.policies_button_start",
    );

    components.push({
      type: ComponentType.TextDisplay,
      content: `${policiesStatus} **${localizer(locale, "commands.setup.wizard.policies_name")}**\n${localizer(locale, "commands.setup.wizard.policies_description")}\n> ${policiesQuote}`,
    });

    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildSetupPoliciesRouteId({ locale, nonce }),
          label: policiesButtonLabel,
          disabled: false,
        },
      ],
    });
  }

  const providerStatus = providerComplete ? "✓" : "○";
  const providerSummary = resolveProviderSummary(draft, locale);
  const providerHint = localizer(locale, "commands.setup.wizard.provider_hint", {
    help: commandRegistry.getCommandMention("help"),
  });
  components.push({
    type: ComponentType.TextDisplay,
    content: `${providerStatus} **${localizer(locale, "commands.setup.wizard.provider_name")}**\n${localizer(locale, "commands.setup.wizard.provider_description")}\n${providerSummary}\n-# ${providerHint}`,
  });

  const providerOptions: SelectMenuComponentOptionData[] = [
    {
      label: localizer(locale, "commands.setup.wizard.provider_option_catalog"),
      value: "catalog",
      default: draft.providerAccess?.mode === "catalog",
    },
    {
      label: localizer(locale, "commands.setup.wizard.provider_option_custom"),
      value: "custom-endpoint",
      default: draft.providerAccess?.mode === "custom-endpoint",
    },
  ];

  if (draft.context !== "dm") {
    providerOptions.push({
      label: localizer(locale, "commands.setup.wizard.provider_option_byok"),
      value: "user-byok",
      default: draft.providerAccess?.mode === "user-byok",
    });
  }

  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildSetupProviderModeRouteId({ locale, nonce }),
        placeholder: localizer(locale, "commands.setup.wizard.provider_select_placeholder"),
        minValues: 1,
        maxValues: 1,
        options: providerOptions,
      },
    ],
  });

  if (draft.providerAccess?.mode === "custom-endpoint") {
    const access = draft.providerAccess;
    const connectionLine = access.connection
      ? localizer(locale, "commands.setup.wizard.custom_endpoint_connection_configured", {
          label: access.connection.label,
        })
      : localizer(locale, "commands.setup.wizard.custom_endpoint_connection_pending");
    const modelLine = access.textModel
      ? localizer(locale, "commands.setup.wizard.custom_endpoint_model_configured", {
          model: access.textModel.modelCode,
        })
      : localizer(locale, "commands.setup.wizard.custom_endpoint_model_pending");

    components.push({
      type: ComponentType.TextDisplay,
      content: `-# ${localizer(locale, "commands.setup.wizard.custom_endpoint_hint")}\n> ${connectionLine}\n> ${modelLine}`,
    });

    const connectionButtonLabel = localizer(
      locale,
      access.connection
        ? "commands.setup.wizard.custom_endpoint_button_connection_edit"
        : "commands.setup.wizard.custom_endpoint_button_connection_start",
    );
    const modelButtonLabel = localizer(
      locale,
      access.textModel
        ? "commands.setup.wizard.custom_endpoint_button_model_edit"
        : "commands.setup.wizard.custom_endpoint_button_model_start",
    );

    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          customId: buildSetupEndpointConnectionRouteId({ locale, nonce }),
          label: connectionButtonLabel,
          style: ButtonStyle.Secondary,
        },
        {
          type: ComponentType.Button,
          customId: buildSetupEndpointModelRouteId({ locale, nonce }),
          label: modelButtonLabel,
          style: ButtonStyle.Secondary,
          disabled: !access.connection,
        },
      ],
    });
  }

  const settingsStatus = settingsComplete ? "✓" : "○";
  const settingsSummary = resolveSettingsSummary(draft, locale);
  const settingsButtonLabel = localizer(
    locale,
    settingsComplete ? "commands.setup.wizard.settings_button_edit" : "commands.setup.wizard.settings_button_start",
  );

  components.push({
    type: ComponentType.TextDisplay,
    content: `${settingsStatus} **${localizer(locale, "commands.setup.wizard.settings_name")}**\n${localizer(locale, "commands.setup.wizard.settings_description")}\n${settingsSummary}`,
  });

  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildSetupSettingsRouteId({ locale, nonce }),
        label: settingsButtonLabel,
        disabled: false,
      },
    ],
  });

  components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: isComplete ? ButtonStyle.Primary : ButtonStyle.Secondary,
        customId: buildSetupFinishRouteId({ locale, nonce }),
        label: localizer(locale, "commands.setup.wizard.finish_label"),
        disabled: !isComplete,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildSetupCancelRouteId({ locale, nonce }),
        label: localizer(locale, "commands.setup.wizard.cancel_label"),
        disabled: false,
      },
    ],
  });

  return validateAndFallbackPanelPayload(
    {
      components: [buildPanelContainer(components)],
      attachments: [],
      flags: MessageFlags.IsComponentsV2,
    },
    locale,
  );
}

export function buildSetupCancelledPayload(locale: string): ComponentsV2MessagePayload & { attachments: readonly [] } {
  return validateAndFallbackPanelPayload(
    {
      components: buildNoticeContainer({
        locale,
        color: ColorCode.INFO,
        titleKey: "commands.setup.wizard.cancelled_title",
        descriptionKey: "commands.setup.wizard.cancelled_description",
      }),
      attachments: [],
      flags: MessageFlags.IsComponentsV2,
    },
    locale,
  );
}

export function buildSetupExpiredPayload(locale: string): ComponentsV2MessagePayload & { attachments: readonly [] } {
  return validateAndFallbackPanelPayload(
    {
      components: buildNoticeContainer({
        locale,
        color: ColorCode.WARN,
        titleKey: "commands.setup.wizard.expired_title",
        descriptionKey: "commands.setup.wizard.expired_description",
      }),
      attachments: [],
      flags: MessageFlags.IsComponentsV2,
    },
    locale,
  );
}

export type SetupCatalogModalField = "provider" | "api-key";

export function buildSetupCatalogModalFieldId(field: SetupCatalogModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

export function getSetupCatalogProviderChoices(): Array<{ name: string; value: string }> {
  return getAllProviderChoices().filter((provider) => provider.value !== "custom");
}

export function buildSetupCatalogModal(
  locale: string,
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const curatedOptions = getSetupCatalogProviderChoices().map((provider) => {
    const descriptionKey = getProviderAddChoiceDescriptionKey(provider.value);
    return {
      label: safeSelectOptionText(provider.name, 100),
      value: provider.value,
      description: descriptionKey ? safeSelectOptionText(localizer(locale, descriptionKey), 100) : undefined,
    };
  });

  return {
    custom_id: buildSetupProviderCatalogSubmitRouteId({ locale, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.setup.wizard.catalog_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.catalog_provider_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.setup.wizard.catalog_provider_description"), 100),
        component: {
          type: 3,
          custom_id: buildSetupCatalogModalFieldId("provider", nonce),
          required: true,
          options: curatedOptions,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.catalog_api_key_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.setup.wizard.catalog_api_key_description"), 100),
        component: {
          type: 4,
          custom_id: buildSetupCatalogModalFieldId("api-key", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.setup.wizard.catalog_api_key_placeholder"),
            100,
          ),
          min_length: 10,
          max_length: 500,
          required: true,
        },
      },
    ],
  };
}

export const SETUP_ENDPOINT_API_STYLES = [
  "openai-compatible",
  "ollama-native",
] as const satisfies readonly CustomEndpointApiStyle[];

export type SetupEndpointConnectionModalField = "api-style" | "label" | "url" | "auth-token";

export function buildSetupEndpointConnectionModalFieldId(
  field: SetupEndpointConnectionModalField,
  nonce: string,
): string {
  return `${field}_${nonce}`;
}

export function buildSetupEndpointConnectionModal(
  locale: string,
  nonce: string,
  existing?: SetupDraftEndpointConnection | null,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildSetupEndpointConnectionSubmitRouteId({ locale, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.setup.wizard.custom_endpoint_connection_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.custom_endpoint_api_style_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.setup.wizard.custom_endpoint_api_style_description"),
          100,
        ),
        component: {
          type: 3,
          custom_id: buildSetupEndpointConnectionModalFieldId("api-style", nonce),
          required: true,
          options: SETUP_ENDPOINT_API_STYLES.map((style) => ({
            label: safeSelectOptionText(
              localizer(
                locale,
                `commands.setup.wizard.custom_endpoint_style_${style === "openai-compatible" ? "openai" : "ollama"}`,
              ),
              100,
            ),
            value: style,
            description: safeSelectOptionText(
              localizer(
                locale,
                `commands.setup.wizard.custom_endpoint_style_${style === "openai-compatible" ? "openai" : "ollama"}_desc`,
              ),
              100,
            ),
            default: existing?.apiStyle === style,
          })),
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.custom_endpoint_label_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.setup.wizard.custom_endpoint_label_description"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildSetupEndpointConnectionModalFieldId("label", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.setup.wizard.custom_endpoint_label_placeholder"),
            100,
          ),
          max_length: 40,
          required: true,
          value: existing?.label,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.custom_endpoint_url_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.setup.wizard.custom_endpoint_url_description"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildSetupEndpointConnectionModalFieldId("url", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.setup.wizard.custom_endpoint_url_placeholder"),
            100,
          ),
          max_length: 500,
          required: true,
          value: existing?.endpointUrl,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.custom_endpoint_auth_token_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.setup.wizard.custom_endpoint_auth_token_description"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildSetupEndpointConnectionModalFieldId("auth-token", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.setup.wizard.custom_endpoint_auth_token_placeholder"),
            100,
          ),
          max_length: 500,
          required: false,
        },
      },
    ],
  };
}

export const SETUP_ENDPOINT_TEXT_CAPABILITIES = [
  "tools",
  "vision",
  "structured_output",
  "json",
  "strict_role_alternation",
  "prefix_completion",
] as const satisfies readonly SetupCustomEndpointCapability[];

export type SetupEndpointModelModalField = "model-code" | "num-ctx" | "capabilities";

export function buildSetupEndpointModelModalFieldId(field: SetupEndpointModelModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildSetupEndpointModelModal(
  locale: string,
  nonce: string,
  existing?: SetupDraftEndpointModel | null,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildSetupEndpointModelSubmitRouteId({ locale, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.setup.wizard.custom_endpoint_model_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.custom_endpoint_model_code_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.setup.wizard.custom_endpoint_model_code_description"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildSetupEndpointModelModalFieldId("model-code", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.setup.wizard.custom_endpoint_model_code_placeholder"),
            100,
          ),
          max_length: 200,
          required: true,
          value: existing?.modelCode,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.custom_endpoint_num_ctx_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.setup.wizard.custom_endpoint_num_ctx_description"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildSetupEndpointModelModalFieldId("num-ctx", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.setup.wizard.custom_endpoint_num_ctx_placeholder"),
            100,
          ),
          max_length: 20,
          required: false,
          value: existing?.numCtx != null ? String(existing.numCtx) : undefined,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.custom_endpoint_capabilities_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.setup.wizard.custom_endpoint_capabilities_description"),
          100,
        ),
        component: {
          type: 22,
          custom_id: buildSetupEndpointModelModalFieldId("capabilities", nonce),
          min_values: 0,
          max_values: SETUP_ENDPOINT_TEXT_CAPABILITIES.length,
          required: false,
          options: SETUP_ENDPOINT_TEXT_CAPABILITIES.map((cap) => ({
            value: cap,
            label: safeSelectOptionText(localizer(locale, `commands.setup.wizard.custom_endpoint_cap_${cap}`), 100),
            description: safeSelectOptionText(
              localizer(locale, `commands.setup.wizard.custom_endpoint_cap_${cap}_desc`),
              100,
            ),
            default: existing?.capabilities.includes(cap) ?? false,
          })),
        },
      },
    ],
  };
}

export type SetupByokModalField = "confirm";

export function buildSetupByokModalFieldId(field: SetupByokModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildSetupByokModal(
  locale: string,
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildSetupProviderByokSubmitRouteId({ locale, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.setup.wizard.byok_modal_title"), 45),
    components: [
      {
        type: 10,
        content: localizer(locale, "commands.setup.wizard.byok_modal_notice", {
          command: commandRegistry.getCommandMention("personal", "providers"),
        }),
      },
      {
        type: 21,
        custom_id: buildSetupByokModalFieldId("confirm", nonce),
        required: true,
        min_values: 1,
        max_values: 1,
        options: [
          {
            label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.byok_confirm_yes"), 100),
            value: "yes",
          },
          {
            label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.byok_confirm_no"), 100),
            value: "no",
          },
        ],
      },
    ],
  };
}
