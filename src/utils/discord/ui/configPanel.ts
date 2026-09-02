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
import type { TomoriState } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { AddressingStyle } from "@/types/personaNaming";
import {
  CONFIG_PERSONA_SELECT_PAGE_SIZE,
  CONFIG_ROUTE_NAMESPACE,
  CONFIG_ROUTE_VERSION,
  DEFAULT_PAGE_FOR_CONFIG_CATEGORY,
  buildConfigRouteId,
  buildConfigRouteSegments,
  type ConfigCategory,
  type ConfigPage,
} from "@/utils/discord/configPanelCatalog";
import {
  resolveConfigPageState,
  resolvePersonaGeneralActionState,
  visibleConfigCategories,
  visibleConfigPages,
  type ConfigActor,
} from "@/utils/discord/interactions/configPermissionPolicy";
import {
  buildCategoryButtonRow,
  buildOptionalThumbnailSection,
  buildPaginationRow,
  buildPanelContainer,
  buildPanelReceiptContainer,
  withLinePrefix,
} from "@/utils/discord/ui/panel";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { escapeDiscordMarkdown } from "@/utils/text/discordMarkdown";
import { localizer } from "@/utils/text/localizer";
import { normalizeTriggerWord } from "@/utils/text/triggerWords";

export interface ConfigPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export type ConfigPanelView = { kind: "main" } | { kind: "promote-confirm"; personaId: number; nonce: string };

const ADDRESSING_STYLES: readonly AddressingStyle[] = ["masculine", "feminine", "neutral"];

/**
 * Literal locale key per page. Page identifiers repeat across categories (`general` names both a
 * Persona and a Behavior page), and `check-locales` only sees dot-notation string literals, so a
 * composed key would resolve to raw text with every gate green.
 */
const PAGE_LOCALE_KEYS: Record<ConfigCategory, Record<string, string>> = {
  persona: {
    general: "commands.config.panel.page_persona_general",
    memories: "commands.config.panel.page_persona_memories",
    advanced: "commands.config.panel.page_persona_advanced",
    sprites: "commands.config.panel.page_persona_sprites",
  },
  behavior: {
    general: "commands.config.panel.page_behavior_general",
    trigger: "commands.config.panel.page_behavior_trigger",
    experimental: "commands.config.panel.page_behavior_experimental",
    notices: "commands.config.panel.page_behavior_notices",
    memory: "commands.config.panel.page_behavior_memory",
  },
  channels: {
    destinations: "commands.config.panel.page_channels_destinations",
    "auto-trigger": "commands.config.panel.page_channels_auto_trigger",
    rules: "commands.config.panel.page_channels_rules",
    overrides: "commands.config.panel.page_channels_overrides",
  },
  permissions: {
    capabilities: "commands.config.panel.page_permissions_capabilities",
    privacy: "commands.config.panel.page_permissions_privacy",
  },
  models: {
    switch: "commands.config.panel.page_models_switch",
    parameters: "commands.config.panel.page_models_parameters",
    fallbacks: "commands.config.panel.page_models_fallbacks",
    image: "commands.config.panel.page_models_image",
  },
};

const CATEGORY_LOCALE_KEYS: Record<ConfigCategory, string> = {
  persona: "commands.config.panel.category_persona",
  behavior: "commands.config.panel.category_behavior",
  channels: "commands.config.panel.category_channels",
  permissions: "commands.config.panel.category_permissions",
  models: "commands.config.panel.category_models",
};

const NAMING_STYLE_LOCALE_KEYS: Record<AddressingStyle, string> = {
  masculine: "commands.config.panel.style_masculine",
  feminine: "commands.config.panel.style_feminine",
  neutral: "commands.config.panel.style_neutral",
};

export interface ConfigPanelRenderInput {
  locale: string;
  actor: ConfigActor;
  category: ConfigCategory;
  page: ConfigPage;
  personas: TomoriState[];
  selectedPersonaId: number | null;
  selectedPersonaAvatarUrl?: string | null;
  personaSelectStart?: number;
  namingStyle?: AddressingStyle;
  readStatus: PanelReadStatus;
  receipt?: PanelReceipt;
  view?: ConfigPanelView;
}

function buildPayload(components: ComponentInContainerData[], receipt?: PanelReceipt): ConfigPanelPayload {
  return {
    components: [...(receipt ? [buildPanelReceiptContainer(receipt)] : []), buildPanelContainer(components)],
    flags: MessageFlags.IsComponentsV2,
  };
}

function buildRetryRow(
  locale: string,
  category: ConfigCategory,
  page: ConfigPage,
  personaId?: number,
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildConfigRouteId({
          action: "retry",
          locale,
          category,
          page,
          ...(personaId !== undefined ? { personaId } : {}),
        }),
        label: localizer(locale, "commands.config.panel.retry"),
      },
    ],
  };
}

