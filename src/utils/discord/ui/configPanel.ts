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
import { CooldownType, type LlmRow, type PersonaSpriteRow, type TomoriState } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { AddressingStyle } from "@/types/personaNaming";
import {
  CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
  CONFIG_PERSONA_SELECT_PAGE_SIZE,
  CONFIG_PERSONA_SPRITE_PAGE_SIZE,
  CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY,
  CONFIG_ROUTE_NAMESPACE,
  CONFIG_ROUTE_VERSION,
  DEFAULT_PAGE_FOR_CONFIG_CATEGORY,
  buildConfigRouteId,
  buildConfigRouteSegments,
  computeAttributeFingerprint,
  computeDialogueFingerprint,
  computeSpriteFingerprint,
  type ConfigCategory,
  type ConfigPage,
} from "@/utils/discord/configPanelCatalog";
import {
  resolveConfigPageState,
  resolvePersonaAdvancedActionState,
  resolvePersonaMemoriesActionState,
  resolvePersonaCollectionActionState,
  resolvePersonaGeneralActionState,
  resolvePersonaSpritesActionState,
  resolveBehaviorGeneralActionState,
  visibleConfigCategories,
  visibleConfigPages,
  type ConfigActor,
} from "@/utils/discord/interactions/configPermissionPolicy";
import {
  createHumanizerOptions,
  getHumanizerLabel,
  HUMANIZER_DEFAULT,
  HUMANIZER_INHERIT_VALUE,
} from "@/utils/discord/humanizerOptions";
import type { ConfigBehaviorView, ConfigPersonaMemoryView } from "@/utils/discord/interactions/configRouteContext";
import {
  buildCategoryButtonRow,
  buildOptionalThumbnailSection,
  buildPaginationRow,
  buildStateControlRow,
  buildPanelContainer,
  buildPanelReceiptContainer,
  withLinePrefix,
} from "@/utils/discord/ui/panel";
import {
  buildConfigModelsBody,
  type ConfigFallbacksView,
  type ConfigImageGenerationView,
  type ConfigModelListView,
  type ConfigParametersView,
  type ConfigSwitchModelsView,
} from "@/utils/discord/ui/configModelsPanel";
import { TOOL_NOTICE_DEFINITIONS } from "@/constants/toolNotices";
import { WORKAROUND_DEFINITIONS } from "@/utils/discord/workaroundConfigMapping";
import { DEFAULT_STM_TOOL_DESCRIPTION } from "@/tools/functionCalls/updateShortTermMemoryTool";
import { SEED_CATEGORY_UPDATE_HINT, SEED_SUMMARY_UPDATE_HINT } from "@/utils/text/context/memories";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { resolvePersonaAvatarPublicUrl } from "@/utils/storage/avatarStorage";
import { escapeDiscordMarkdown } from "@/utils/text/discordMarkdown";
import { localizer } from "@/utils/text/localizer";
import { normalizeTriggerWord } from "@/utils/text/triggerWords";
import { buildSlugMap } from "@/utils/text/slugifyLabel";
import { buildTextPreview } from "@/utils/text/textPreview";
import { DEFAULT_SYSTEM_PROMPT } from "@/utils/text/contextBuilder";
import { formatUTCOffset } from "@/utils/text/timezoneHelper";

const RANDOM_TRIGGER_PAGE_SIZE = CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY;

export interface ConfigPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export type ConfigPanelView =
  | { kind: "main" }
  | { kind: "promote-confirm"; personaId: number; nonce: string }
  | { kind: "character-reference-clear-confirm"; personaId: number; nonce: string }
  | { kind: "sprite-remove-confirm"; personaId: number; index: number; fp: string; nonce: string }
  | { kind: "humanizer-editor"; personaId: number }
  | { kind: "text-override-provider"; personaId: number; providers: string[] }
  | {
      kind: "text-override-model";
      personaId: number;
      provider: string;
      models: LlmRow[];
      start: number;
    };

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
  attributePageStart?: number;
  selectedAttributeIndex?: number;
  dialoguePageStart?: number;
  selectedDialogueIndex?: number;
  attributeMemteachingEnabled?: boolean;
  sampledialogueMemteachingEnabled?: boolean;
  namingStyle?: AddressingStyle;
  readStatus: PanelReadStatus;
  receipt?: PanelReceipt;
  view?: ConfigPanelView;
  personaMemoryView?: ConfigPersonaMemoryView;
  serverHumanizerDegree?: number | null;
  personaSprites?: PersonaSpriteRow[];
  spritePageStart?: number;
  selectedSpriteIndex?: number;
  switchModelsView?: ConfigSwitchModelsView;
  modelParametersView?: ConfigParametersView;
  modelFallbacksView?: ConfigFallbacksView;
  imageGenerationView?: ConfigImageGenerationView;
  modelListView?: ConfigModelListView;
  randomTriggerPageStart?: number;
  behaviorView?: ConfigBehaviorView;
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

function renderFencedCollectionContent(content: string): string {
  return ["```markdown", content.replaceAll("```", "`\u200b``"), "```"].join("\n");
}

function renderStmContent(locale: string, content: string, maxLength = 3800): string {
  const safeContent = content.replaceAll("```", "`\u200b``");
  const rendered = renderFencedCollectionContent(safeContent);
  if (rendered.length <= maxLength) return rendered;
  const truncatedNotice = `\n${localizer(locale, "commands.config.panel.stm_truncated")}`;
  const fenceOverhead = renderFencedCollectionContent("").length;
  const availableLength = Math.max(0, maxLength - fenceOverhead - truncatedNotice.length);
  return renderFencedCollectionContent(`${safeContent.slice(0, availableLength)}${truncatedNotice}`);
}

function collectionRangeIndex(
  totalCount: number,
  requestedStart: number | undefined,
  selectedIndex: number | undefined,
): number {
  const rangeCount = Math.max(1, Math.ceil(totalCount / CONFIG_PERSONA_COLLECTION_PAGE_SIZE));
  const defaultStart =
    selectedIndex === undefined
      ? 0
      : Math.floor(selectedIndex / CONFIG_PERSONA_COLLECTION_PAGE_SIZE) * CONFIG_PERSONA_COLLECTION_PAGE_SIZE;
  const requestedRange = Math.floor((requestedStart ?? defaultStart) / CONFIG_PERSONA_COLLECTION_PAGE_SIZE);
  return Math.min(Math.max(requestedRange, 0), rangeCount - 1);
}

function mayWritePersonaCollection(
  input: ConfigPanelRenderInput,
  action: "attribute-add" | "dialogue-add",
  teachingEnabled: boolean | undefined,
): boolean {
  return (
    resolvePersonaCollectionActionState(action, input.actor) === "enabled" &&
    ((input.actor.isManager && input.actor.workspaceKind === "guild") || teachingEnabled === true)
  );
}

