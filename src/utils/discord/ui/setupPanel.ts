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
  type SetupDraftContext,
  type SetupDraftEndpointConnection,
  type SetupDraftEndpointModel,
  type SetupDraftProviderAccess,
  type SetupDraftRecord,
  type SetupDraftStartingSettings,
  type SetupDraftSystemPrompt,
} from "@/types/discord/setupWizard";
import type { SystemPromptPresetRow, TomoriPresetRow } from "@/types/db/schema";
import {
  buildSetupCancelRouteId,
  buildSetupEndpointConnectionRouteId,
  buildSetupEndpointConnectionSubmitRouteId,
  buildSetupEndpointModelRouteId,
  buildSetupEndpointModelSubmitRouteId,
  buildSetupFinishRouteId,
  buildSetupPoliciesRouteId,
  buildSetupPoliciesSubmitRouteId,
  buildSetupProviderByokSubmitRouteId,
  buildSetupProviderCatalogSubmitRouteId,
  buildSetupProviderModeRouteId,
  buildSetupSettingsRouteId,
  buildSetupSettingsSubmitRouteId,
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
import { truncateDiscordText } from "@/utils/text/discordTextLimits";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import { ColorCode } from "@/utils/misc/logger";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { localizer } from "@/utils/text/localizer";
import { buildLegalDocUrl } from "@/utils/misc/docsUrl";
import type { ComponentsV2MessagePayload } from "@/utils/discord/ui/componentsV2Limits";

export interface SetupWizardPayloadInput {
  draft: SetupDraftRecord;
  locale: string;
  isHosted: boolean;
  nonce: string;
  notice?: string;
  /**
   * The live persona and system-prompt catalogs, read once per repaint so the dashboard reflects a
   * catalog row that has been removed rather than the draft's no-longer-resolvable copy.
   *
   * The three states are distinct and all meaningful. `undefined` means there is nothing stored to
   * resolve. `null` means the read itself failed, which re-pends the step rather than vouching for a
   * selection nothing could confirm. An object is the resolved catalog set.
   */
  settingsCatalogs?: SetupSettingsCatalogs | null;
}

/** Values a Starting Settings editor can offer, derived from the live catalogs on every open. */
export interface SetupSettingsCatalogs {
  personas: Array<{ id: number; name: string; description: string }>;
  prompts: Array<{ name: string; description: string }>;
  /**
   * Preset name to current prompt text, for the final commit only.
   *
   * The editor offers the names and the draft stores an identity, so the text written at commit has
   * to come from the same read that proved the identity still resolves. A preset edited since the
   * save is therefore written in its current form rather than in a copy the draft carried.
   */
  promptTexts: Map<string, string>;
}

/** Discord's maximum option count for a single modal string select. */
const SETUP_MODAL_SELECT_OPTION_LIMIT = 25;

/** Discord's maximum length for one select option's value, which is compared verbatim when read back. */
const SETUP_OPTION_VALUE_LIMIT = 100;

/**
 * Whether both catalogs fit the one select each is rendered into.
 *
 * Discord caps a modal's string select at 25 options and these are single-menu rows rather than the
 * paginated selector, so a catalog past the cap has no renderable form. It fails closed for the
 * whole step rather than truncating: a trimmed list would silently drop the actor's stored choice,
 * and the step is edited in one modal, so one over-cap catalog makes the editor unusable either way.
 */
export function areSetupSettingsCatalogsRenderable(
  catalogs: SetupSettingsCatalogs | null,
): catalogs is SetupSettingsCatalogs {
  if (!catalogs) return false;
  // The prompt select also carries the synthetic built-in default.
  return (
    catalogs.personas.length <= SETUP_MODAL_SELECT_OPTION_LIMIT &&
    catalogs.prompts.length + 1 <= SETUP_MODAL_SELECT_OPTION_LIMIT
  );
}

/** Humanizer degree to its locale key stem, indexed by the stored degree (0 through 3). */
const HUMANIZER_KEYS = ["none", "light", "default", "heavy"] as const;

/**
 * The rows a Starting Settings editor can offer, or null when either catalog could not be read.
 *
 * Both come from the database, so a failed read and an empty catalog are indistinguishable here and
 * both fail closed: the editor refuses rather than silently offering a subset of the presets.
 */
export function toSetupSettingsCatalogs(
  personaPresets: readonly TomoriPresetRow[] | null,
  promptPresets: readonly SystemPromptPresetRow[] | null,
  locale: string,
): SetupSettingsCatalogs | null {
  if (!personaPresets || !promptPresets) return null;
  // Option values are compared verbatim against the stored identity, and Discord caps one option's
  // value length, so a name at the cap would store a value that can never resolve back.
  if (personaPresets.some((preset) => preset.persona_preset_name.length > SETUP_OPTION_VALUE_LIMIT)) return null;
  if (promptPresets.some((preset) => preset.system_prompt_preset_name.length > SETUP_OPTION_VALUE_LIMIT)) return null;

  return {
    personas: personaPresets.map((preset) => ({
      id: preset.persona_preset_id,
      name: preset.persona_preset_name,
      description: preset.persona_preset_desc,
    })),
    prompts: promptPresets.map((preset) => ({
      name: preset.system_prompt_preset_name,
      description: locale === "ja" && preset.ja_description ? preset.ja_description : preset.system_prompt_preset_desc,
    })),
    promptTexts: new Map(promptPresets.map((preset) => [preset.system_prompt_preset_name, preset.preset_prompt_text])),
  };
}

/**
 * Whether the draft's stored persona and prompt identities still exist in the live catalogs.
 *
 * Both are checked together because the step is one unit: a removed row re-pends the whole step
 * while the actor's other stored values stay in the draft for the next save.
 */
export function isSetupStartingSettingsResolvable(
  settings: SetupDraftStartingSettings,
  catalogs: SetupSettingsCatalogs,
): boolean {
  const { systemPrompt } = settings;
  if (!catalogs.personas.some((persona) => persona.id === settings.presetId)) return false;
  if (systemPrompt.kind === "built-in") return true;
  return catalogs.prompts.some((prompt) => prompt.name === systemPrompt.presetName);
}

/**
 * Longest stored name a wizard summary repeats before it is shortened for display.
 *
 * The template around the name is the widest part of the line, and `> System prompt: ` spends 17 of
 * the 65-character panel budget, so a name longer than this pushes the quote row past the column the
 * container is drawn at. Shortening here is display-only: the draft keeps the full value, and every
 * editor reopens pre-filled with it.
 */
const SETUP_SUMMARY_VALUE_MAX = 40;

/**
 * Shortens a stored value this panel only names, so a composed line stays inside the column.
 *
 * Endpoint labels, custom model codes, and catalog preset names are stored at lengths that would push
 * a quote row past the 65-character panel budget, and a Components V2 container draws a longer run of
 * unbroken text wider than the column it sits in. Truncation here is display-only: the stored value is
 * untouched, it stays editable in the editors that own it, and every editor reopens carrying it.
 */
function truncatePanelValue(value: string, maxLength: number): string {
  return truncateDiscordText(value, maxLength);
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
    return withLinePrefix(
      "> ",
      localizer(locale, "commands.setup.wizard.provider_custom_summary", {
        label: truncatePanelValue(access.connection.label, SETUP_SUMMARY_VALUE_MAX),
        model: truncatePanelValue(access.textModel.modelCode, SETUP_SUMMARY_VALUE_MAX),
      }),
    );
  }

  return `> ${localizer(locale, "commands.setup.wizard.provider_custom_pending")}`;
}