function formatTriggerWords(triggerWords: readonly string[]): string {
  return triggerWords.map((word) => `\`${normalizeTriggerWord(word, { lowercase: false })}\``).join(", ");
}

/**
 * Renders one addressing style's stored prefix, suffix, and term.
 *
 * A naming habit is three independent optional values, and an empty one means the persona uses the
 * bare name, so an omitted entry is rendered explicitly rather than left as a blank row.
 */
function describeNamingStyle(locale: string, persona: TomoriState | null, style: AddressingStyle): string {
  const none = localizer(locale, "commands.config.panel.naming_none");
  const prefix = persona?.naming_config.prefixes[style];
  const suffix = persona?.naming_config.suffixes[style];
  const term = persona?.naming_config.addressTerms[style];
  return [
    `${localizer(locale, "commands.config.panel.naming_prefix_label")}: ${prefix ? `\`${escapeDiscordMarkdown(prefix)}\`` : none}`,
    `${localizer(locale, "commands.config.panel.naming_suffix_label")}: ${suffix ? `\`${escapeDiscordMarkdown(suffix)}\`` : none}`,
    `${localizer(locale, "commands.config.panel.naming_term_label")}: ${term ? `\`${escapeDiscordMarkdown(term)}\`` : none}`,
  ].join("\n");
}

/**
 * Page offset holding the current selection. A pagination button overrides it with an explicit
 * start; every other repaint wants the page the selected persona is actually on.
 */
function resolvePersonaSelectStart(personas: readonly TomoriState[], selectedPersonaId: number | null): number {
  const index = personas.findIndex((persona) => persona.persona_id === selectedPersonaId);
  if (index < 0) return 0;
  return Math.floor(index / CONFIG_PERSONA_SELECT_PAGE_SIZE) * CONFIG_PERSONA_SELECT_PAGE_SIZE;
}

function buildPersonaSelectorRows(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, personas, selectedPersonaId, readStatus } = input;
  const writesDisabled = readStatus !== "fresh";
  if (personas.length === 0) return [];

  const pageCount = Math.max(1, Math.ceil(personas.length / CONFIG_PERSONA_SELECT_PAGE_SIZE));
  // Defaulting belongs here rather than in the caller: a repaint that forgot to compute it would
  // otherwise reset the selector to page one while the panel still shows an off-page selection.
  const defaultStart = resolvePersonaSelectStart(personas, selectedPersonaId);
  const rangeIndex = Math.min(
    Math.max(Math.floor((input.personaSelectStart ?? defaultStart) / CONFIG_PERSONA_SELECT_PAGE_SIZE), 0),
    pageCount - 1,
  );
  const start = rangeIndex * CONFIG_PERSONA_SELECT_PAGE_SIZE;
  const visiblePersonas = personas.slice(start, start + CONFIG_PERSONA_SELECT_PAGE_SIZE);
  const selectedPersona = personas.find((persona) => persona.persona_id === selectedPersonaId) ?? null;

  const options: SelectMenuComponentOptionData[] = visiblePersonas.map((persona) => ({
    label: safeSelectOptionText(persona.persona_nickname, 100),
    value: String(persona.persona_id),
    description: safeSelectOptionText(
      localizer(
        locale,
        persona.is_alter ? "commands.config.panel.persona_alter" : "commands.config.panel.persona_main",
      ),
      100,
    ),
    default: persona.persona_id === selectedPersonaId,
  }));

  const rows: ComponentInContainerData[] = [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildConfigRouteId({
            action: "persona-select",
            locale,
            personaId: selectedPersonaId ?? (personas[0]?.persona_id as number),
          }),
          // The selected persona can sit on another page, where no option carries `default`, so the
          // placeholder is what keeps the current selection visible while paging.
          placeholder: safeSelectOptionText(
            selectedPersona
              ? selectedPersona.persona_nickname
              : localizer(locale, "commands.config.panel.persona_select_placeholder"),
            150,
          ),
          options,
          disabled: writesDisabled,
        },
      ],
    },
  ];

  const paginationRow = buildPaginationRow({
    locale,
    rangeIndex,
    rangeCount: pageCount,
    namespace: CONFIG_ROUTE_NAMESPACE,
    version: CONFIG_ROUTE_VERSION,
    buildSegments: {
      page: (targetRangeIndex) =>
        buildConfigRouteSegments({
          action: "persona-page",
          locale,
          personaId: selectedPersonaId ?? (personas[0]?.persona_id as number),
          start: targetRangeIndex * CONFIG_PERSONA_SELECT_PAGE_SIZE,
        }),
    },
    disabled: writesDisabled,
  });
  if (paginationRow) rows.push(paginationRow);

  return rows;
}

function buildPersonaGeneralBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor, personas, selectedPersonaId, readStatus } = input;
  const writesDisabled = readStatus !== "fresh";
  const persona = personas.find((candidate) => candidate.persona_id === selectedPersonaId) ?? null;
  const namingStyle = input.namingStyle ?? "neutral";

  const heading: TextDisplayComponentData = {
    type: ComponentType.TextDisplay,
    content: `### ${localizer(locale, "commands.config.panel.general_title")}
${localizer(locale, "commands.config.panel.general_description")}`,
  };

  const components: ComponentInContainerData[] = [
    buildOptionalThumbnailSection(heading, input.selectedPersonaAvatarUrl),
  ];

  if (!persona) {
    components.push({
      type: ComponentType.TextDisplay,
      content: localizer(locale, "commands.config.panel.no_personas"),
    });
    return components;
  }

  const avatarState = resolvePersonaGeneralActionState("avatar", actor);
  const renameState = resolvePersonaGeneralActionState("rename", actor);
  const promoteState = resolvePersonaGeneralActionState("promote", actor);
  const identityButtons: ButtonComponentData[] = [];
  if (avatarState !== "omitted") {
    identityButtons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: buildConfigRouteId({ action: "avatar-open", locale, personaId: persona.persona_id as number }),
      label: localizer(locale, "commands.config.panel.change_avatar_button"),
      disabled: writesDisabled || avatarState === "disabled",
    });
  }
  if (renameState !== "omitted") {
    identityButtons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: buildConfigRouteId({ action: "rename-open", locale, personaId: persona.persona_id as number }),
      label: localizer(locale, "commands.config.panel.rename_button"),
      disabled: writesDisabled || renameState === "disabled",
    });
  }
  if (persona.is_alter === true && promoteState !== "omitted") {
    identityButtons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: buildConfigRouteId({ action: "promote-view", locale, personaId: persona.persona_id as number }),
      label: localizer(locale, "commands.config.panel.promote_button"),
      disabled: writesDisabled || promoteState === "disabled",
    });
  }

  components.push({
    type: ComponentType.TextDisplay,
    content: `> ${localizer(locale, "commands.config.panel.role_label")}: ${localizer(
      locale,
      persona.is_alter ? "commands.config.panel.role_alter" : "commands.config.panel.role_main",
    )}`,
  });
  if (identityButtons.length > 0) {
    components.push({ type: ComponentType.ActionRow, components: identityButtons });
  }

  const triggerAddState = resolvePersonaGeneralActionState("trigger-add", actor);
  const triggerRemoveState = resolvePersonaGeneralActionState("trigger-remove", actor);
  if (triggerAddState !== "omitted" || triggerRemoveState !== "omitted") {
    const triggerWords = persona.trigger_words ?? [];
    components.push({
      type: ComponentType.TextDisplay,
      content: `${localizer(locale, "commands.config.panel.triggers_title")}
${localizer(locale, "commands.config.panel.triggers_description")}
> ${
        triggerWords.length > 0
          ? formatTriggerWords(triggerWords)
          : localizer(locale, "commands.config.panel.triggers_none")
      }`,
    });
    const triggerButtons: ButtonComponentData[] = [];
    if (triggerAddState !== "omitted") {
      triggerButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildConfigRouteId({ action: "trigger-add-open", locale, personaId: persona.persona_id as number }),
        label: localizer(locale, "commands.config.panel.add_trigger_button"),
        disabled: writesDisabled || triggerAddState === "disabled",
      });
    }
    if (triggerRemoveState !== "omitted") {
      triggerButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildConfigRouteId({
          action: "trigger-remove-open",
          locale,
          personaId: persona.persona_id as number,
        }),
        label: localizer(locale, "commands.config.panel.remove_trigger_button"),
        disabled: writesDisabled || triggerRemoveState === "disabled" || triggerWords.length === 0,
      });
    }
    components.push(
      { type: ComponentType.ActionRow, components: triggerButtons },
      {
        type: ComponentType.TextDisplay,
        content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.triggers_footer")),
      },
    );
  }

  const namingState = resolvePersonaGeneralActionState("naming", actor);
  if (namingState !== "omitted") {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `${localizer(locale, "commands.config.panel.naming_title")}
${localizer(locale, "commands.config.panel.naming_description")}
${withLinePrefix("> ", describeNamingStyle(locale, persona, namingStyle))}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildConfigRouteId({
              action: "naming-style-select",
              locale,
              personaId: persona.persona_id as number,
            }),
            placeholder: localizer(locale, "commands.config.panel.naming_style_placeholder"),
            options: ADDRESSING_STYLES.map((style) => ({
              label: safeSelectOptionText(localizer(locale, NAMING_STYLE_LOCALE_KEYS[style]), 100),
              value: style,
              default: style === namingStyle,
            })),
            disabled: writesDisabled || namingState === "disabled",
          },
        ],
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({
              action: "naming-open",
              locale,
              personaId: persona.persona_id as number,
              style: namingStyle,
            }),
            label: localizer(locale, "commands.config.panel.edit_naming_button"),
            disabled: writesDisabled || namingState === "disabled",
          },
        ],
      },
    );
  }

  return components;
}

