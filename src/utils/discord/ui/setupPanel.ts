import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ComponentInContainerData,
  type SelectMenuComponentOptionData,
} from "discord.js";
import {
  isSetupDraftComplete,
  isSetupDraftProviderAccessComplete,
  type SetupDraftRecord,
} from "@/types/discord/setupWizard";
import {
  buildSetupCancelRouteId,
  buildSetupFinishRouteId,
  buildSetupPoliciesRouteId,
  buildSetupProviderModeRouteId,
  buildSetupSettingsRouteId,
} from "@/utils/discord/interactions/setupRoutes";
import { buildNoticeContainer, validateAndFallbackPanelPayload } from "@/utils/discord/ui/interactionCore";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";
import { ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import type { ComponentsV2MessagePayload } from "@/utils/discord/ui/componentsV2Limits";

export interface SetupWizardPayloadInput {
  draft: SetupDraftRecord;
  locale: string;
  isHosted: boolean;
  nonce: string;
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
  const { draft, locale, isHosted, nonce } = input;

  const components: ComponentInContainerData[] = [];
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
  components.push({
    type: ComponentType.TextDisplay,
    content: `${providerStatus} **${localizer(locale, "commands.setup.wizard.provider_name")}**\n${localizer(locale, "commands.setup.wizard.provider_description")}\n${providerSummary}\n-# ${localizer(locale, "commands.setup.wizard.provider_hint")}`,
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