function buildAttributeCollectionBody(input: ConfigPanelRenderInput, persona: TomoriState): ComponentInContainerData[] {
  const { locale, readStatus } = input;
  const mayWrite = mayWritePersonaCollection(input, "attribute-add", input.attributeMemteachingEnabled);
  const attributes = persona.attribute_list ?? [];
  const selectedIndex =
    input.selectedAttributeIndex !== undefined &&
    input.selectedAttributeIndex >= 0 &&
    input.selectedAttributeIndex < attributes.length
      ? input.selectedAttributeIndex
      : undefined;
  const rangeIndex = collectionRangeIndex(attributes.length, input.attributePageStart, selectedIndex);
  const start = rangeIndex * CONFIG_PERSONA_COLLECTION_PAGE_SIZE;
  const visibleAttributes = attributes.slice(start, start + CONFIG_PERSONA_COLLECTION_PAGE_SIZE);
  const options: SelectMenuComponentOptionData[] = [
    ...(mayWrite
      ? [
          {
            label: safeSelectOptionText(localizer(locale, "commands.config.panel.attribute_add_option"), 100),
            value: "add",
          },
        ]
      : []),
    ...visibleAttributes.map((attribute, offset) => ({
      label: safeSelectOptionText(
        `${localizer(locale, "commands.config.panel.attribute_option_prefix")} ${start + offset + 1}: ${attribute}`,
        100,
      ),
      value: String(start + offset),
      default: start + offset === selectedIndex,
    })),
  ];

  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `${localizer(locale, "commands.config.panel.attributes_title")}
${localizer(locale, "commands.config.panel.attributes_description")}`,
    },
  ];

  if (!mayWrite) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.collection_teaching_disabled")),
    });
  }

  if (options.length > 0) {
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildConfigRouteId({ action: "attribute-select", locale, personaId: persona.persona_id as number }),
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.config.panel.attribute_select_placeholder"),
            150,
          ),
          options,
          disabled: readStatus !== "fresh",
        },
      ],
    });
  }

  if (options.length > 0) {
    const paginationRow = buildPaginationRow({
      locale,
      rangeIndex,
      rangeCount: Math.max(1, Math.ceil(attributes.length / CONFIG_PERSONA_COLLECTION_PAGE_SIZE)),
      namespace: CONFIG_ROUTE_NAMESPACE,
      version: CONFIG_ROUTE_VERSION,
      buildSegments: {
        page: (targetRangeIndex) =>
          buildConfigRouteSegments({
            action: "attribute-page",
            locale,
            personaId: persona.persona_id as number,
            start: targetRangeIndex * CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
          }),
      },
      disabled: readStatus !== "fresh",
    });
    if (paginationRow) components.push(paginationRow);
  }

  if (selectedIndex !== undefined) {
    const selectedAttribute = attributes[selectedIndex];
    const isPublic =
      persona.persona_attributes?.find((attribute) => attribute.attribute_order === selectedIndex + 1)?.is_public ??
      false;
    const fp = computeAttributeFingerprint(persona.persona_id as number, selectedIndex, selectedAttribute, isPublic);
    components.push(
      { type: ComponentType.TextDisplay, content: renderFencedCollectionContent(selectedAttribute) },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({
              action: "attribute-edit-open",
              locale,
              personaId: persona.persona_id as number,
              index: selectedIndex,
              fp,
            }),
            label: localizer(locale, "commands.config.panel.attribute_edit_button"),
            disabled: readStatus !== "fresh" || !mayWrite,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildConfigRouteId({
              action: "attribute-remove",
              locale,
              personaId: persona.persona_id as number,
              index: selectedIndex,
              fp,
            }),
            label: localizer(locale, "commands.config.panel.attribute_remove_button"),
            disabled: readStatus !== "fresh" || !mayWrite,
          },
        ],
      },
    );
  }

  return components;
}

function buildDialogueCollectionBody(input: ConfigPanelRenderInput, persona: TomoriState): ComponentInContainerData[] {
  const { locale, readStatus } = input;
  const mayWrite = mayWritePersonaCollection(input, "dialogue-add", input.sampledialogueMemteachingEnabled);
  const inputs = persona.sample_dialogues_in ?? [];
  const outputs = persona.sample_dialogues_out ?? [];
  const pairCount = Math.min(inputs.length, outputs.length);
  const selectedIndex =
    input.selectedDialogueIndex !== undefined &&
    input.selectedDialogueIndex >= 0 &&
    input.selectedDialogueIndex < pairCount
      ? input.selectedDialogueIndex
      : undefined;
  const rangeIndex = collectionRangeIndex(pairCount, input.dialoguePageStart, selectedIndex);
  const start = rangeIndex * CONFIG_PERSONA_COLLECTION_PAGE_SIZE;
  const visibleInputs = inputs.slice(start, start + CONFIG_PERSONA_COLLECTION_PAGE_SIZE);
  const options: SelectMenuComponentOptionData[] = [
    ...(mayWrite
      ? [
          {
            label: safeSelectOptionText(localizer(locale, "commands.config.panel.dialogue_add_option"), 100),
            value: "add",
          },
        ]
      : []),
    ...visibleInputs.map((dialogue, offset) => ({
      label: safeSelectOptionText(
        `${localizer(locale, "commands.config.panel.dialogue_option_prefix")} ${start + offset + 1}: ${dialogue}`,
        100,
      ),
      value: String(start + offset),
      description: safeSelectOptionText(outputs[start + offset] ?? "", 100),
      default: start + offset === selectedIndex,
    })),
  ];

  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `${localizer(locale, "commands.config.panel.dialogues_title")}
${localizer(locale, "commands.config.panel.dialogues_description")}`,
    },
  ];

  if (!mayWrite) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.collection_teaching_disabled")),
    });
  }

  if (options.length > 0) {
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildConfigRouteId({ action: "dialogue-select", locale, personaId: persona.persona_id as number }),
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.config.panel.dialogue_select_placeholder"),
            150,
          ),
          options,
          disabled: readStatus !== "fresh",
        },
      ],
    });
  }

  if (options.length > 0) {
    const paginationRow = buildPaginationRow({
      locale,
      rangeIndex,
      rangeCount: Math.max(1, Math.ceil(pairCount / CONFIG_PERSONA_COLLECTION_PAGE_SIZE)),
      namespace: CONFIG_ROUTE_NAMESPACE,
      version: CONFIG_ROUTE_VERSION,
      buildSegments: {
        page: (targetRangeIndex) =>
          buildConfigRouteSegments({
            action: "dialogue-page",
            locale,
            personaId: persona.persona_id as number,
            start: targetRangeIndex * CONFIG_PERSONA_COLLECTION_PAGE_SIZE,
          }),
      },
      disabled: readStatus !== "fresh",
    });
    if (paginationRow) components.push(paginationRow);
  }

  if (selectedIndex !== undefined) {
    const selectedInput = inputs[selectedIndex];
    const selectedOutput = outputs[selectedIndex];
    const fp = computeDialogueFingerprint(persona.persona_id as number, selectedIndex, selectedInput, selectedOutput);
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: renderFencedCollectionContent(
          `${localizer(locale, "commands.config.panel.dialogue_user_prefix")}: ${selectedInput}
${localizer(locale, "commands.config.panel.dialogue_bot_prefix")}: ${selectedOutput}`,
        ),
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({
              action: "dialogue-edit-open",
              locale,
              personaId: persona.persona_id as number,
              index: selectedIndex,
              fp,
            }),
            label: localizer(locale, "commands.config.panel.dialogue_edit_button"),
            disabled: readStatus !== "fresh" || !mayWrite,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildConfigRouteId({
              action: "dialogue-remove",
              locale,
              personaId: persona.persona_id as number,
              index: selectedIndex,
              fp,
            }),
            label: localizer(locale, "commands.config.panel.dialogue_remove_button"),
            disabled: readStatus !== "fresh" || !mayWrite,
          },
        ],
      },
    );
  }

  return components;
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

  components.push(...buildAttributeCollectionBody(input, persona));
  components.push(...buildDialogueCollectionBody(input, persona));

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

function buildPersonaCharacterReferenceClearBody(
  input: ConfigPanelRenderInput,
  view: Extract<ConfigPanelView, { kind: "character-reference-clear-confirm" }>,
): ComponentInContainerData[] {
  const persona = input.personas.find((candidate) => candidate.persona_id === view.personaId);
  if (!persona || resolvePersonaAdvancedActionState("character-reference", input.actor) === "omitted") return [];
  const writesDisabled = input.readStatus !== "fresh";
  const actionDisabled = writesDisabled || !persona.nai_char_ref_url;
  return [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(input.locale, "commands.config.panel.character_reference_clear_title")}
${localizer(input.locale, "commands.config.panel.character_reference_clear_description", {
  persona: escapeDiscordMarkdown(persona.persona_nickname),
})}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildConfigRouteId({
            action: "character-reference-clear-confirm",
            locale: input.locale,
            personaId: view.personaId,
            nonce: view.nonce,
          }),
          label: localizer(input.locale, "commands.config.panel.clear_reference_button"),
          disabled: actionDisabled,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({
            action: "character-reference-clear-cancel",
            locale: input.locale,
            personaId: view.personaId,
          }),
          label: localizer(input.locale, "commands.config.panel.cancel_button"),
        },
      ],
    },
  ];
}