function buildPromoteConfirmBody(
  input: ConfigPanelRenderInput,
  view: Extract<ConfigPanelView, { kind: "promote-confirm" }>,
): ComponentInContainerData[] {
  const { locale, personas } = input;
  const persona = personas.find((candidate) => candidate.persona_id === view.personaId) ?? null;
  const mainPersona = personas.find((candidate) => candidate.is_alter !== true) ?? null;

  return [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.promote_confirm_title")}
${localizer(locale, "commands.config.panel.promote_confirm_description", {
  persona: escapeDiscordMarkdown(persona?.persona_nickname ?? ""),
  main: escapeDiscordMarkdown(mainPersona?.persona_nickname ?? ""),
})}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildConfigRouteId({
            action: "promote-confirm",
            locale,
            personaId: view.personaId,
            nonce: view.nonce,
          }),
          label: localizer(locale, "commands.config.panel.promote_button"),
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "promote-cancel", locale, personaId: view.personaId }),
          label: localizer(locale, "commands.config.panel.cancel_button"),
        },
      ],
    },
  ];
}

export function buildConfigPanelPayload(input: ConfigPanelRenderInput): ConfigPanelPayload {
  const { locale, actor, category, page, readStatus, receipt } = input;
  const writesDisabled = readStatus !== "fresh";

  const categoryEntries = visibleConfigCategories(actor);
  const categoryRow = buildCategoryButtonRow<ConfigCategory>(
    categoryEntries.map(({ category: id }) => ({
      id,
      label: localizer(locale, CATEGORY_LOCALE_KEYS[id]),
      customId: buildConfigRouteId({
        action: "category",
        locale,
        category: id,
        // A disabled button is never pressed, so its route only has to name a well-formed
        // destination the policy would also accept.
        page: visibleConfigPages(id, actor)[0] ?? DEFAULT_PAGE_FOR_CONFIG_CATEGORY[id],
      }),
    })),
    category,
    readStatus === "unavailable",
  );

  // The shared helper takes one row-wide disabled flag, which no earlier panel needed to vary. A
  // category inert for permission reasons is per-button, so it is re-applied over the row here;
  // the helper preserves input order, which is what makes the index alignment safe.
  categoryEntries.forEach((entry, index) => {
    if (entry.disabled) categoryRow.components[index].disabled = true;
  });

  const components: ComponentInContainerData[] = [
    categoryRow,
    { type: ComponentType.Separator, divider: true, spacing: 1 },
  ];

  if (readStatus === "unavailable") {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.config.panel.unavailable")}`,
      },
      buildRetryRow(locale, category, page, input.selectedPersonaId ?? undefined),
    );
    return buildPayload(components, receipt);
  }

  if (category === "persona") {
    components.push(...buildPersonaSelectorRows(input));
  }

  const pages = visibleConfigPages(category, actor);
  // A String Select option cannot be disabled, so a filtered category that leaves one page renders
  // that page directly rather than an inert one-option selector.
  if (pages.length > 1) {
    const pageSelectorRow: ActionRowData<StringSelectMenuComponentData> = {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildConfigRouteId({ action: "page", locale, category, page }),
          placeholder: localizer(locale, "commands.config.panel.page_select_placeholder"),
          options: pages.map((candidate) => ({
            label: safeSelectOptionText(localizer(locale, PAGE_LOCALE_KEYS[category][candidate]), 100),
            value: candidate,
            default: candidate === page,
          })),
          disabled: writesDisabled,
        },
      ],
    };
    components.push(pageSelectorRow);
  }

  if (input.view && input.view.kind === "promote-confirm") {
    components.push(...buildPromoteConfirmBody(input, input.view));
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "general") {
    components.push(...buildPersonaGeneralBody(input));
    return buildPayload(components, receipt);
  }

  // Every other destination lands in a later Phase D slice. `/config` registers no slash command
  // until that cutover, so this placeholder is unreachable rather than shipped.
  components.push({
    type: ComponentType.TextDisplay,
    content: `### ${localizer(locale, PAGE_LOCALE_KEYS[category][page])}
${localizer(locale, "commands.config.panel.page_pending")}${
  resolveConfigPageState(category, page, actor) === "read-only"
    ? `\n${withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only"))}`
    : ""
}`,
  });
  return buildPayload(components, receipt);
}
