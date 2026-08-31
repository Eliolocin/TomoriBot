import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type SelectMenuComponentOptionData,
  type StringSelectMenuComponentData,
  type TextDisplayComponentData,
  type TopLevelComponentData,
} from "discord.js";
import { PrivacyLevel, type UserRow, type TomoriState, type UserSavedProviderConfigRow } from "@/types/db/schema";
import type { PersonalSpotlightStatus } from "@/utils/db/repositories/UserRepository";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { UserPersonaNamingPreference } from "@/types/personaNaming";
import {
  buildPersonalConfigRouteId,
  buildPersonalConfigRouteSegments,
  DEFAULT_PAGE_FOR_CATEGORY,
  PERSONAL_CONFIG_ROUTE_NAMESPACE,
  PERSONAL_CONFIG_ROUTE_VERSION,
  PERSONAL_FALLBACK_PAGE_SIZE,
  PERSONAL_MODEL_PAGE_SIZE,
  PERSONAL_PROVIDER_DIRECT_LIMIT,
  PERSONAL_PROVIDER_PAGE_SIZE,
  PERSONAL_PROVIDER_RANGE_VALUE,
  QUICK_TOGGLE_CAPABILITIES,
  ROUTING_CAPABILITY_LOCALE_KEYS,
  SPOTLIGHT_AUTO_TRIGGER_PAGE_SIZE,
  SPOTLIGHT_PERSONA_PAGE_SIZE,
  SPOTLIGHT_REMOVE_PAGE_SIZE,
  encodeProviderParam,
  type PersonalConfigCategory,
  type PersonalConfigManagedCapability,
  type PersonalConfigPage,
} from "@/utils/discord/personalConfigPanelCatalog";
import {
  buildCategoryButtonRow,
  buildPanelContainer,
  buildPanelReceiptContainer,
  buildRangeChooserComponents,
  withLinePrefix,
} from "@/utils/discord/ui/panel";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { buildModelRoutingControl } from "@/utils/discord/ui/modelRoutingControls";
import { escapeDiscordMarkdown } from "@/utils/text/discordMarkdown";
import { formatUTCOffset } from "@/utils/text/timezoneHelper";
import { localizer } from "@/utils/text/localizer";
import { getProviderDisplayName } from "@/utils/provider/providerInfoRegistry";

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
      kind: "model-provider-range";
      capability: PersonalConfigManagedCapability;
      rangePage: number;
      totalOptions: number;
    }
  | {
      kind: "model-provider-page";
      capability: PersonalConfigManagedCapability;
      start: number;
    }
  | {
      kind: "fallbacks-range";
      provider: string;
      rangePage: number;
      totalOptions: number;
    }
  | { kind: "impersonation-clear-confirm"; nonce: string }
  | {
      kind: "spotlight-set-review";
      channelId: string;
      hours: number;
      blockIdx: number;
      selectedPersonaIds: number[];
      autoTriggerPersonaId: number | null;
      autoIdx: number;
      mask: string;
      fp: string;
      nonce: string;
    }
  | {
      kind: "spotlight-persona-select";
      channelId: string;
      hours: number;
      fp: string;
      totalPersonas: number;
      chooserPage: number;
    }
  | {
      kind: "spotlight-auto-range";
      channelId: string;
      hours: number;
      blockIdx: number;
      mask: string;
      fp: string;
      rangePage: number;
      totalOptions: number;
    }
  | {
      kind: "spotlight-remove-range";
      rangePage: number;
      totalOptions: number;
      fp: string;
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
  selectedPersonaAvatarUrl?: string | null;
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

function buildRetryRow(
  locale: string,
  category: PersonalConfigCategory,
  page: PersonalConfigPage,
  lineageId?: number,
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildPersonalConfigRouteId({
          action: "retry",
          locale,
          category,
          page,
          ...(lineageId !== undefined ? { lineageId } : {}),
        }),
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
    case "model-range": {
      const capName = localizer(locale, ROUTING_CAPABILITY_LOCALE_KEYS[view.capability]);
      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.model_range_title", { capability: capName })}
${localizer(locale, "commands.personal.config.model_range_desc", { provider: getProviderDisplayName(view.provider) })}`,
        },
        ...buildRangeChooserComponents({
          locale,
          totalCount: view.totalOptions,
          pageSize: PERSONAL_MODEL_PAGE_SIZE,
          chooserPage: view.rangePage,
          namespace: PERSONAL_CONFIG_ROUTE_NAMESPACE,
          version: PERSONAL_CONFIG_ROUTE_VERSION,
          buildSegments: {
            range: (rangeIndex) =>
              buildPersonalConfigRouteSegments({
                action: "model-range-open",
                locale,
                capability: view.capability,
                provider: view.provider,
                start: rangeIndex * PERSONAL_MODEL_PAGE_SIZE,
              }),
            previous: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "model-range-page",
                locale,
                capability: view.capability,
                provider: view.provider,
                chooserPage: targetPage,
              }),
            next: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "model-range-page",
                locale,
                capability: view.capability,
                provider: view.provider,
                chooserPage: targetPage,
              }),
            cancel: () => buildPersonalConfigRouteSegments({ action: "model-act-cancel", locale }),
          },
        }),
      ];
    }
    case "model-provider-range": {
      const capName = localizer(locale, ROUTING_CAPABILITY_LOCALE_KEYS[view.capability]);
      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "general.pagination.select_page_title")}\n**${capName}**`,
        },
        ...buildRangeChooserComponents({
          locale,
          totalCount: view.totalOptions,
          pageSize: PERSONAL_PROVIDER_PAGE_SIZE,
          chooserPage: view.rangePage,
          namespace: PERSONAL_CONFIG_ROUTE_NAMESPACE,
          version: PERSONAL_CONFIG_ROUTE_VERSION,
          buildSegments: {
            range: (rangeIndex) =>
              buildPersonalConfigRouteSegments({
                action: "model-provider-range-open",
                locale,
                capability: view.capability,
                start: rangeIndex * PERSONAL_PROVIDER_PAGE_SIZE,
              }),
            previous: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "model-provider-range-page",
                locale,
                capability: view.capability,
                chooserPage: targetPage,
              }),
            next: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "model-provider-range-page",
                locale,
                capability: view.capability,
                chooserPage: targetPage,
              }),
            cancel: () => buildPersonalConfigRouteSegments({ action: "model-act-cancel", locale }),
          },
        }),
      ];
    }
    case "model-provider-page": {
      const capName = localizer(locale, ROUTING_CAPABILITY_LOCALE_KEYS[view.capability]);
      const providers =
        input.modelDisplayInfo?.eligibleProvidersForCapability[view.capability].slice(
          view.start,
          view.start + PERSONAL_PROVIDER_PAGE_SIZE,
        ) ?? [];
      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.manage_capability_heading", {
            capability: capName,
          })}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: buildPersonalConfigRouteId({
                action: "model-provider-select",
                locale,
                capability: view.capability,
              }),
              placeholder: safeSelectOptionText(
                localizer(locale, "commands.personal.config.choose_model_placeholder"),
                150,
              ),
              options: providers.map((provider) => ({
                value: encodeProviderParam(provider),
                label: safeSelectOptionText(getProviderDisplayName(provider), 100),
              })),
            },
          ],
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildPersonalConfigRouteId({ action: "model-act-cancel", locale }),
              label: localizer(locale, "general.pagination.cancel"),
            },
          ],
        },
      ];
    }
    case "fallbacks-range": {
      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.fallbacks_range_title")}
${localizer(locale, "commands.personal.config.fallbacks_range_desc", { provider: getProviderDisplayName(view.provider) })}`,
        },
        ...buildRangeChooserComponents({
          locale,
          totalCount: view.totalOptions,
          pageSize: PERSONAL_FALLBACK_PAGE_SIZE,
          chooserPage: view.rangePage,
          namespace: PERSONAL_CONFIG_ROUTE_NAMESPACE,
          version: PERSONAL_CONFIG_ROUTE_VERSION,
          buildSegments: {
            range: (rangeIndex) =>
              buildPersonalConfigRouteSegments({
                action: "fallbacks-range-open",
                locale,
                provider: view.provider,
                start: rangeIndex * PERSONAL_FALLBACK_PAGE_SIZE,
              }),
            previous: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "fallbacks-range-page",
                locale,
                provider: view.provider,
                chooserPage: targetPage,
              }),
            next: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "fallbacks-range-page",
                locale,
                provider: view.provider,
                chooserPage: targetPage,
              }),
            cancel: () => buildPersonalConfigRouteSegments({ action: "model-act-cancel", locale }),
          },
        }),
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
              customId: buildPersonalConfigRouteId({
                action: "impersonation-clear-confirm",
                locale,
                nonce: view.nonce,
              }),
              label: localizer(locale, "commands.personal.config.impersonation_clear_button"),
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({ action: "impersonation-clear-cancel", locale }),
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
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({
                action: "spot-set-cf",
                locale,
                channelId: view.channelId,
                hours: view.hours,
                autoIdx: view.autoIdx,
                blockIdx: view.blockIdx,
                mask: view.mask,
                fp: view.fp,
                nonce: view.nonce,
              }),
              label: localizer(locale, "commands.personal.config.spotlight_save_button"),
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({
                action: "spot-set-auto",
                locale,
                channelId: view.channelId,
                hours: view.hours,
                blockIdx: view.blockIdx,
                mask: view.mask,
                fp: view.fp,
                nonce: view.nonce,
              }),
              label: localizer(locale, "commands.personal.config.spotlight_auto_button"),
              disabled: selectedPersonas.length === 0,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({ action: "spotlight-set-cancel", locale }),
              label: localizer(locale, "commands.personal.config.cancel"),
            },
          ],
        },
      ];
    }
    case "spotlight-persona-select": {
      const header = {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.personal.config.spotlight_personas_label")}
${localizer(locale, "commands.personal.config.spotlight_personas_desc")}`,
      } satisfies ComponentInContainerData;

      // At or below one block every persona fits in a single submit, so a chooser would add a step
      // that can only ever have one answer.
      if (view.totalPersonas <= SPOTLIGHT_PERSONA_PAGE_SIZE) {
        return [
          header,
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildPersonalConfigRouteId({
                  action: "spotlight-set-block",
                  locale,
                  channelId: view.channelId,
                  hours: view.hours,
                  fp: view.fp,
                  blockIdx: 0,
                }),
                label: localizer(locale, "commands.personal.config.spotlight_personas_label"),
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildPersonalConfigRouteId({ action: "spotlight-set-cancel", locale }),
                label: localizer(locale, "commands.personal.config.cancel"),
              },
            ],
          },
        ];
      }

      return [
        header,
        ...buildRangeChooserComponents({
          locale,
          totalCount: view.totalPersonas,
          pageSize: SPOTLIGHT_PERSONA_PAGE_SIZE,
          chooserPage: view.chooserPage,
          namespace: PERSONAL_CONFIG_ROUTE_NAMESPACE,
          version: PERSONAL_CONFIG_ROUTE_VERSION,
          buildSegments: {
            range: (rangeIndex) =>
              buildPersonalConfigRouteSegments({
                action: "spotlight-set-block",
                locale,
                channelId: view.channelId,
                hours: view.hours,
                fp: view.fp,
                blockIdx: rangeIndex,
              }),
            previous: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "spotlight-set-block-page",
                locale,
                channelId: view.channelId,
                hours: view.hours,
                fp: view.fp,
                chooserPage: targetPage,
              }),
            next: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "spotlight-set-block-page",
                locale,
                channelId: view.channelId,
                hours: view.hours,
                fp: view.fp,
                chooserPage: targetPage,
              }),
            cancel: () => buildPersonalConfigRouteSegments({ action: "spotlight-set-cancel", locale }),
          },
        }),
      ];
    }
    case "spotlight-auto-range": {
      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.spotlight_auto_modal_title")}
${localizer(locale, "commands.personal.config.spotlight_auto_select_desc")}`,
        },
        ...buildRangeChooserComponents({
          locale,
          totalCount: view.totalOptions,
          pageSize: SPOTLIGHT_AUTO_TRIGGER_PAGE_SIZE,
          chooserPage: view.rangePage,
          namespace: PERSONAL_CONFIG_ROUTE_NAMESPACE,
          version: PERSONAL_CONFIG_ROUTE_VERSION,
          buildSegments: {
            range: (rangeIndex) =>
              buildPersonalConfigRouteSegments({
                action: "spot-set-auto-range",
                locale,
                channelId: view.channelId,
                hours: view.hours,
                blockIdx: view.blockIdx,
                mask: view.mask,
                fp: view.fp,
                start: rangeIndex * SPOTLIGHT_AUTO_TRIGGER_PAGE_SIZE,
              }),
            previous: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "spot-set-auto-page",
                locale,
                channelId: view.channelId,
                hours: view.hours,
                blockIdx: view.blockIdx,
                mask: view.mask,
                fp: view.fp,
                chooserPage: targetPage,
              }),
            next: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "spot-set-auto-page",
                locale,
                channelId: view.channelId,
                hours: view.hours,
                blockIdx: view.blockIdx,
                mask: view.mask,
                fp: view.fp,
                chooserPage: targetPage,
              }),
            cancel: () =>
              buildPersonalConfigRouteSegments({
                action: "spot-set-auto-cancel",
                locale,
                channelId: view.channelId,
                hours: view.hours,
                blockIdx: view.blockIdx,
                mask: view.mask,
                fp: view.fp,
              }),
          },
        }),
      ];
    }
    case "spotlight-remove-range": {
      return [
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.config.spotlight_remove_range_title")}
${localizer(locale, "commands.personal.config.spotlight_remove_range_desc")}`,
        },
        ...buildRangeChooserComponents({
          locale,
          totalCount: view.totalOptions,
          pageSize: SPOTLIGHT_REMOVE_PAGE_SIZE,
          chooserPage: view.rangePage,
          namespace: PERSONAL_CONFIG_ROUTE_NAMESPACE,
          version: PERSONAL_CONFIG_ROUTE_VERSION,
          buildSegments: {
            range: (rangeIndex) =>
              buildPersonalConfigRouteSegments({
                action: "spot-rem-range",
                locale,
                start: rangeIndex * SPOTLIGHT_REMOVE_PAGE_SIZE,
                fp: view.fp,
              }),
            previous: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "spotlight-remove-page",
                locale,
                chooserPage: targetPage,
                fp: view.fp,
              }),
            next: (targetPage) =>
              buildPersonalConfigRouteSegments({
                action: "spotlight-remove-page",
                locale,
                chooserPage: targetPage,
                fp: view.fp,
              }),
            cancel: () => buildPersonalConfigRouteSegments({ action: "spotlight-remove-cancel", locale }),
          },
        }),
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
        customId: buildPersonalConfigRouteId({
          action: "category",
          locale,
          category: "profile",
          page: DEFAULT_PAGE_FOR_CATEGORY.profile,
        }),
      },
      {
        id: "privacy",
        label: localizer(locale, "commands.personal.config.category_privacy"),
        customId: buildPersonalConfigRouteId({
          action: "category",
          locale,
          category: "privacy",
          page: DEFAULT_PAGE_FOR_CATEGORY.privacy,
        }),
      },
      {
        id: "models",
        label: localizer(locale, "commands.personal.config.category_models"),
        customId: buildPersonalConfigRouteId({
          action: "category",
          locale,
          category: "models",
          page: DEFAULT_PAGE_FOR_CATEGORY.models,
        }),
      },
      {
        id: "advanced",
        label: localizer(locale, "commands.personal.config.category_advanced"),
        customId: buildPersonalConfigRouteId({
          action: "category",
          locale,
          category: "advanced",
          page: DEFAULT_PAGE_FOR_CATEGORY.advanced,
        }),
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
        customId: buildPersonalConfigRouteId({ action: "page", locale, category, page }),
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
              customId: buildPersonalConfigRouteId({ action: "language-open", locale }),
              label: localizer(locale, "commands.personal.config.change_language_button"),
              disabled: writesDisabled,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({ action: "timezone-open", locale }),
              label: localizer(locale, "commands.personal.config.set_timezone_button"),
              disabled: writesDisabled,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({ action: "timezone-server", locale }),
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
              customId: buildPersonalConfigRouteId({ action: "naming-open", locale }),
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
              customId: buildPersonalConfigRouteId({ action: "about-open", locale }),
              label: localizer(locale, "commands.personal.config.edit_about_button"),
              disabled: writesDisabled,
            },
          ],
        },
      );
    } else if (page === "persona") {
      const personaHeading: TextDisplayComponentData = {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.personal.config.persona_naming_title")}
${localizer(locale, "commands.personal.config.persona_naming_description")}`,
      };
      components.push(
        input.selectedPersonaAvatarUrl
          ? {
              type: ComponentType.Section,
              components: [personaHeading],
              accessory: { type: ComponentType.Thumbnail, media: { url: input.selectedPersonaAvatarUrl } },
            }
          : personaHeading,
      );

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
              customId: buildPersonalConfigRouteId({
                action: "persona-select",
                locale,
                lineageId: currentLineage,
              }),
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
                customId: buildPersonalConfigRouteId({
                  action: "persona-naming-open",
                  locale,
                  lineageId: currentLineage,
                }),
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
              customId: buildPersonalConfigRouteId({ action: "appearance-open", locale }),
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
            customId: buildPersonalConfigRouteId({ action: "privacy-level-open", locale }),
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
            style: ButtonStyle.Secondary,
            customId: buildPersonalConfigRouteId({ action: "crossserver-toggle", locale }),
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
      const routing = info?.routingRows;

      components.push({
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.personal.config.models_title")}
${localizer(locale, "commands.personal.config.models_description")}`,
      });

      for (const capability of QUICK_TOGGLE_CAPABILITIES) {
        const row = routing?.[capability];
        components.push(
          buildModelRoutingControl({
            capabilityLabel: localizer(locale, ROUTING_CAPABILITY_LOCALE_KEYS[capability]),
            activeModelName: row?.activeModelName ?? null,
            activeProvider: row?.storedProvider ?? null,
            eligibleProviders: info?.eligibleProvidersForCapability[capability] ?? [],
            customId: buildPersonalConfigRouteId({
              action: "model-provider-select",
              locale,
              capability,
            }),
            serverDefaultValue: "__server_default__",
            serverDefaultLabel: localizer(locale, "commands.personal.config.override_status_server_default"),
            serverDefaultDisplay: localizer(locale, "commands.personal.config.override_status_server_default"),
            providerOverflowValue: PERSONAL_PROVIDER_RANGE_VALUE,
            providerOverflowLabel: localizer(locale, "general.pagination.select_page_title"),
            directProviderLimit: PERSONAL_PROVIDER_DIRECT_LIMIT,
            encodeProviderValue: encodeProviderParam,
            disabled: writesDisabled,
          }),
        );
      }

      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `-# ${localizer(locale, "commands.personal.config.manage_providers_hint")}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({ action: "quick-toggle-open", locale }),
              label: localizer(locale, "commands.personal.config.quick_toggle_button"),
              disabled: writesDisabled,
            },
          ],
        },
      );
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
                customId: buildPersonalConfigRouteId({
                  action: "parameters-provider-select",
                  locale,
                }),
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
                customId: buildPersonalConfigRouteId({
                  action: "parameters-1-open",
                  locale,
                  provider: selectedProvider,
                }),
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
                customId: buildPersonalConfigRouteId({
                  action: "parameters-2-open",
                  locale,
                  provider: selectedProvider,
                }),
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

        const slots = input.modelDisplayInfo?.fallbackSlots ?? [];
        const slotLines = slots
          .map(
            (s) =>
              `> ${s.slot}. \`${s.modelName ?? localizer(locale, "commands.personal.config.saved_assignment_none")}\``,
          )
          .join("\n");

        // The select is the only way into the fallback modal, so it renders even for a single
        // provider. The primary model is chosen on Switch Models, and repeating it here would give
        // it a second, non-authoritative home.
        components.push(
          {
            type: ComponentType.TextDisplay,
            // The prompt also guarantees non-empty content: a provider with no slots yet would
            // otherwise send an empty TextDisplay, which Discord rejects with BASE_TYPE_BAD_LENGTH.
            content: slotLines
              ? `${slotLines}\n${localizer(locale, "commands.personal.config.fallbacks_select_prompt")}`
              : localizer(locale, "commands.personal.config.fallbacks_select_prompt"),
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.StringSelect,
                customId: buildPersonalConfigRouteId({
                  action: "fallbacks-provider-select",
                  locale,
                }),
                placeholder: safeSelectOptionText(
                  localizer(locale, "commands.personal.config.fallbacks_provider_select_placeholder"),
                  100,
                ),
                options: (input.modelDisplayInfo?.fallbacksProviders ?? []).map((p) => ({
                  value: encodeProviderParam(p),
                  label: safeSelectOptionText(getProviderDisplayName(p), 100),
                  default: p.toLowerCase() === selectedProvider.toLowerCase(),
                })),
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
${withLinePrefix("> ", statusStr)}`,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildPersonalConfigRouteId({
                  action: "randomizer-toggle",
                  locale,
                  provider: selectedProvider,
                }),
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
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({
                action: "trigger-mode-set",
                locale,
                mode: "off",
              }),
              label: localizer(locale, "commands.personal.config.mode_off"),
              disabled: writesDisabled || dtmMode === "off",
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({
                action: "trigger-mode-set",
                locale,
                mode: "follow",
              }),
              label: localizer(locale, "commands.personal.config.mode_follow"),
              disabled: writesDisabled || dtmMode === "follow",
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({
                action: "trigger-mode-set",
                locale,
                mode: "on",
              }),
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
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({
                action: "tool-mode-set",
                locale,
                mode: "off",
              }),
              label: localizer(locale, "commands.personal.config.mode_off"),
              disabled: writesDisabled || toolMode === "off",
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({
                action: "tool-mode-set",
                locale,
                mode: "follow",
              }),
              label: localizer(locale, "commands.personal.config.mode_follow"),
              disabled: writesDisabled || toolMode === "follow",
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({
                action: "tool-mode-set",
                locale,
                mode: "on",
              }),
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
              style: ButtonStyle.Secondary,
              customId: buildPersonalConfigRouteId({ action: "impersonation-open", locale }),
              label: localizer(locale, "commands.personal.config.impersonation_edit_button"),
              disabled: writesDisabled,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildPersonalConfigRouteId({ action: "impersonation-clear-view", locale }),
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
                style: ButtonStyle.Secondary,
                customId: buildPersonalConfigRouteId({ action: "spotlight-set-open", locale }),
                label: localizer(locale, "commands.personal.config.spotlight_set_button"),
                disabled: writesDisabled,
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Danger,
                customId: buildPersonalConfigRouteId({ action: "spotlight-remove-open", locale }),
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