function renderHumanizerDegree(locale: string, value: number | null | undefined): string {
  return getHumanizerLabel(locale, value ?? HUMANIZER_DEFAULT);
}

function buildPersonaAdvancedBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor, personas, selectedPersonaId, readStatus } = input;
  const persona = personas.find((candidate) => candidate.persona_id === selectedPersonaId) ?? null;
  if (!persona) {
    return [
      buildOptionalThumbnailSection(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.config.panel.advanced_title")}
${localizer(locale, "commands.config.panel.advanced_description")}`,
        },
        input.selectedPersonaAvatarUrl,
      ),
      { type: ComponentType.TextDisplay, content: localizer(locale, "commands.config.panel.no_personas") },
    ];
  }

  const writesDisabled = readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    buildOptionalThumbnailSection(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.config.panel.advanced_title")}
${localizer(locale, "commands.config.panel.advanced_description")}`,
      },
      input.selectedPersonaAvatarUrl,
    ),
  ];
  const personaId = persona.persona_id as number;
  const actionState = (action: Parameters<typeof resolvePersonaAdvancedActionState>[0]) =>
    resolvePersonaAdvancedActionState(action, actor);

  const imageTagsState = actionState("image-tags");
  if (imageTagsState !== "omitted") {
    const tags = persona.physical_appearance_tags ?? [];
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.config.panel.image_tags_title")}**
${localizer(locale, "commands.config.panel.image_tags_description")}
${renderFencedCollectionContent(tags.length > 0 ? tags.join(", ") : localizer(locale, "commands.config.panel.none_label"))}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "image-tags-open", locale, personaId }),
            label: localizer(locale, "commands.config.panel.edit_image_tags_button"),
            disabled: writesDisabled || imageTagsState === "disabled",
          },
        ],
      },
    );
  }

  const characterReferenceState = actionState("character-reference");
  if (characterReferenceState !== "omitted") {
    const reference = persona.nai_char_ref_url
      ? `\`${escapeDiscordMarkdown(persona.nai_char_ref_url)}\``
      : localizer(locale, "commands.config.panel.none_label");
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.config.panel.character_reference_title")}**
${localizer(locale, "commands.config.panel.character_reference_description")}
> ${localizer(locale, "commands.config.panel.character_reference_image_label")}: ${reference}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "character-reference-open", locale, personaId }),
            label: localizer(locale, "commands.config.panel.upload_reference_button"),
            disabled: writesDisabled || characterReferenceState === "disabled",
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildConfigRouteId({ action: "character-reference-clear-view", locale, personaId }),
            label: localizer(locale, "commands.config.panel.clear_reference_button"),
            disabled: writesDisabled || characterReferenceState === "disabled" || !persona.nai_char_ref_url,
          },
        ],
      },
    );
  }

  const promptState = actionState("prompt");
  if (promptState !== "omitted") {
    const preview = buildTextPreview(persona.persona_prompt, 3000);
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.config.panel.persona_prompt_title")}**
${localizer(locale, "commands.config.panel.persona_prompt_description")}
${renderFencedCollectionContent(preview.text || localizer(locale, "commands.config.panel.none_label"))}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "prompt-open", locale, personaId }),
            label: localizer(locale, "commands.config.panel.set_prompt_button"),
            disabled: writesDisabled || promptState === "disabled",
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildConfigRouteId({ action: "prompt-remove", locale, personaId }),
            label: localizer(locale, "commands.config.panel.remove_prompt_button"),
            disabled: writesDisabled || promptState === "disabled" || !persona.persona_prompt?.trim(),
          },
        ],
      },
    );
  }

  const contextState = actionState("context-note");
  if (contextState !== "omitted") {
    const note = persona.context_note?.trim() ?? "";
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.config.panel.context_note_title")}**
${localizer(locale, "commands.config.panel.context_note_description")}
> ${localizer(locale, "commands.config.panel.context_note_depth", {
          depth: persona.context_note_depth ?? 0,
        })}
${renderFencedCollectionContent(note || localizer(locale, "commands.config.panel.none_label"))}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "context-note-open", locale, personaId }),
            label: localizer(locale, "commands.config.panel.edit_context_note_button"),
            disabled: writesDisabled || contextState === "disabled",
          },
        ],
      },
    );
  }

  const humanizerState = actionState("humanizer");
  if (humanizerState !== "omitted") {
    const humanizerValue = persona.humanizer_degree_override ?? null;
    components.push({
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.response_style_title")}**
${localizer(locale, "commands.config.panel.response_style_description")}
> ${localizer(locale, "commands.config.panel.persona_override_label")}: ${getHumanizerLabel(locale, humanizerValue)}
> ${localizer(locale, "commands.config.panel.server_default_label")}: ${renderHumanizerDegree(locale, input.serverHumanizerDegree)}`,
    });
    if (input.view?.kind === "humanizer-editor" && input.view.personaId === personaId) {
      const options = createHumanizerOptions(
        locale,
        humanizerValue === null ? HUMANIZER_INHERIT_VALUE : String(humanizerValue),
        true,
      ).map((option) => ({
        label: safeSelectOptionText(option.label, 100),
        value: option.value,
        description: safeSelectOptionText(option.description ?? "", 100),
        default: option.default,
      }));
      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildConfigRouteId({ action: "humanizer-select", locale, personaId }),
            placeholder: localizer(locale, "commands.config.panel.response_style_placeholder"),
            options,
            disabled: writesDisabled || humanizerState === "disabled",
          },
        ],
      });
    } else {
      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "humanizer-open", locale, personaId }),
            label: localizer(locale, "commands.config.panel.edit_humanizer_button"),
            disabled: writesDisabled || humanizerState === "disabled",
          },
        ],
      });
    }
  }

  const textState = actionState("text-override");
  if (textState !== "omitted") {
    const override = persona.persona_llm
      ? `${persona.persona_llm.llm_provider} / ${persona.persona_llm.llm_codename}`
      : localizer(locale, "commands.config.panel.none_label");
    const serverModel = persona.llm
      ? `${persona.llm.llm_provider} / ${persona.llm.llm_codename}`
      : localizer(locale, "commands.config.panel.none_label");
    components.push({
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.text_override_title")}**
${localizer(locale, "commands.config.panel.text_override_description")}
> ${localizer(locale, "commands.config.panel.persona_override_label")}: ${override}
> ${localizer(locale, "commands.config.panel.server_default_label")}: ${serverModel}`,
    });

    if (input.view?.kind === "text-override-provider" && input.view.personaId === personaId) {
      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildConfigRouteId({ action: "text-override-provider-select", locale, personaId }),
            placeholder: localizer(locale, "commands.config.panel.text_override_provider_placeholder"),
            options: input.view.providers.map((provider) => ({
              label: safeSelectOptionText(provider, 100),
              value: provider,
            })),
            disabled: writesDisabled || textState === "disabled",
          },
        ],
      });
    } else if (input.view?.kind === "text-override-model" && input.view.personaId === personaId) {
      const pageSize = 25;
      const pageCount = Math.max(1, Math.ceil(input.view.models.length / pageSize));
      const pageIndex = Math.min(Math.max(Math.floor(input.view.start / pageSize), 0), pageCount - 1);
      const start = pageIndex * pageSize;
      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildConfigRouteId({
              action: "text-override-model-select",
              locale,
              personaId,
              provider: input.view.provider,
            }),
            placeholder: localizer(locale, "commands.config.panel.text_override_model_placeholder"),
            options: input.view.models.slice(start, start + pageSize).map((model) => ({
              label: safeSelectOptionText(model.llm_codename, 100),
              value: model.llm_codename,
              description: model.llm_description ? safeSelectOptionText(model.llm_description, 100) : undefined,
              default: model.llm_id === persona.persona_llm?.llm_id,
            })),
            disabled: writesDisabled || textState === "disabled",
          },
        ],
      });
      if (pageCount > 1) {
        components.push({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildConfigRouteId({
                action: "text-override-model-page",
                locale,
                personaId,
                provider: input.view.provider,
                start: Math.max(0, start - pageSize),
              }),
              label: localizer(locale, "commands.config.panel.previous_page"),
              disabled: writesDisabled || textState === "disabled" || pageIndex === 0,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildConfigRouteId({
                action: "text-override-model-page",
                locale,
                personaId,
                provider: input.view.provider,
                start: Math.min((pageCount - 1) * pageSize, start + pageSize),
              }),
              label: localizer(locale, "commands.config.panel.next_page"),
              disabled: writesDisabled || textState === "disabled" || pageIndex >= pageCount - 1,
            },
          ],
        });
      }
    } else {
      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "text-override-open", locale, personaId }),
            label: localizer(locale, "commands.config.panel.change_override_button"),
            disabled: writesDisabled || textState === "disabled",
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "text-override-clear", locale, personaId }),
            label: localizer(locale, "commands.config.panel.clear_override_button"),
            disabled: writesDisabled || textState === "disabled" || !persona.persona_llm,
          },
        ],
      });
    }
  }

  return components;
}