function resolveHumanizerLabel(humanizer: number, locale: string): string {
  return localizer(locale, `commands.setup.humanizer_option_${HUMANIZER_KEYS[humanizer] ?? "default"}_label`);
}

/**
 * The stored timezone as the dashboard shows it, spelled out so a UTC offset never reads as an
 * unfinished field.
 *
 * This is a display form and must not be fed back into {@link parseSetupTimezoneOffset}: the `UTC`
 * prefix is prose, and the modal's re-parse of a pre-filled value rejects it. The editor pre-fills
 * with {@link formatTimezoneOffsetInput} for that reason.
 */
function formatTimezoneOffsetDisplay(timezoneOffset: number): string {
  return timezoneOffset >= 0 ? `UTC+${timezoneOffset}` : `UTC${timezoneOffset}`;
}

/** The stored timezone as the editor's own input value, so reopening a saved step parses cleanly. */
function formatTimezoneOffsetInput(timezoneOffset: number): string {
  return String(timezoneOffset);
}

function resolveSettingsSummary(
  settings: SetupDraftStartingSettings,
  locale: string,
  catalogs: SetupSettingsCatalogs | null,
): string {
  // A read that failed is not the same claim as a catalog that resolved without the row, so the two
  // get different wording: the first says the value could not be checked, the second says it is gone.
  const unresolvedKey = catalogs === null ? "settings_catalog_unavailable" : "settings_persona_unknown";
  const unresolvedPromptKey = catalogs === null ? "settings_catalog_unavailable" : "settings_prompt_unknown";

  const personaName =
    catalogs?.personas.find((persona) => persona.id === settings.presetId)?.name ??
    localizer(locale, `commands.setup.wizard.${unresolvedKey}`);
  const { systemPrompt } = settings;
  const promptName =
    systemPrompt.kind === "built-in"
      ? localizer(locale, "commands.setup.wizard.settings_built_in_prompt_summary")
      : (catalogs?.prompts.find((prompt) => prompt.name === systemPrompt.presetName)?.name ??
        localizer(locale, `commands.setup.wizard.${unresolvedPromptKey}`));

  return [
    localizer(locale, "commands.setup.wizard.settings_summary_persona", {
      persona: truncatePanelValue(personaName, SETUP_SUMMARY_VALUE_MAX),
    }),
    localizer(locale, "commands.setup.wizard.settings_summary_reply_style", {
      style: resolveHumanizerLabel(settings.humanizer, locale),
    }),
    localizer(locale, "commands.setup.wizard.settings_summary_timezone", {
      tz: formatTimezoneOffsetDisplay(settings.timezoneOffset),
    }),
    localizer(locale, "commands.setup.wizard.settings_summary_system_prompt", {
      prompt: truncatePanelValue(promptName, SETUP_SUMMARY_VALUE_MAX),
    }),
  ]
    .map((row) => `> ${row}`)
    .join("\n");
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

  const providerComplete = isSetupDraftProviderAccessComplete(draft.providerAccess);
  // The stored identities are resolved against the live catalogs, so a persona or prompt row removed
  // since the save re-pends the step here rather than only at the final commit. A catalog read that
  // failed re-pends it too: the alternative is claiming a selection is complete when nothing could
  // confirm it, and the two loaders return the same null for "no rows" and "query blew up".
  const settingsComplete =
    draft.startingSettings !== null &&
    input.settingsCatalogs != null &&
    isSetupStartingSettingsResolvable(draft.startingSettings, input.settingsCatalogs);
  const policiesComplete = draft.policiesAccepted;

  // The catalog-aware verdict governs the whole ready state, not only the step rows. Gating the
  // finish action on the catalog-blind draft predicate instead would leave it enabled and Primary
  // beside a step the same panel had just re-pended.
  const isComplete = isSetupDraftComplete(draft) && settingsComplete;

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
          label: truncatePanelValue(access.connection.label, SETUP_SUMMARY_VALUE_MAX),
        })
      : localizer(locale, "commands.setup.wizard.custom_endpoint_connection_pending");
    const modelLine = access.textModel
      ? localizer(locale, "commands.setup.wizard.custom_endpoint_model_configured", {
          model: truncatePanelValue(access.textModel.modelCode, SETUP_SUMMARY_VALUE_MAX),
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
  const settingsSummary = draft.startingSettings
    ? resolveSettingsSummary(draft.startingSettings, locale, input.settingsCatalogs ?? null)
    : `> ${localizer(locale, "commands.setup.wizard.settings_pending")}`;
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

/**
 * Terminal replacement for a workspace whose commit transaction failed.
 *
 * It reads as a refusal rather than a receipt: the draft is consumed at this point, so the actor
 * has to run `/setup` again and the copy has to say that instead of implying a setup that never
 * reached the database.
 */
export function buildSetupCommitFailedPayload(
  locale: string,
): ComponentsV2MessagePayload & { attachments: readonly [] } {
  return validateAndFallbackPanelPayload(
    {
      components: buildNoticeContainer({
        locale,
        color: ColorCode.ERROR,
        titleKey: "commands.setup.wizard.commit_failed_title",
        descriptionKey: "commands.setup.wizard.commit_failed_description",
      }),
      attachments: [],
      flags: MessageFlags.IsComponentsV2,
    },
    locale,
  );
}

/**
 * Answer for a control pressed while this draft is being committed.
 *
 * It is not the expired state: the draft still exists and the commit in progress is about to replace
 * this message, so the copy tells the actor to wait rather than to start over.
 */
export function buildSetupInFlightPayload(locale: string): ComponentsV2MessagePayload & { attachments: readonly [] } {
  return validateAndFallbackPanelPayload(
    {
      components: buildNoticeContainer({
        locale,
        color: ColorCode.INFO,
        titleKey: "commands.setup.wizard.commit_in_progress_title",
        descriptionKey: "commands.setup.wizard.commit_in_progress",
      }),
      attachments: [],
      flags: MessageFlags.IsComponentsV2,
    },
    locale,
  );
}

/** One conditional `A Few Things to Note` entry: a bold label line over an indented detail line. */
interface SetupReceiptNote {
  label: string;
  detail: string;
}

interface SetupReceiptInput {
  locale: string;
  /** Guild or DM workspace, which selects the DM-specific copy variants. */
  context: SetupDraftContext;
  providerAccess: SetupDraftProviderAccess;
  /** The resolved default model codename for a catalog provider, or the custom model code. */
  modelName: string | null;
  /** Provider display name for a catalog provider, endpoint label for a custom endpoint. */
  providerLabel: string;
  personaName: string;
  notes: readonly SetupReceiptNote[];
  /** Pre-composed body for the Learn More field, built by the caller from its live command mentions. */
  learnMore: string;
  /** Footer locale key for the skipped or failed avatar update, when one applies. */
  footerKey?: string;
}

function resolveReceiptDescriptionKey(input: SetupReceiptInput): string {
  const isDm = input.context === "dm";
  const { providerAccess } = input;

  if (providerAccess.mode === "user-byok") {
    return isDm ? "commands.setup.wizard.receipt_desc_byok_dm" : "commands.setup.wizard.receipt_desc_byok";
  }
  if (providerAccess.mode === "custom-endpoint") {
    return isDm
      ? "commands.setup.wizard.receipt_desc_custom_endpoint_dm"
      : "commands.setup.wizard.receipt_desc_custom_endpoint";
  }
  if (!input.modelName) {
    return isDm ? "commands.setup.wizard.receipt_desc_dm" : "commands.setup.wizard.receipt_desc";
  }
  return isDm ? "commands.setup.wizard.receipt_desc_dm_with_model" : "commands.setup.wizard.receipt_desc_with_model";
}

/**
 * The terminal success receipt, rendered as Components V2 text displays onto the wizard's own
 * message.
 *
 * The wizard anchor is a V2 message and Discord never lets one carry legacy embeds afterwards, so
 * the receipt is the same flattening the shared legacy sinks already apply to a marked interaction
 * rather than a freshly posted embed.
 */
export function buildSetupSuccessPayload(
  input: SetupReceiptInput,
): ComponentsV2MessagePayload & { attachments: readonly [] } {
  const { locale } = input;
  const components: ComponentInContainerData[] = [];

  components.push({
    type: ComponentType.TextDisplay,
    content: `### ${localizer(locale, "commands.setup.wizard.receipt_title")}`,
  });

  components.push({
    type: ComponentType.TextDisplay,
    content: localizer(locale, resolveReceiptDescriptionKey(input), {
      model_name: truncatePanelValue(input.modelName ?? "", 30),
      provider: truncatePanelValue(input.providerLabel, 28),
      endpoint: truncatePanelValue(input.providerLabel, 28),
      persona: truncatePanelValue(input.personaName, 25),
    }),
  });

  if (input.context === "dm") {
    components.push({
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.setup.dm_context_explanation_title")}**\n${localizer(locale, "commands.setup.dm_context_explanation")}`,
    });
  }

  components.push({
    type: ComponentType.TextDisplay,
    content: `**${localizer(locale, "commands.setup.next_steps_title")}**\n${localizer(
      locale,
      input.context === "dm"
        ? "commands.setup.wizard.receipt_next_steps_dm"
        : "commands.setup.wizard.receipt_next_steps",
    )}`,
  });

  components.push({
    type: ComponentType.TextDisplay,
    content: `**${localizer(locale, "commands.setup.learn_more_title")}**\n${input.learnMore}`,
  });

  if (input.notes.length > 0) {
    components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
    components.push({
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.setup.heads_up_title")}**\n${input.notes
        .map((note) => `- **${note.label}**\n  - ${note.detail}`)
        .join("\n")}`,
    });
  }

  if (input.footerKey) {
    components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, input.footerKey)),
    });
  }

  return validateAndFallbackPanelPayload(
    {
      components: [buildPanelContainer(components)],
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
        // 18 is Label, and it is the only path by which a routed modal value is recorded: the
        // type-18 walk in interactionCore is what reads a submission back, so the same group at
        // the modal root would render, submit, and read back as no selection at all.
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.byok_confirm_label"), 45),
        component: {
          // 21 is RadioGroup, whose submitted value lands in the modal select-value store.
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
      },
    ],
  };
}

export type SetupSettingsModalField = "persona" | "humanizer" | "timezone" | "system-prompt";

export function buildSetupSettingsModalFieldId(field: SetupSettingsModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

/**
 * The sentinel a stored system prompt carries when the actor chose the built-in default.
 *
 * It is a draft identity, never catalog text: the final commit re-resolves it so a preset edited
 * after the save is written in its current form, and the built-in default writes NULL. A catalog row
 * named exactly this string would be offered twice and always read back as the built-in default,
 * which is a catalog-naming accident rather than a state two edits can reach.
 */
export const SETUP_SYSTEM_PROMPT_BUILT_IN = "built-in-default";

export function parseSetupSystemPromptChoice(value: string | undefined): SetupDraftSystemPrompt | null {
  if (!value) return null;
  if (value === SETUP_SYSTEM_PROMPT_BUILT_IN) return { kind: "built-in" };
  return { kind: "preset", presetName: value };
}

/**
 * The chosen humanizer degree, or null when the submission carried no usable option.
 *
 * The value round-trips as a string, so parsing is strict: an off-enum number would otherwise reach
 * the repository as a degree the reply pipeline does not implement.
 */
export function parseSetupHumanizerChoice(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= HUMANIZER_KEYS.length) return null;
  return parsed;
}

/** The submitted timezone, blank meaning UTC, or null when it is not a usable offset. */
export function parseSetupTimezoneOffset(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return 0;

  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed) || parsed < -12 || parsed > 14) return null;
  return Math.round(parsed);
}

export function buildSetupSettingsModal(
  locale: string,
  nonce: string,
  catalogs: SetupSettingsCatalogs,
  existing?: SetupDraftStartingSettings | null,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const humanizerOptions = HUMANIZER_KEYS.map((key, index) => ({
    label: safeSelectOptionText(localizer(locale, `commands.setup.humanizer_option_${key}_label`), 100),
    value: String(index),
    description: safeSelectOptionText(localizer(locale, `commands.setup.humanizer_option_${key}_desc`), 100),
    default: existing?.humanizer === index,
  }));

  // The plan's contract for this modal is that its selects reopen on their placeholders, so the
  // `default` flags below are a best-effort hint the client is free to ignore rather than a
  // pre-fill. Only the text input is expected to come back carrying its stored value.
  const timezoneValue = existing ? formatTimezoneOffsetInput(existing.timezoneOffset) : undefined;
  const storedPrompt = existing?.systemPrompt;

  return {
    custom_id: buildSetupSettingsSubmitRouteId({ locale, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.setup.wizard.settings_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.settings_persona_label"), 45),
        component: {
          type: 3,
          custom_id: buildSetupSettingsModalFieldId("persona", nonce),
          required: true,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.setup.wizard.settings_persona_placeholder"),
            100,
          ),
          options: catalogs.personas.map((persona) => ({
            label: safeSelectOptionText(persona.name, 100),
            value: String(persona.id),
            description: safeSelectOptionText(persona.description, 100),
            default: existing?.presetId === persona.id,
          })),
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.settings_humanizer_label"), 45),
        component: {
          type: 3,
          custom_id: buildSetupSettingsModalFieldId("humanizer", nonce),
          required: true,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.setup.wizard.settings_humanizer_placeholder"),
            100,
          ),
          options: humanizerOptions,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.settings_timezone_label"), 45),
        component: {
          type: 4,
          custom_id: buildSetupSettingsModalFieldId("timezone", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.setup.wizard.settings_timezone_placeholder"),
            100,
          ),
          max_length: 20,
          required: false,
          value: timezoneValue,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.settings_system_prompt_label"), 45),
        component: {
          // The built-in default is not a catalog row, so it is offered as a synthetic first option
          // and stored as a sentinel rather than as a copy of the read-time default text.
          type: 3,
          custom_id: buildSetupSettingsModalFieldId("system-prompt", nonce),
          required: true,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.setup.wizard.settings_system_prompt_placeholder"),
            100,
          ),
          options: [
            {
              label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.settings_built_in_prompt"), 100),
              value: SETUP_SYSTEM_PROMPT_BUILT_IN,
              default: storedPrompt?.kind === "built-in",
            },
            ...catalogs.prompts.map((prompt) => ({
              label: safeSelectOptionText(prompt.name, 100),
              value: safeSelectOptionText(prompt.name, 100),
              description: safeSelectOptionText(prompt.description, 100),
              default: storedPrompt?.kind === "preset" && storedPrompt.presetName === prompt.name,
            })),
          ],
        },
      },
    ],
  };
}

export type SetupPoliciesModalField = "acceptance";

export const SETUP_POLICY_CHOICE_VALUES = ["tos", "privacy"] as const;

export function buildSetupPoliciesModalFieldId(field: SetupPoliciesModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildSetupPoliciesModal(
  locale: string,
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const acceptance = localizer(locale, "commands.setup.wizard.policies_modal_acceptance", {
    terms_url: buildLegalDocUrl(locale, "terms-of-service"),
    privacy_url: buildLegalDocUrl(locale, "privacy-policy"),
  });

  return {
    custom_id: buildSetupPoliciesSubmitRouteId({ locale, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.setup.wizard.policies_modal_title"), 45),
    components: [
      {
        type: 10,
        content: `${localizer(locale, "commands.setup.wizard.policies_modal_context")}\n\n${acceptance}`,
      },
      {
        // 18 is Label. The group sits inside it rather than at the modal root because the type-18
        // walk in interactionCore is what records a checkbox submission, so a root-level group
        // would render and then read back as no selection at all.
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.policies_modal_choice_label"), 45),
        component: {
          // 22 is CheckboxGroup.
          type: 22,
          custom_id: buildSetupPoliciesModalFieldId("acceptance", nonce),
          min_values: SETUP_POLICY_CHOICE_VALUES.length,
          max_values: SETUP_POLICY_CHOICE_VALUES.length,
          required: true,
          options: [
            {
              label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.policies_choice_terms"), 100),
              value: "tos",
            },
            {
              label: safeSelectOptionText(localizer(locale, "commands.setup.wizard.policies_choice_privacy"), 100),
              value: "privacy",
            },
          ],
        },
      },
    ],
  };
}