/**
 * Beside a Thumbnail the panel body wraps at 40 characters, which a stored sprite name (up to 64)
 * or usage note can exceed on its own. Each detail line therefore clamps its value to what is left
 * after its label. `tests/unit/discord/panelProseWidth.test.ts` owns the budget itself.
 */
const SPRITE_DETAIL_LINE_BUDGET = 40;

function spriteDetailLine(label: string, value: string): string {
  const prefix = `> ${label}: `;
  return `${prefix}${safeSelectOptionText(value, Math.max(4, SPRITE_DETAIL_LINE_BUDGET - prefix.length))}`;
}

function spriteRangeIndex(
  totalCount: number,
  requestedStart: number | undefined,
  selectedIndex: number | undefined,
): { rangeCount: number; rangeIndex: number } {
  const rangeCount = Math.max(1, Math.ceil(totalCount / CONFIG_PERSONA_SPRITE_PAGE_SIZE));
  const defaultStart =
    selectedIndex === undefined
      ? 0
      : Math.floor(selectedIndex / CONFIG_PERSONA_SPRITE_PAGE_SIZE) * CONFIG_PERSONA_SPRITE_PAGE_SIZE;
  const requestedRange = Math.floor((requestedStart ?? defaultStart) / CONFIG_PERSONA_SPRITE_PAGE_SIZE);
  return { rangeCount, rangeIndex: Math.min(Math.max(requestedRange, 0), rangeCount - 1) };
}

function buildPersonaSpriteRemoveConfirmBody(
  input: ConfigPanelRenderInput,
  view: Extract<ConfigPanelView, { kind: "sprite-remove-confirm" }>,
): ComponentInContainerData[] {
  const { locale } = input;
  const sprite = input.personaSprites?.[view.index];
  if (!sprite || resolvePersonaSpritesActionState("remove", input.actor) !== "enabled") return [];
  return [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.sprite_remove_title")}
${localizer(locale, "commands.config.panel.sprite_remove_description", {
  sprite: escapeDiscordMarkdown(sprite.sprite_name),
})}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildConfigRouteId({
            action: "sprite-remove-confirm",
            locale,
            personaId: view.personaId,
            index: view.index,
            fp: view.fp,
            nonce: view.nonce,
          }),
          label: localizer(locale, "commands.config.panel.sprite_remove_button"),
          disabled: input.readStatus !== "fresh",
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "sprite-remove-cancel", locale, personaId: view.personaId }),
          label: localizer(locale, "commands.config.panel.cancel_button"),
        },
      ],
    },
  ];
}

function buildPersonaSpritesBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor, personas, selectedPersonaId, readStatus } = input;
  const heading = buildOptionalThumbnailSection(
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.sprites_title")}
${localizer(locale, "commands.config.panel.sprites_description")}`,
    },
    input.selectedPersonaAvatarUrl,
  );

  const persona = personas.find((candidate) => candidate.persona_id === selectedPersonaId) ?? null;
  if (!persona) {
    return [
      heading,
      { type: ComponentType.TextDisplay, content: localizer(locale, "commands.config.panel.no_personas") },
    ];
  }

  const personaId = persona.persona_id as number;
  const writesDisabled = readStatus !== "fresh";
  const actionState = (action: Parameters<typeof resolvePersonaSpritesActionState>[0]) =>
    resolvePersonaSpritesActionState(action, actor);
  const sprites = input.personaSprites ?? [];
  const selectedIndex =
    input.selectedSpriteIndex !== undefined &&
    input.selectedSpriteIndex >= 0 &&
    input.selectedSpriteIndex < sprites.length
      ? input.selectedSpriteIndex
      : undefined;
  const { rangeCount, rangeIndex } = spriteRangeIndex(sprites.length, input.spritePageStart, selectedIndex);
  const start = rangeIndex * CONFIG_PERSONA_SPRITE_PAGE_SIZE;
  const visibleSprites = sprites.slice(start, start + CONFIG_PERSONA_SPRITE_PAGE_SIZE);

  const components: ComponentInContainerData[] = [heading];

  if (sprites.length === 0) {
    components.push({
      type: ComponentType.TextDisplay,
      content: localizer(locale, "commands.config.panel.sprites_none"),
    });
  } else {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.config.panel.sprite_select_prompt"),
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildConfigRouteId({ action: "sprite-select", locale, personaId }),
            placeholder: safeSelectOptionText(
              localizer(locale, "commands.config.panel.sprite_select_placeholder"),
              150,
            ),
            options: visibleSprites.map((sprite, offset) => ({
              label: safeSelectOptionText(sprite.sprite_name, 100),
              value: String(start + offset),
              description: safeSelectOptionText(
                sprite.usage_instructions.trim() || localizer(locale, "commands.config.panel.none_label"),
                100,
              ),
              default: start + offset === selectedIndex,
            })),
            disabled: writesDisabled,
          },
        ],
      },
    );

    const paginationRow = buildPaginationRow({
      locale,
      rangeIndex,
      rangeCount,
      namespace: CONFIG_ROUTE_NAMESPACE,
      version: CONFIG_ROUTE_VERSION,
      buildSegments: {
        page: (targetRangeIndex) =>
          buildConfigRouteSegments({
            action: "sprite-page",
            locale,
            personaId,
            start: targetRangeIndex * CONFIG_PERSONA_SPRITE_PAGE_SIZE,
          }),
      },
      disabled: writesDisabled,
    });
    if (paginationRow) components.push(paginationRow);
  }

  const selectedSprite = selectedIndex === undefined ? undefined : sprites[selectedIndex];
  if (selectedSprite !== undefined && selectedIndex !== undefined) {
    const fp = computeSpriteFingerprint(personaId, selectedIndex, selectedSprite.sprite_key);
    components.push(
      buildOptionalThumbnailSection(
        {
          type: ComponentType.TextDisplay,
          content: `**${localizer(locale, "commands.config.panel.selected_sprite_title")}**
${localizer(locale, "commands.config.panel.selected_sprite_description")}
${spriteDetailLine(localizer(locale, "commands.config.panel.sprite_name_label"), selectedSprite.sprite_name)}
${spriteDetailLine(
  localizer(locale, "commands.config.panel.sprite_usage_label"),
  selectedSprite.usage_instructions.trim() || localizer(locale, "commands.config.panel.none_label"),
)}
${spriteDetailLine(
  localizer(locale, "commands.config.panel.sprite_identity_label"),
  localizer(
    locale,
    selectedSprite.is_identity
      ? "commands.persona.sprites.edit.identity_status_on"
      : "commands.persona.sprites.edit.identity_status_off",
  ),
)}`,
        },
        resolvePersonaAvatarPublicUrl(selectedSprite.avatar_url),
      ),
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "sprite-edit-open", locale, personaId, index: selectedIndex, fp }),
            label: localizer(locale, "commands.config.panel.sprite_edit_button"),
            disabled: writesDisabled || actionState("edit") !== "enabled",
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildConfigRouteId({ action: "sprite-remove-view", locale, personaId, index: selectedIndex, fp }),
            label: localizer(locale, "commands.config.panel.sprite_remove_button"),
            disabled: writesDisabled || actionState("remove") !== "enabled",
          },
        ],
      },
    );
  }

  const addState = actionState("add");
  if (addState !== "omitted") {
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "sprite-add-open", locale, personaId }),
          label: localizer(locale, "commands.config.panel.sprite_add_button"),
          disabled: writesDisabled || addState === "disabled",
        },
      ],
    });
  }

  const importState = actionState("import");
  const exportState = actionState("export");
  const transferButtons: ButtonComponentData[] = [];
  if (importState !== "omitted") {
    transferButtons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: buildConfigRouteId({ action: "sprite-import-open", locale, personaId }),
      label: localizer(locale, "commands.config.panel.sprite_import_button"),
      disabled: writesDisabled || importState === "disabled",
    });
  }
  if (exportState !== "omitted") {
    transferButtons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: buildConfigRouteId({ action: "sprite-export", locale, personaId }),
      label: localizer(locale, "commands.config.panel.sprite_export_button"),
      disabled: writesDisabled || exportState === "disabled" || sprites.length === 0,
    });
  }
  if (transferButtons.length > 0) {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.config.panel.sprite_transfer_title")}**
${localizer(locale, "commands.config.panel.sprite_transfer_description")}`,
      },
      { type: ComponentType.ActionRow, components: transferButtons },
    );
  }

  return components;
}

function buildPersonaMemoriesBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor, personas, selectedPersonaId, readStatus } = input;
  const persona = personas.find((candidate) => candidate.persona_id === selectedPersonaId) ?? null;
  const view = input.personaMemoryView;
  const writesDisabled = readStatus !== "fresh";
  const personaId = persona?.persona_id as number;
  const serverMemoryState = resolvePersonaMemoriesActionState("server-memory-open", actor);
  const personalMemoryState = resolvePersonaMemoriesActionState("personal-memory-open", actor);
  const stmEditState = resolvePersonaMemoriesActionState("stm-edit", actor);
  const conditioningState = resolvePersonaMemoriesActionState("conditioning", actor);

  const heading: TextDisplayComponentData = {
    type: ComponentType.TextDisplay,
    content: `### ${localizer(locale, "commands.config.panel.memories_title")}
${localizer(locale, "commands.config.panel.memories_description")}`,
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

  const serverMemoryButton = {
    type: ComponentType.Button,
    style: ButtonStyle.Secondary,
    customId: buildConfigRouteId({ action: "server-memory-open", locale, personaId }),
    label: localizer(locale, "commands.config.panel.open_server_memories_button"),
    disabled: writesDisabled || serverMemoryState !== "enabled" || !persona.persona_lineage_id,
  } satisfies ButtonComponentData;
  const personalMemoryButton = {
    type: ComponentType.Button,
    style: ButtonStyle.Secondary,
    customId: buildConfigRouteId({ action: "personal-memory-open", locale, personaId }),
    label: localizer(locale, "commands.config.panel.open_personal_memories_button"),
    disabled: writesDisabled || personalMemoryState !== "enabled" || !persona.persona_lineage_id,
  } satisfies ButtonComponentData;
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `${localizer(locale, "commands.config.panel.long_term_title")}
${localizer(locale, "commands.config.panel.long_term_description")}
${withLinePrefix(
  "> ",
  localizer(locale, "commands.config.panel.server_memory_count", {
    count: String(view?.serverMemoryCount ?? 0),
  }),
)}
${withLinePrefix(
  "> ",
  localizer(locale, "commands.config.panel.personal_memory_count", {
    count: String(view?.personalMemoryCount ?? 0),
  }),
)}`,
    },
    { type: ComponentType.ActionRow, components: [serverMemoryButton, personalMemoryButton] },
    {
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.long_term_footer")),
    },
  );

  const categoryRows = view?.stmCategories ?? [];
  const slugMap = buildSlugMap(categoryRows);
  const isCategoryMode = !(categoryRows.length === 1 && categoryRows[0]?.label.toLowerCase() === "summary");
  const entry = view?.stmEntry;
  const stmSections: string[] = [];
  if (isCategoryMode) {
    for (const [slug, label] of slugMap) {
      const value = entry?.categories?.[slug]?.trim();
      if (value) stmSections.push(`**${label}:**\n${value}`);
    }
  } else if (entry?.summary?.trim()) {
    stmSections.push(entry.summary.trim());
  }
  const channelText = view?.channelId
    ? localizer(locale, "commands.config.panel.stm_active_channel", { channel: `<#${view.channelId}>` })
    : localizer(locale, "commands.config.panel.stm_no_channel");
  const stmHeader = `${localizer(locale, "commands.config.panel.stm_title")}
${localizer(locale, "commands.config.panel.stm_description")}
${withLinePrefix("> ", channelText)}
`;
  const stmContent =
    stmSections.length > 0
      ? renderStmContent(locale, stmSections.join("\n\n"), Math.max(0, 3800 - stmHeader.length))
      : `> ${localizer(locale, "commands.config.panel.stm_empty")}`;
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `${stmHeader}${stmContent}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "stm-edit-open", locale, personaId }),
          label: localizer(locale, "commands.config.panel.stm_edit_button"),
          disabled: writesDisabled || stmEditState !== "enabled" || !view?.channelId,
        },
      ],
    },
  );

  if (input.actor.workspaceKind === "guild") {
    const conditioningGroups = (view?.conditioningGroups ?? []).filter((group) => group.reasonText.trim().length > 0);
    const groupLines = conditioningGroups.map((group) => {
      const actionLabel = localizer(locale, `commands.${group.conditioningType}.${group.actionKey}.history_label`);
      return `> ${actionLabel}: ${escapeDiscordMarkdown(group.reasonText)} (${group.totalCount})`;
    });
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `${localizer(locale, "commands.config.panel.conditioning_title")}
${localizer(locale, "commands.config.panel.conditioning_description")}
${groupLines.length > 0 ? groupLines.join("\n") : `> ${localizer(locale, "commands.config.panel.conditioning_none")}`}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "conditioning-open", locale, personaId }),
            label: localizer(locale, "commands.config.panel.conditioning_manage_button"),
            disabled: writesDisabled || conditioningState !== "enabled" || conditioningGroups.length === 0,
          },
        ],
      },
      {
        type: ComponentType.TextDisplay,
        content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.conditioning_footer")),
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

function behaviorHeading(locale: string, titleKey: string, descriptionKey: string): ComponentInContainerData {
  return {
    type: ComponentType.TextDisplay,
    content: `### ${localizer(locale, titleKey)}\n${localizer(locale, descriptionKey)}`,
  };
}

function buildBehaviorGeneralBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale } = input;
  const view = input.behaviorView?.general;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    behaviorHeading(
      locale,
      "commands.config.panel.behavior_general_title",
      "commands.config.panel.behavior_general_description",
    ),
  ];

  if (input.actor.workspaceKind === "guild" && !input.actor.isManager) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only")),
    });
    return components;
  }
  if (!view) return components;

  const prompt = view.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT.trim();
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.system_prompt_title")}**\n${localizer(
        locale,
        "commands.config.panel.system_prompt_description",
      )}\n${renderFencedCollectionContent(prompt)}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-prompt-open", locale }),
          label: localizer(locale, "commands.config.panel.set_prompt_button"),
          disabled: writesDisabled,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-preset-open", locale }),
          label: localizer(locale, "commands.config.panel.apply_preset_button"),
          disabled: writesDisabled,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildConfigRouteId({ action: "behavior-prompt-remove", locale }),
          label: localizer(locale, "commands.config.panel.remove_prompt_button"),
          disabled: writesDisabled || !view.systemPrompt,
        },
      ],
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.context_note_title")}**\n${localizer(
        locale,
        "commands.config.panel.global_context_note_description",
      )}\n${renderFencedCollectionContent(view.contextNote ?? localizer(locale, "commands.config.panel.none_label"))}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-context-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_context_note_button"),
          disabled: writesDisabled,
        },
      ],
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.response_style_title")}**\n${localizer(
        locale,
        "commands.config.panel.global_response_style_description",
      )}\n> ${localizer(locale, "commands.config.panel.humanizer_label")}: ${getHumanizerLabel(
        locale,
        view.humanizerDegree,
      )}\n> ${localizer(locale, "commands.config.panel.message_fetch_limit_label")}: ${view.messageFetchLimit}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-humanizer-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_humanizer_button"),
          disabled: writesDisabled,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-fetch-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_fetch_limit_button"),
          disabled: writesDisabled,
        },
      ],
    },
  );

  if (input.actor.workspaceKind === "guild") {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.config.panel.server_timezone_title")}**\n${localizer(
          locale,
          "commands.config.panel.server_timezone_description",
        )}\n> ${localizer(locale, "commands.config.panel.utc_offset_label")}: ${formatUTCOffset(view.timezoneOffset)}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "behavior-timezone-open", locale }),
            label: localizer(locale, "commands.config.panel.change_timezone_button"),
            disabled: writesDisabled || resolveBehaviorGeneralActionState("timezone", input.actor) !== "enabled",
          },
        ],
      },
    );
  }
  return components;
}

function cooldownLabel(locale: string, value: number): string {
  const key =
    value === CooldownType.PER_USER
      ? "commands.config.panel.cooldown_per_user"
      : value === CooldownType.PER_CHANNEL
        ? "commands.config.panel.cooldown_per_channel"
        : value === CooldownType.SERVER_WIDE
          ? "commands.config.panel.cooldown_server_wide"
          : "commands.config.panel.cooldown_off";
  return localizer(locale, key);
}

function buildBehaviorTriggerBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale } = input;
  const view = input.behaviorView?.trigger;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    behaviorHeading(
      locale,
      "commands.config.panel.behavior_trigger_title",
      "commands.config.panel.behavior_trigger_description",
    ),
  ];
  if (input.actor.workspaceKind === "guild" && !input.actor.isManager) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only")),
    });
    return components;
  }
  if (!view) return components;

  const personaById = new Map(
    input.personas.flatMap((persona) =>
      persona.persona_id === undefined ? [] : [[persona.persona_id, persona.persona_nickname] as const],
    ),
  );
  const triggerPageCount = Math.ceil(view.randomTriggers.length / RANDOM_TRIGGER_PAGE_SIZE);
  const selectedTriggerPage = Math.min(
    Math.max(Math.floor((input.randomTriggerPageStart ?? 0) / RANDOM_TRIGGER_PAGE_SIZE), 0),
    Math.max(triggerPageCount - 1, 0),
  );
  const visibleTriggers = view.randomTriggers.slice(
    selectedTriggerPage * RANDOM_TRIGGER_PAGE_SIZE,
    (selectedTriggerPage + 1) * RANDOM_TRIGGER_PAGE_SIZE,
  );
  const remainingTriggerCount = Math.max(
    0,
    view.randomTriggers.length - (selectedTriggerPage + 1) * RANDOM_TRIGGER_PAGE_SIZE,
  );
  const triggerSummary = visibleTriggers.length
    ? visibleTriggers
        .map((trigger) => {
          const persona =
            trigger.persona_id === null || trigger.persona_id === undefined
              ? localizer(locale, "commands.config.panel.random_persona_label")
              : (personaById.get(trigger.persona_id) ?? localizer(locale, "general.unknown"));
          return `> <#${trigger.channel_disc_id}> · ${persona} · ${trigger.timer_hours}h · ${trigger.chance_percent}%`;
        })
        .join("\n") +
      (remainingTriggerCount > 0
        ? `\n> ${localizer(locale, "commands.config.panel.random_trigger_more", {
            count: remainingTriggerCount,
          })}`
        : "")
    : `> ${localizer(locale, "commands.config.panel.none_label")}`;
  const triggerPageNavigation: ComponentInContainerData[] = [];
  if (triggerPageCount > 1) {
    triggerPageNavigation.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildConfigRouteId({ action: "behavior-random-remove-select", locale }),
          placeholder: localizer(locale, "commands.config.panel.random_trigger_page_placeholder"),
          options: Array.from(
            {
              length: Math.min(
                triggerPageCount -
                  Math.floor(selectedTriggerPage / CONFIG_PERSONA_SELECT_PAGE_SIZE) * CONFIG_PERSONA_SELECT_PAGE_SIZE,
                CONFIG_PERSONA_SELECT_PAGE_SIZE,
              ),
            },
            (_page, offset) => {
              const page =
                Math.floor(selectedTriggerPage / CONFIG_PERSONA_SELECT_PAGE_SIZE) * CONFIG_PERSONA_SELECT_PAGE_SIZE +
                offset;
              const start = page * RANDOM_TRIGGER_PAGE_SIZE;
              const end = Math.min(start + RANDOM_TRIGGER_PAGE_SIZE, view.randomTriggers.length);
              return {
                label: safeSelectOptionText(
                  localizer(locale, "commands.config.panel.random_trigger_page_option", {
                    first: start + 1,
                    last: end,
                  }),
                  100,
                ),
                value: String(start),
                default: page === selectedTriggerPage,
              };
            },
          ),
          disabled: writesDisabled,
        } satisfies StringSelectMenuComponentData,
      ],
    } satisfies ActionRowData<StringSelectMenuComponentData>);

    const paginationRow = buildPaginationRow({
      locale,
      rangeIndex: Math.floor(selectedTriggerPage / CONFIG_PERSONA_SELECT_PAGE_SIZE),
      rangeCount: Math.max(1, Math.ceil(triggerPageCount / CONFIG_PERSONA_SELECT_PAGE_SIZE)),
      namespace: CONFIG_ROUTE_NAMESPACE,
      version: CONFIG_ROUTE_VERSION,
      buildSegments: {
        page: (targetRangeIndex) =>
          buildConfigRouteSegments({
            action: "behavior-random-remove-page",
            locale,
            start: targetRangeIndex * CONFIG_PERSONA_SELECT_PAGE_SIZE * RANDOM_TRIGGER_PAGE_SIZE,
          }),
      },
      disabled: writesDisabled,
    });
    if (paginationRow) triggerPageNavigation.push(paginationRow);
  }
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.random_triggers_title")}**\n${localizer(
        locale,
        "commands.config.panel.random_triggers_description",
      )}\n${triggerSummary}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-random-add-open", locale }),
          label: localizer(locale, "commands.config.panel.add_random_trigger_button"),
          disabled: writesDisabled,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildConfigRouteId({
            action: "behavior-random-remove-open",
            locale,
            ...(selectedTriggerPage > 0 ? { start: selectedTriggerPage * RANDOM_TRIGGER_PAGE_SIZE } : {}),
          }),
          label: localizer(locale, "commands.config.panel.remove_random_trigger_button"),
          disabled: writesDisabled || view.randomTriggers.length === 0,
        },
      ],
    },
    ...triggerPageNavigation,
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.trigger_matching_title")}**\n${localizer(
        locale,
        "commands.config.panel.trigger_matching_description",
      )}\n> ${localizer(locale, "commands.config.panel.cascade_limit_label")}: ${view.cascadeLimit}\n> ${localizer(
        locale,
        "commands.config.panel.match_limit_label",
      )}: ${view.matchLimit}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-limits-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_matching_limits_button"),
          disabled: writesDisabled,
        },
      ],
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.deliberate_trigger_mode_title")}**\n${localizer(
        locale,
        "commands.config.panel.deliberate_trigger_mode_description",
      )}`,
    },
    buildStateControlRow(
      [
        {
          value: false,
          label: localizer(locale, "commands.config.panel.off_button"),
          customId: buildConfigRouteId({ action: "behavior-dtm-set", locale, enabled: false }),
        },
        {
          value: true,
          label: localizer(locale, "commands.config.panel.on_button"),
          customId: buildConfigRouteId({ action: "behavior-dtm-set", locale, enabled: true }),
        },
      ],
      view.deliberateTriggerMode,
      writesDisabled,
    ),
    {
      type: ComponentType.TextDisplay,
      content: `> ${localizer(
        locale,
        view.deliberateTriggerMode
          ? "commands.config.panel.deliberate_trigger_mode_on"
          : "commands.config.panel.deliberate_trigger_mode_off",
      )}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.always_reply_title")}**\n${localizer(
        locale,
        "commands.config.panel.always_reply_description",
      )}`,
    },
    buildStateControlRow(
      [
        {
          value: false,
          label: localizer(locale, "commands.config.panel.off_button"),
          customId: buildConfigRouteId({ action: "behavior-always-set", locale, enabled: false }),
        },
        {
          value: true,
          label: localizer(locale, "commands.config.panel.on_button"),
          customId: buildConfigRouteId({ action: "behavior-always-set", locale, enabled: true }),
        },
      ],
      view.alwaysReplyEnabled,
      writesDisabled,
    ),
    {
      type: ComponentType.TextDisplay,
      content: `> ${localizer(
        locale,
        view.alwaysReplyEnabled ? "commands.config.panel.always_reply_on" : "commands.config.panel.always_reply_off",
      )}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.trigger_cooldown_title")}**\n${localizer(
        locale,
        "commands.config.panel.trigger_cooldown_description",
      )}\n> ${cooldownLabel(locale, view.cooldownType)} · ${view.cooldownLength}s`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-cooldown-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_cooldown_button"),
          disabled: writesDisabled,
        },
      ],
    },
  );
  return components;
}

function buildBehaviorExperimentalBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale } = input;
  const view = input.behaviorView?.experimental;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    behaviorHeading(
      locale,
      "commands.config.panel.behavior_experimental_title",
      "commands.config.panel.behavior_experimental_description",
    ),
  ];
  if (input.actor.workspaceKind === "guild" && !input.actor.isManager) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only")),
    });
    return components;
  }
  if (!view) return components;

  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**[${localizer(locale, "commands.config.panel.deliberate_tool_mode_title")}](https://docs.tomoribot.app/en/features/capabilities/tools-and-extensions/#deliberate-tool-mode)**\n${localizer(locale, "commands.config.panel.deliberate_tool_mode_description")}`,
    },
    buildStateControlRow(
      [
        {
          value: false,
          label: localizer(locale, "commands.config.panel.off_button"),
          customId: buildConfigRouteId({ action: "behavior-tool-mode-set", locale, enabled: false }),
        },
        {
          value: true,
          label: localizer(locale, "commands.config.panel.on_button"),
          customId: buildConfigRouteId({ action: "behavior-tool-mode-set", locale, enabled: true }),
        },
      ],
      view.deliberateToolMode,
      writesDisabled,
    ),
    {
      type: ComponentType.TextDisplay,
      content: `> ${localizer(
        locale,
        view.deliberateToolMode
          ? "commands.config.panel.deliberate_tool_mode_on"
          : "commands.config.panel.deliberate_tool_mode_off",
      )}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.tool_context_title")}**\n${localizer(locale, "commands.config.panel.tool_context_description")}\n> ${localizer(
        locale,
        view.deliberateToolContextTurns === 0
          ? "commands.config.panel.tool_context_zero"
          : "commands.config.panel.tool_context_value",
        { count: view.deliberateToolContextTurns },
      )}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-tool-context-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_tool_context_button"),
          disabled: writesDisabled,
        },
      ],
    },
  );

  const triggerCount = Object.values(view.deliberateToolTriggers).reduce(
    (count, triggers) => count + (Array.isArray(triggers) ? triggers.length : 0),
    0,
  );
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.custom_tool_triggers_title")}**\n${localizer(locale, "commands.config.panel.custom_tool_triggers_description")}\n> ${
        triggerCount
          ? localizer(locale, "commands.config.panel.custom_tool_triggers_value", { count: triggerCount })
          : localizer(locale, "commands.choices.none")
      }`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-tool-trigger-add-open", locale }),
          label: localizer(locale, "commands.config.panel.add_tool_trigger_button"),
          disabled: writesDisabled,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-tool-trigger-remove-open", locale }),
          label: localizer(locale, "commands.config.panel.remove_tool_triggers_button"),
          disabled: writesDisabled,
        },
      ],
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.delivery_limits_title")}**\n${localizer(locale, "commands.config.panel.delivery_limits_description")}\n> ${
        view.sendLimit > 0
          ? localizer(locale, "commands.config.panel.delivery_limits_value", { count: view.sendLimit })
          : localizer(locale, "commands.config.panel.delivery_limits_unlimited")
      }`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-send-limit-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_send_limit_button"),
          disabled: writesDisabled,
        },
      ],
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.self_debug_title")}**\n${localizer(locale, "commands.config.panel.self_debug_description")}`,
    },
    buildStateControlRow(
      [
        {
          value: false,
          label: localizer(locale, "commands.config.panel.off_button"),
          customId: buildConfigRouteId({ action: "behavior-self-debug-set", locale, enabled: false }),
        },
        {
          value: true,
          label: localizer(locale, "commands.config.panel.on_button"),
          customId: buildConfigRouteId({ action: "behavior-self-debug-set", locale, enabled: true }),
        },
      ],
      view.selfDebugEnabled,
      writesDisabled,
    ),
    {
      type: ComponentType.TextDisplay,
      content: `> ${localizer(
        locale,
        view.selfDebugEnabled ? "commands.config.panel.self_debug_on" : "commands.config.panel.self_debug_off",
      )}`,
    },
  );

  const workaroundLines = WORKAROUND_DEFINITIONS.map((definition) => {
    const enabled = definition.getState(view.workarounds);
    const key =
      definition.value === "verbatim_tool_calling"
        ? enabled
          ? "commands.config.workarounds.verbatim_tool_calling_enabled"
          : "commands.config.workarounds.verbatim_tool_calling_disabled"
        : definition.descKey;
    return `> ${enabled ? "🟢" : "🔴"} ${localizer(locale, key)}`;
  });
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.compatibility_title")}**\n${localizer(locale, "commands.config.panel.compatibility_description")}\n${workaroundLines.join("\n")}\n${withLinePrefix("-# ", localizer(locale, "commands.config.panel.custom_provider_limitation"))}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-workarounds-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_workarounds_button"),
          disabled: writesDisabled,
        },
      ],
    },
  );
  return components;
}

function buildBehaviorNoticesBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale } = input;
  const view = input.behaviorView?.notices;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    behaviorHeading(
      locale,
      "commands.config.panel.behavior_notices_title",
      "commands.config.panel.behavior_notices_description",
    ),
  ];
  if (!view) return components;
  if (input.actor.workspaceKind === "guild" && !input.actor.isManager) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only")),
    });
    return components;
  }
  const hiddenSet = new Set(view.hiddenNoticeKeys);
  const visible = TOOL_NOTICE_DEFINITIONS.filter((definition) => !hiddenSet.has(definition.key)).map((definition) =>
    localizer(locale, definition.labelKey),
  );
  const hidden = TOOL_NOTICE_DEFINITIONS.filter((definition) => hiddenSet.has(definition.key)).map((definition) =>
    localizer(locale, definition.labelKey),
  );
  const visibleLines = visible.length
    ? visible
        .map((notice) => `> ${localizer(locale, "commands.config.panel.visible_notices_label")}: ${notice}`)
        .join("\n")
    : `> ${localizer(locale, "commands.config.panel.visible_notices_label")}: ${localizer(locale, "commands.choices.none")}`;
  const hiddenLines = hidden.length
    ? hidden
        .map((notice) => `> ${localizer(locale, "commands.config.panel.hidden_notices_label")}: ${notice}`)
        .join("\n")
    : `> ${localizer(locale, "commands.config.panel.hidden_notices_label")}: ${localizer(locale, "commands.choices.none")}`;
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.notice_embeds_title")}**\n${localizer(locale, "commands.config.panel.notice_embeds_description")}\n${visibleLines}\n${hiddenLines}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-notice-visibility-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_notice_visibility_button"),
          disabled: writesDisabled,
        },
      ],
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.speech_transcripts_title")}**\n${localizer(locale, "commands.config.panel.speech_transcripts_description")}`,
    },
    buildStateControlRow(
      [
        {
          value: false,
          label: localizer(locale, "commands.config.panel.off_button"),
          customId: buildConfigRouteId({ action: "behavior-speech-transcripts-set", locale, enabled: false }),
        },
        {
          value: true,
          label: localizer(locale, "commands.config.panel.on_button"),
          customId: buildConfigRouteId({ action: "behavior-speech-transcripts-set", locale, enabled: true }),
        },
      ],
      view.speechTranscriptsEnabled,
      writesDisabled,
    ),
    {
      type: ComponentType.TextDisplay,
      content: `> ${localizer(locale, view.speechTranscriptsEnabled ? "commands.config.panel.speech_transcripts_on" : "commands.config.panel.speech_transcripts_off")}\n${withLinePrefix("-# ", localizer(locale, "commands.config.panel.speech_provider_direction"))}`,
    },
  );
  return components;
}

function buildBehaviorMemoryBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale } = input;
  const view = input.behaviorView?.memory;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    behaviorHeading(
      locale,
      "commands.config.panel.behavior_memory_title",
      "commands.config.panel.behavior_memory_description",
    ),
    {
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.memory_direction")),
    },
  ];
  if (input.actor.workspaceKind === "guild" && !input.actor.isManager) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only")),
    });
    return components;
  }
  if (!view) return components;
  const categoryMode =
    view.stmCategories.length > 1 ||
    (view.stmCategories.length === 1 && view.stmCategories[0]?.label.toLowerCase() !== "summary");
  const categoryLines = view.stmCategories.length
    ? view.stmCategories
        .map((category) => `> ${safeSelectOptionText(`${category.label}: ${category.description}`, 62)}`)
        .join("\n")
    : `> ${localizer(locale, "commands.choices.none")}`;
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**[${localizer(locale, "commands.config.panel.memory_tagging_title")}](https://docs.tomoribot.app/en/features/knowledge/memory/#controlling-when-memories-activate)**\n${localizer(locale, "commands.config.panel.memory_tagging_description")}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: `> ${localizer(locale, view.memoryTaggingEnabled ? "commands.config.panel.memory_tagging_on" : "commands.config.panel.memory_tagging_off")}\n> ${localizer(locale, "commands.config.panel.channel_memory_title")}: ${localizer(locale, view.channelMemoryEnabled ? "commands.config.panel.enabled_option" : "commands.config.panel.disabled_option")}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.channel_memory_description")),
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-memory-tagging-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_memory_tagging_button"),
          disabled: writesDisabled,
        },
      ],
    },
    {
      type: ComponentType.TextDisplay,
      content: `**[${localizer(locale, "commands.config.panel.stm_parameters_title")}](https://docs.tomoribot.app/en/features/knowledge/memory/#stm-configuration)**\n${localizer(locale, "commands.config.panel.stm_parameters_description")}\n> ${localizer(locale, "commands.config.panel.stm_refresh_cadence_value", { count: view.stmConfig?.refresh_cadence ?? 5 })}\n> ${localizer(locale, "commands.config.panel.stm_render_mode_value", { mode: view.stmConfig?.render_mode ?? "supersede" })}\n> ${localizer(locale, "commands.config.panel.stm_crude_messages_value", { count: view.stmConfig?.crude_message_count ?? 6 })}\n> ${localizer(locale, "commands.config.panel.stm_nudge_depth_value", { count: view.stmConfig?.nudge_injection_depth ?? 2 })}\n> ${localizer(locale, "commands.config.panel.stm_content_depth_value", { count: view.stmConfig?.content_injection_depth ?? -1 })}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-stm-parameters-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_stm_parameters_button"),
          disabled: writesDisabled,
        },
      ],
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.stm_categories_title")}**\n${localizer(locale, "commands.config.panel.stm_categories_description")}\n${categoryLines}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-stm-categories-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_stm_categories_button"),
          disabled: writesDisabled,
        },
      ],
    },
  );
  const toolDescription = view.stmConfig?.tool_description_override ?? DEFAULT_STM_TOOL_DESCRIPTION;
  const updateNudge =
    view.stmConfig?.update_nudge_override ?? (categoryMode ? SEED_CATEGORY_UPDATE_HINT : SEED_SUMMARY_UPDATE_HINT);
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.stm_prompt_title")}**\n${localizer(locale, "commands.config.panel.stm_prompt_description")}\n${renderStmContent(locale, toolDescription)}\n${renderStmContent(locale, updateNudge)}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "behavior-stm-prompt-open", locale }),
          label: localizer(locale, "commands.config.panel.edit_stm_prompt_button"),
          disabled: writesDisabled,
        },
      ],
    },
  );
  return components;
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

  if (input.view && input.view.kind === "character-reference-clear-confirm") {
    components.push(...buildPersonaCharacterReferenceClearBody(input, input.view));
    return buildPayload(components, receipt);
  }

  if (input.view && input.view.kind === "sprite-remove-confirm") {
    components.push(...buildPersonaSpriteRemoveConfirmBody(input, input.view));
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "general") {
    components.push(...buildPersonaGeneralBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "memories") {
    components.push(...buildPersonaMemoriesBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "sprites") {
    components.push(...buildPersonaSpritesBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "advanced") {
    if (resolveConfigPageState(category, page, actor) !== "omitted") {
      components.push(...buildPersonaAdvancedBody(input));
    }
    return buildPayload(components, receipt);
  }

  if (category === "models") {
    if (resolveConfigPageState(category, page, actor) !== "omitted") {
      components.push(
        ...buildConfigModelsBody({
          locale,
          page,
          readStatus,
          switchView: input.switchModelsView,
          parametersView: input.modelParametersView,
          fallbacksView: input.modelFallbacksView,
          imageView: input.imageGenerationView,
          modelListView: input.modelListView,
        }),
      );
    }
    return buildPayload(components, receipt);
  }

  if (category === "behavior" && page === "general") {
    components.push(...buildBehaviorGeneralBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "behavior" && page === "trigger") {
    components.push(...buildBehaviorTriggerBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "behavior" && page === "experimental") {
    components.push(...buildBehaviorExperimentalBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "behavior" && page === "notices") {
    components.push(...buildBehaviorNoticesBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "behavior" && page === "memory") {
    components.push(...buildBehaviorMemoryBody(input));
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
