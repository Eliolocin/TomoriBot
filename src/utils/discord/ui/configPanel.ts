import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  AttachmentBuilder,
  inlineCode,
  MessageFlags,
  SelectMenuDefaultValueType,
  type ActionRowData,
  type ButtonComponentData,
  type ChannelSelectMenuComponentData,
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
  CONFIG_MODEL_PAGE_SIZE,
  DEFAULT_PAGE_FOR_CONFIG_CATEGORY,
  buildConfigRouteId,
  buildConfigRouteSegments,
  computeAttributeFingerprint,
  computeChannelOverridesFingerprint,
  computeDialogueFingerprint,
  computeSpriteFingerprint,
  type ConfigCategory,
  type ConfigPage,
} from "@/utils/discord/configPanelCatalog";
import {
  resolveConfigPageState,
  resolvePersonaAdvancedActionState,
  resolvePersonaOverridesActionState,
  resolvePersonaMemoriesActionState,
  resolvePersonaCollectionActionState,
  resolvePersonaGeneralActionState,
  resolvePersonaSpritesActionState,
  resolveBehaviorGeneralActionState,
  resolveChannelsDestinationsActionState,
  resolveChannelsAutoTriggerActionState,
  resolveChannelsRulesActionState,
  resolveChannelsOverridesActionState,
  resolvePermissionsCapabilitiesActionState,
  resolvePermissionsPrivacyActionState,
  resolvePluginsContextAdditionsActionState,
  visibleConfigCategories,
  visibleConfigPages,
  type ConfigActor,
} from "@/utils/discord/interactions/configPermissionPolicy";
import { CHECKLIST_CHANNELS_PER_PAGE } from "@/utils/discord/channelChecklistManager";
import {
  createHumanizerOptions,
  getHumanizerLabel,
  HUMANIZER_DEFAULT,
  HUMANIZER_INHERIT_VALUE,
} from "@/utils/discord/humanizerOptions";
import type {
  ConfigChannelsView,
  ConfigChannelsOverridesView,
  ConfigBehaviorTriggerView,
  ConfigBehaviorView,
  ConfigPermissionsView,
  ConfigPersonaMemoryView,
} from "@/utils/discord/interactions/configRouteContext";
import {
  buildCategoryButtonRow,
  buildOptionalThumbnailSection,
  buildPaginationRow,
  buildRangeSelectOptions,
  buildStateControlRow,
  buildPanelContainer,
  buildPanelReceiptContainer,
  withLinePrefix,
} from "@/utils/discord/ui/panel";
import { RANDOM_TRIGGER_ADD_PERSONA_PAGE_SIZE } from "@/utils/discord/ui/configBehaviorModals";
import {
  AUTO_TRIGGER_PERSONA_PAGE_SIZE,
  selectablePersonas,
  WELCOME_PERSONA_PAGE_SIZE,
} from "@/utils/discord/ui/configChannelModals";
import {
  buildConfigModelsBody,
  type ConfigFallbacksView,
  type ConfigImageGenerationView,
  type ConfigParametersView,
  type ConfigSwitchModelsView,
  type ConfigVoicesView,
} from "@/utils/discord/ui/configModelsPanel";
import { resolveSelectedVoiceSample } from "@/utils/discord/ui/configVoicesPanel";
import { TOOL_NOTICE_DEFINITIONS } from "@/constants/toolNotices";
import { WORKAROUND_DEFINITIONS } from "@/utils/discord/workaroundConfigMapping";
import { DEFAULT_STM_TOOL_DESCRIPTION } from "@/tools/functionCalls/updateShortTermMemoryTool";
import { SEED_CATEGORY_UPDATE_HINT, SEED_SUMMARY_UPDATE_HINT } from "@/utils/text/context/memories";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { escapeDiscordMarkdown } from "@/utils/text/discordMarkdown";
import { localizer } from "@/utils/text/localizer";
import { normalizeTriggerWord } from "@/utils/text/triggerWords";
import { buildSlugMap } from "@/utils/text/slugifyLabel";
import {
  DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX,
  getDiscordTextLength,
  measureComponentTextLength,
  truncateDiscordText,
} from "@/utils/discord/ui/componentsV2Limits";
import { FENCE_GUARD, neutralizeFenceRuns } from "@/utils/text/discordTextLimits";
import { DEFAULT_SYSTEM_PROMPT } from "@/utils/text/contextBuilder";
import { formatUTCOffset } from "@/utils/text/timezoneHelper";
import { getCapabilitiesManagePermissionDefinitions } from "@/utils/discord/manageConfigMapping";
import { buildDocsUrl, DOCS_PATHS } from "@/utils/discord/docsLinks";
import {
  buildConfigVoiceBody,
  type ConfigPersonaVoiceRemoteView,
  type ConfigPersonaVoiceRenderView,
} from "@/utils/discord/ui/configVoicePanel";

const RANDOM_TRIGGER_PAGE_SIZE = CONFIG_RANDOM_TRIGGER_CHECKBOX_CAPACITY;

export interface ConfigPanelPayload {
  components: TopLevelComponentData[];
  files: AttachmentBuilder[];
  flags: MessageFlags.IsComponentsV2;
}

export type ConfigPanelView =
  | { kind: "main" }
  | { kind: "promote-confirm"; personaId: number; nonce: string }
  | { kind: "character-reference-clear-confirm"; personaId: number; nonce: string }
  | { kind: "sprite-remove-confirm"; personaId: number; index: number; fp: string; nonce: string }
  | { kind: "voice-sample-remove-confirm"; index: number; fp: string; nonce: string }
  | { kind: "humanizer-editor"; personaId: number }
  | { kind: "text-override-provider"; personaId: number; providers: string[] }
  | {
      kind: "text-override-model";
      personaId: number;
      provider: string;
      models: LlmRow[];
      start: number;
    }
  | {
      kind: "channel-text-override-provider";
      channelId: string;
      fp: string;
      providers: string[];
    }
  | {
      kind: "channel-text-override-model-range";
      channelId: string;
      fp: string;
      provider: string;
      modelCount: number;
      rangePageIndex: number;
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
    triggers: "commands.config.panel.page_persona_triggers",
    memories: "commands.config.panel.page_persona_memories",
    appearance: "commands.config.panel.page_persona_appearance",
    advanced: "commands.config.panel.page_persona_advanced",
    overrides: "commands.config.panel.page_persona_overrides",
    naming: "commands.config.panel.page_persona_naming",
    sprites: "commands.config.panel.page_persona_sprites",
    voice: "commands.config.panel.page_persona_voice",
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
  plugins: {
    "available-tools": "commands.config.panel.page_plugins_available_tools",
    "context-additions": "commands.config.panel.page_plugins_context_additions",
  },
  models: {
    switch: "commands.config.panel.page_models_switch",
    parameters: "commands.config.panel.page_models_parameters",
    fallbacks: "commands.config.panel.page_models_fallbacks",
    image: "commands.config.panel.page_models_image",
    voices: "commands.config.panel.page_models_voices",
  },
};

const CATEGORY_LOCALE_KEYS: Record<ConfigCategory, string> = {
  persona: "commands.config.panel.category_persona",
  behavior: "commands.config.panel.category_behavior",
  channels: "commands.config.panel.category_channels",
  plugins: "commands.config.panel.category_plugins",
  models: "commands.config.panel.category_models",
};

const NAMING_STYLE_LOCALE_KEYS: Record<AddressingStyle, string> = {
  masculine: "commands.config.panel.style_masculine",
  feminine: "commands.config.panel.style_feminine",
  neutral: "commands.config.panel.style_neutral",
};

const NAMING_STYLE_DESCRIPTION_LOCALE_KEYS: Record<AddressingStyle, string> = {
  masculine: "commands.config.panel.naming_description_masculine",
  feminine: "commands.config.panel.naming_description_feminine",
  neutral: "commands.config.panel.naming_description_neutral",
};

export interface ConfigPanelRenderInput {
  locale: string;
  actor: ConfigActor;
  category: ConfigCategory;
  page: ConfigPage;
  personas: TomoriState[];
  selectedPersonaId: number | null;
  selectedPersonaAvatarUrl?: string | null;
  selectedPersonaCharacterReferenceUrl?: string | null;
  selectedSpriteAvatarUrl?: string | null;
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
  personaVoiceView?: ConfigPersonaVoiceRenderView;
  personaVoiceRemoteView?: ConfigPersonaVoiceRemoteView;
  personaVoicePageStart?: number;
  switchModelsView?: ConfigSwitchModelsView;
  modelParametersView?: ConfigParametersView;
  modelFallbacksView?: ConfigFallbacksView;
  imageGenerationView?: ConfigImageGenerationView;
  voicesView?: ConfigVoicesView;
  randomTriggerPageStart?: number;
  randomTriggerRemoveMode?: boolean;
  behaviorView?: ConfigBehaviorView;
  permissionsView?: ConfigPermissionsView;
  channelsView?: ConfigChannelsView;
  channelsSelectedChannelId?: string | null;
  channelsAutoTriggerRangeIndex?: number;
  channelsPrivateRangeIndex?: number;
  channelsRoleplayRangeIndex?: number;
  channelsBlocklistRangeIndex?: number;
}

function buildPayload(
  components: ComponentInContainerData[],
  receipt?: PanelReceipt,
  files: AttachmentBuilder[] = [],
): ConfigPanelPayload {
  return {
    components: [buildPanelContainer(components), ...(receipt ? [buildPanelReceiptContainer(receipt)] : [])],
    files,
    flags: MessageFlags.IsComponentsV2,
  };
}

function buildVoiceSampleFiles(view: ConfigVoicesView | undefined): AttachmentBuilder[] {
  const selected = view ? resolveSelectedVoiceSample(view) : null;
  const buffer = selected?.preview?.buffer;
  if (!buffer || !selected?.preview || selected.preview.unavailable) return [];
  return [new AttachmentBuilder(buffer, { name: selected.preview.attachmentName })];
}

function measureReceiptTextLength(receipt?: PanelReceipt): number {
  if (!receipt) return 0;
  return measureComponentTextLength(buildPanelReceiptContainer(receipt));
}

function measurePersonaCreateHintLength(locale: string): number {
  const content = withLinePrefix("-# ", localizer(locale, "commands.config.panel.persona_create_hint"));
  return 2 + getDiscordTextLength(content);
}

function getBasePageTextAllowance(input: ConfigPanelRenderInput, isPersonaPage = false): number {
  const receiptLength = measureReceiptTextLength(input.receipt);
  const hintLength = isPersonaPage ? measurePersonaCreateHintLength(input.locale) : 0;
  return Math.max(0, DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX - receiptLength - hintLength);
}

function appendPersonaCreateHint(components: ComponentInContainerData[], locale: string): void {
  const content = withLinePrefix("-# ", localizer(locale, "commands.config.panel.persona_create_hint"));
  const lastComponent = components.at(-1);
  if (lastComponent?.type === ComponentType.MediaGallery) {
    const precedingTextDisplay = [...components]
      .reverse()
      .find((component) => component.type === ComponentType.TextDisplay) as TextDisplayComponentData | undefined;
    if (precedingTextDisplay) {
      precedingTextDisplay.content = `${precedingTextDisplay.content}\n${content}`;
    } else {
      components.splice(-1, 0, { type: ComponentType.TextDisplay, content });
    }
    return;
  }
  if (lastComponent?.type === ComponentType.TextDisplay) {
    const textDisplay = lastComponent as TextDisplayComponentData;
    textDisplay.content = `${textDisplay.content}\n\n${content}`;
    return;
  }
  components.push({ type: ComponentType.TextDisplay, content });
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
    `${localizer(locale, "commands.config.panel.naming_prefix_label")}: ${prefix ? inlineCode(prefix) : none}`,
    `${localizer(locale, "commands.config.panel.naming_suffix_label")}: ${suffix ? inlineCode(suffix) : none}`,
    `${localizer(locale, "commands.config.panel.naming_term_label")}: ${term ? inlineCode(term) : none}`,
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
  return ["```markdown", neutralizeFenceRuns(content), "```"].join("\n");
}

interface BoundedFencedResult {
  rendered: string;
  isTruncated: boolean;
  shownCount: number;
  totalCount: number;
  notice?: string;
}

interface BoundedFencedOptions {
  noticePosition?: "inside" | "outside";
}

function formatTruncationNotice(locale: string, shown: number, total: number): string {
  return localizer(locale, "commands.config.panel.content_truncated", {
    shown: String(shown),
    total: String(total),
  });
}

function renderBoundedFencedContent(
  locale: string,
  content: string,
  budget: number,
  options?: BoundedFencedOptions,
): BoundedFencedResult {
  const totalCount = getDiscordTextLength(content);
  if (budget <= 0) {
    return {
      rendered: "",
      isTruncated: totalCount > 0,
      shownCount: 0,
      totalCount,
    };
  }

  // Guarded before truncation so the guard's expansion counts against the budget rather than
  // being appended past it.
  const safeContent = neutralizeFenceRuns(content);
  const fullRendered = renderFencedCollectionContent(safeContent);
  if (getDiscordTextLength(fullRendered) <= budget) {
    return {
      rendered: fullRendered,
      isTruncated: false,
      shownCount: totalCount,
      totalCount,
    };
  }

  const noticePosition = options?.noticePosition ?? "inside";
  const fenceOverhead = getDiscordTextLength(renderFencedCollectionContent(""));

  if (noticePosition === "outside") {
    const estimatedNotice = formatTruncationNotice(locale, budget, totalCount);
    let available = Math.max(0, budget - fenceOverhead - getDiscordTextLength(estimatedNotice));
    let truncatedSafe = truncateDiscordText(safeContent, available, "");
    let shownCount = getDiscordTextLength(truncatedSafe.split(FENCE_GUARD).join(""));
    let notice = formatTruncationNotice(locale, shownCount, totalCount);

    while (
      shownCount > 0 &&
      getDiscordTextLength(renderFencedCollectionContent(truncatedSafe)) + getDiscordTextLength(notice) > budget
    ) {
      available = Math.max(0, available - 1);
      truncatedSafe = truncateDiscordText(safeContent, available, "");
      shownCount = getDiscordTextLength(truncatedSafe.split(FENCE_GUARD).join(""));
      notice = formatTruncationNotice(locale, shownCount, totalCount);
    }

    return {
      rendered: renderFencedCollectionContent(truncatedSafe),
      isTruncated: true,
      shownCount,
      totalCount,
      notice,
    };
  }

  // Inside the fence: the notice is appended on a new line inside the markdown code block.
  const estimatedNotice = formatTruncationNotice(locale, budget, totalCount);
  let available = Math.max(0, budget - fenceOverhead - 1 - getDiscordTextLength(estimatedNotice));
  let truncatedSafe = truncateDiscordText(safeContent, available, "");
  let shownCount = getDiscordTextLength(truncatedSafe.split(FENCE_GUARD).join(""));
  let notice = formatTruncationNotice(locale, shownCount, totalCount);

  while (
    shownCount > 0 &&
    getDiscordTextLength(renderFencedCollectionContent(`${truncatedSafe}\n${notice}`)) > budget
  ) {
    available = Math.max(0, available - 1);
    truncatedSafe = truncateDiscordText(safeContent, available, "");
    shownCount = getDiscordTextLength(truncatedSafe.split(FENCE_GUARD).join(""));
    notice = formatTruncationNotice(locale, shownCount, totalCount);
  }

  const rendered =
    shownCount > 0
      ? renderFencedCollectionContent(`${truncatedSafe}\n${notice}`)
      : renderFencedCollectionContent(notice);

  return {
    // Truncating an already fenced string would cut its closing delimiter and leak the fence into
    // the rest of the panel, so a budget too small for even the notice yields no block at all.
    rendered: getDiscordTextLength(rendered) <= budget ? rendered : "",
    isTruncated: true,
    shownCount,
    totalCount,
    notice,
  };
}

function renderBoundedChannelRows(
  locale: string,
  rows: readonly string[],
  budget: number,
  emptyFallback: string,
): string {
  if (budget <= 0) {
    return "";
  }
  if (rows.length === 0) {
    return withLinePrefix("> ", emptyFallback);
  }

  const fullContent = withLinePrefix("> ", rows.join("\n"));
  if (getDiscordTextLength(fullContent) <= budget) {
    return fullContent;
  }

  const total = rows.length;
  for (let shown = total - 1; shown >= 0; shown--) {
    const notice = localizer(locale, "commands.config.panel.channels_collection_hidden", {
      shown: String(shown),
      total: String(total),
      hidden: String(total - shown),
    });
    const candidateLines = shown > 0 ? [...rows.slice(0, shown), notice] : [notice];
    const candidate = withLinePrefix("> ", candidateLines.join("\n"));
    if (getDiscordTextLength(candidate) <= budget) {
      return candidate;
    }
  }

  const notice = localizer(locale, "commands.config.panel.channels_collection_hidden", {
    shown: "0",
    total: String(total),
    hidden: String(total),
  });
  const fallback = withLinePrefix("> ", notice);
  return getDiscordTextLength(fallback) <= budget ? fallback : "";
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

function getPersonaGeneralFixedChromeLength(input: ConfigPanelRenderInput, persona: TomoriState): number {
  const { locale, selectedPersonaAvatarUrl } = input;
  const heading: TextDisplayComponentData = {
    type: ComponentType.TextDisplay,
    content: `### ${localizer(locale, "commands.config.panel.general_title")}
${localizer(locale, "commands.config.panel.general_description")}
> ${localizer(locale, "commands.config.panel.name_label")}: ${escapeDiscordMarkdown(persona.persona_nickname)}
> ${localizer(locale, "commands.config.panel.role_label")}: ${localizer(
      locale,
      persona.is_alter ? "commands.config.panel.role_alter" : "commands.config.panel.role_main",
    )}`,
  };
  const headingComp = buildOptionalThumbnailSection(heading, selectedPersonaAvatarUrl);

  const mayWriteAttr = mayWritePersonaCollection(input, "attribute-add", input.attributeMemteachingEnabled);
  const attrTitleDesc = `${localizer(locale, "commands.config.panel.attributes_title")}
${localizer(locale, "commands.config.panel.attributes_description")}`;
  const attrDisabled = mayWriteAttr
    ? ""
    : withLinePrefix("-# ", localizer(locale, "commands.config.panel.collection_teaching_disabled"));

  const mayWriteDlg = mayWritePersonaCollection(input, "dialogue-add", input.sampledialogueMemteachingEnabled);
  const dlgTitleDesc = `${localizer(locale, "commands.config.panel.dialogues_title")}
${localizer(locale, "commands.config.panel.dialogues_description")}`;
  const dlgDisabled = mayWriteDlg
    ? ""
    : withLinePrefix("-# ", localizer(locale, "commands.config.panel.collection_teaching_disabled"));

  const attributes = persona.attribute_list ?? [];
  const hasSelectedAttr =
    input.selectedAttributeIndex !== undefined &&
    input.selectedAttributeIndex >= 0 &&
    input.selectedAttributeIndex < attributes.length;

  const pairCount = Math.min(persona.sample_dialogues_in?.length ?? 0, persona.sample_dialogues_out?.length ?? 0);
  const hasSelectedDlg =
    input.selectedDialogueIndex !== undefined &&
    input.selectedDialogueIndex >= 0 &&
    input.selectedDialogueIndex < pairCount;

  let fixed = measureComponentTextLength(headingComp);
  fixed += getDiscordTextLength(attrTitleDesc);
  if (attrDisabled) fixed += getDiscordTextLength(attrDisabled);
  if (hasSelectedAttr) fixed += 1;

  fixed += getDiscordTextLength(dlgTitleDesc);
  if (dlgDisabled) fixed += getDiscordTextLength(dlgDisabled);
  if (hasSelectedDlg) fixed += 1;

  return fixed;
}

function getPersonaGeneralCollectionBudget(input: ConfigPanelRenderInput, persona: TomoriState): number {
  const allowance = getBasePageTextAllowance(input, true);
  const fixedReserve = getPersonaGeneralFixedChromeLength(input, persona);
  const available = Math.max(0, allowance - fixedReserve);

  const attributes = persona.attribute_list ?? [];
  const hasSelectedAttr =
    input.selectedAttributeIndex !== undefined &&
    input.selectedAttributeIndex >= 0 &&
    input.selectedAttributeIndex < attributes.length;

  const pairCount = Math.min(persona.sample_dialogues_in?.length ?? 0, persona.sample_dialogues_out?.length ?? 0);
  const hasSelectedDlg =
    input.selectedDialogueIndex !== undefined &&
    input.selectedDialogueIndex >= 0 &&
    input.selectedDialogueIndex < pairCount;

  if (hasSelectedAttr && hasSelectedDlg) {
    return Math.floor(available / 2);
  }
  return available;
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
  const selectedAttributeContent = selectedIndex !== undefined ? attributes[selectedIndex] : undefined;
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
      label: safeSelectOptionText(`${start + offset + 1}. ${attribute}`, 100),
      value: String(start + offset),
      default: start + offset === selectedIndex,
    })),
  ];

  const budget = getPersonaGeneralCollectionBudget(input, persona);
  const renderedSelectedContent =
    selectedAttributeContent !== undefined
      ? `\n${renderBoundedFencedContent(locale, selectedAttributeContent, budget).rendered}`
      : "";

  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `${localizer(locale, "commands.config.panel.attributes_title")}
${localizer(locale, "commands.config.panel.attributes_description")}${renderedSelectedContent}`,
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
    components.push({
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
    });
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
  const selectedInput = selectedIndex !== undefined ? inputs[selectedIndex] : undefined;
  const selectedOutput = selectedIndex !== undefined ? outputs[selectedIndex] : undefined;
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
      label: safeSelectOptionText(`${start + offset + 1}. ${dialogue}`, 100),
      value: String(start + offset),
      description: safeSelectOptionText(outputs[start + offset] ?? "", 100),
      default: start + offset === selectedIndex,
    })),
  ];

  const budget = getPersonaGeneralCollectionBudget(input, persona);
  let renderedSelectedContent = "";
  if (selectedInput !== undefined && selectedOutput !== undefined) {
    const dialoguePair = `${localizer(locale, "commands.config.panel.dialogue_user_prefix")}: ${selectedInput}
${localizer(locale, "commands.config.panel.dialogue_bot_prefix")}: ${selectedOutput}`;
    renderedSelectedContent = `\n${renderBoundedFencedContent(locale, dialoguePair, budget).rendered}`;
  }

  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `${localizer(locale, "commands.config.panel.dialogues_title")}
${localizer(locale, "commands.config.panel.dialogues_description")}${renderedSelectedContent}`,
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

  if (selectedIndex !== undefined && selectedInput !== undefined && selectedOutput !== undefined) {
    const fp = computeDialogueFingerprint(persona.persona_id as number, selectedIndex, selectedInput, selectedOutput);
    components.push({
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
    });
  }

  return components;
}

function buildPersonaGeneralBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor, personas, selectedPersonaId, readStatus } = input;
  const writesDisabled = readStatus !== "fresh";
  const persona = personas.find((candidate) => candidate.persona_id === selectedPersonaId) ?? null;

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

  heading.content += `
> ${localizer(locale, "commands.config.panel.name_label")}: ${escapeDiscordMarkdown(persona.persona_nickname)}
> ${localizer(locale, "commands.config.panel.role_label")}: ${localizer(
    locale,
    persona.is_alter ? "commands.config.panel.role_alter" : "commands.config.panel.role_main",
  )}`;

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

  const identityActionRow: ComponentInContainerData | undefined =
    identityButtons.length > 0 ? { type: ComponentType.ActionRow, components: identityButtons } : undefined;

  const attributeComponents = buildAttributeCollectionBody(input, persona);
  const dialogueComponents = buildDialogueCollectionBody(input, persona);

  if (identityActionRow) components.push(identityActionRow);
  components.push(...attributeComponents, ...dialogueComponents);

  return components;
}

function buildPersonaNamingBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor, personas, selectedPersonaId, readStatus } = input;
  const writesDisabled = readStatus !== "fresh";
  const persona = personas.find((candidate) => candidate.persona_id === selectedPersonaId) ?? null;

  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.naming_title")}
${localizer(locale, "commands.config.panel.naming_page_description")}`,
    },
  ];

  if (!persona) {
    components.push({
      type: ComponentType.TextDisplay,
      content: localizer(locale, "commands.config.panel.no_personas"),
    });
    return components;
  }

  const namingState = resolvePersonaGeneralActionState("naming", actor);
  if (namingState === "omitted") return components;

  // Every style is rendered at once, so the edit route carries the style it belongs to and no
  // selector is needed to tell one shared button which style it is editing.
  for (const style of ADDRESSING_STYLES) {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, NAMING_STYLE_LOCALE_KEYS[style])}**
${localizer(locale, NAMING_STYLE_DESCRIPTION_LOCALE_KEYS[style])}
${withLinePrefix("> ", describeNamingStyle(locale, persona, style))}`,
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
              style,
            }),
            label: localizer(locale, "commands.config.panel.edit_naming_style_button", {
              style: localizer(locale, NAMING_STYLE_LOCALE_KEYS[style]),
            }),
            disabled: writesDisabled || namingState === "disabled",
          },
        ],
      },
    );
  }

  return components;
}

function buildPersonaTriggersBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor, personas, selectedPersonaId, readStatus } = input;
  const persona = personas.find((candidate) => candidate.persona_id === selectedPersonaId) ?? null;
  const heading = buildOptionalThumbnailSection(
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.triggers_page_title")}
${localizer(locale, "commands.config.panel.triggers_page_description")}`,
    },
    input.selectedPersonaAvatarUrl,
  );
  if (!persona) {
    return [
      heading,
      { type: ComponentType.TextDisplay, content: localizer(locale, "commands.config.panel.no_personas") },
    ];
  }

  const triggerWords = persona.trigger_words ?? [];
  const triggerAddState = resolvePersonaGeneralActionState("trigger-add", actor);
  const triggerRemoveState = resolvePersonaGeneralActionState("trigger-remove", actor);
  return [
    heading,
    {
      type: ComponentType.TextDisplay,
      content: `${localizer(locale, "commands.config.panel.triggers_title")}
${localizer(locale, "commands.config.panel.triggers_description")}
> ${triggerWords.length > 0 ? formatTriggerWords(triggerWords) : localizer(locale, "commands.config.panel.triggers_none")}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "trigger-add-open", locale, personaId: persona.persona_id as number }),
          label: localizer(locale, "commands.config.panel.add_trigger_button"),
          disabled: readStatus !== "fresh" || triggerAddState !== "enabled",
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({
            action: "trigger-remove-open",
            locale,
            personaId: persona.persona_id as number,
          }),
          label: localizer(locale, "commands.config.panel.remove_trigger_button"),
          disabled: readStatus !== "fresh" || triggerRemoveState !== "enabled" || triggerWords.length === 0,
        },
      ],
    },
    {
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.triggers_footer")),
    },
  ];
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

function buildPersonaAppearanceBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor, personas, selectedPersonaId, readStatus } = input;
  const persona = personas.find((candidate) => candidate.persona_id === selectedPersonaId) ?? null;
  if (!persona) {
    return [
      buildOptionalThumbnailSection(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.config.panel.appearance_title")}
${localizer(locale, "commands.config.panel.appearance_description")}`,
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
        content: `### ${localizer(locale, "commands.config.panel.appearance_title")}
${localizer(locale, "commands.config.panel.appearance_description")}`,
      },
      input.selectedPersonaAvatarUrl,
    ),
  ];
  const personaId = persona.persona_id as number;
  const actionState = (action: Parameters<typeof resolvePersonaAdvancedActionState>[0]) =>
    resolvePersonaAdvancedActionState(action, actor);

  const characterReferenceState = actionState("character-reference");
  let characterRefTextDisplay: ComponentInContainerData | undefined;
  if (characterReferenceState !== "omitted") {
    const reference = persona.nai_char_ref_url
      ? localizer(locale, "commands.config.panel.character_reference_uploaded")
      : localizer(locale, "commands.config.panel.none_label");
    characterRefTextDisplay = {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.character_reference_title")}**
${localizer(locale, "commands.config.panel.character_reference_description")}
> ${localizer(locale, "commands.config.panel.character_reference_image_label")}: ${reference}`,
    };
  }

  const imageTagsState = actionState("image-tags");
  if (imageTagsState !== "omitted") {
    const tags = persona.physical_appearance_tags ?? [];
    const imageTagsHeader = `**${localizer(locale, "commands.config.panel.image_tags_title")}**
${localizer(locale, "commands.config.panel.image_tags_description")}
`;
    const baseAllowance = getBasePageTextAllowance(input, true);
    let fixedTextLength = measureComponentTextLength(components[0]) + getDiscordTextLength(imageTagsHeader);
    if (characterRefTextDisplay) {
      fixedTextLength += measureComponentTextLength(characterRefTextDisplay);
    }
    const tagsBudget = Math.max(0, baseAllowance - fixedTextLength);
    const renderedTags =
      tags.length > 0
        ? renderBoundedFencedContent(locale, tags.join(", "), tagsBudget).rendered
        : renderFencedCollectionContent(localizer(locale, "commands.config.panel.none_label"));
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `${imageTagsHeader}${renderedTags}`,
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

  if (characterRefTextDisplay) {
    components.push(characterRefTextDisplay, {
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
    });
    if (input.selectedPersonaCharacterReferenceUrl) {
      components.push({
        type: ComponentType.MediaGallery,
        items: [{ media: { url: input.selectedPersonaCharacterReferenceUrl } }],
      });
    }
  }

  return components;
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

  const promptState = actionState("prompt");
  const contextState = actionState("context-note");
  const attgState = actionState("attg");
  const hasPromptContent = promptState !== "omitted" && Boolean(persona.persona_prompt?.trim());
  const hasContextContent = contextState !== "omitted" && Boolean(persona.context_note?.trim());
  const attgValues = [
    {
      label: localizer(locale, "commands.config.panel.attg.author_label"),
      value: persona.nai_attg_author?.trim() ?? "",
    },
    {
      label: localizer(locale, "commands.config.panel.attg.title_label"),
      value: persona.nai_attg_title?.trim() ?? "",
    },
    {
      label: localizer(locale, "commands.config.panel.attg.tags_label"),
      value: persona.nai_attg_tags?.trim() ?? "",
    },
    {
      label: localizer(locale, "commands.config.panel.attg.genre_label"),
      value: persona.nai_attg_genre?.trim() ?? "",
    },
  ];
  const baseAllowance = getBasePageTextAllowance(input, true);
  const promptHeader =
    promptState !== "omitted"
      ? `**${localizer(locale, "commands.config.panel.persona_prompt_title")}**\n${localizer(locale, "commands.config.panel.persona_prompt_description")}\n`
      : "";
  const contextHeader =
    contextState !== "omitted"
      ? `**${localizer(locale, "commands.config.panel.context_note_title")}**\n${localizer(locale, "commands.config.panel.context_note_description")}\n> ${localizer(locale, "commands.config.panel.context_note_depth", { depth: persona.context_note_depth ?? 0 })}\n`
      : "";
  const noneContent = renderFencedCollectionContent(localizer(locale, "commands.config.panel.none_label"));
  const attgHeader =
    attgState !== "omitted"
      ? `**${localizer(locale, "commands.config.panel.attg.modal_title")}**\n${safeSelectOptionText(
          localizer(locale, "commands.config.panel.attg.description"),
          65,
        )}`
      : "";
  const attgStars =
    attgState !== "omitted"
      ? `**${localizer(locale, "commands.config.panel.attg.stars_label")}:** ${
          persona.nai_attg_stars === null || persona.nai_attg_stars === undefined
            ? localizer(locale, "commands.config.panel.none_label")
            : String(persona.nai_attg_stars)
        }`
      : "";
  let fixedTextLength = measureComponentTextLength(components[0]);
  if (promptState !== "omitted") {
    fixedTextLength += getDiscordTextLength(promptHeader);
    if (!hasPromptContent) fixedTextLength += getDiscordTextLength(noneContent);
  }
  if (contextState !== "omitted") {
    fixedTextLength += getDiscordTextLength(contextHeader);
    if (!hasContextContent) fixedTextLength += getDiscordTextLength(noneContent);
  }
  if (attgState !== "omitted") {
    const attgFixedParts = [attgHeader];
    for (const { label, value } of attgValues) {
      attgFixedParts.push(`**${label}**`);
      if (!value) attgFixedParts.push(noneContent);
    }
    attgFixedParts.push(attgStars);
    fixedTextLength += getDiscordTextLength(attgFixedParts.join("\n"));
  }
  const advancedDynamicAllowance = Math.max(0, baseAllowance - fixedTextLength);
  const dynamicValueCount =
    Number(hasPromptContent) +
    Number(hasContextContent) +
    (attgState === "omitted" ? 0 : attgValues.filter(({ value }) => value.length > 0).length);
  const advancedPerValueBudget = dynamicValueCount > 0 ? Math.floor(advancedDynamicAllowance / dynamicValueCount) : 0;

  if (promptState !== "omitted") {
    const promptText = persona.persona_prompt?.trim() ?? "";
    const renderedPrompt = promptText
      ? renderBoundedFencedContent(locale, promptText, advancedPerValueBudget).rendered
      : renderFencedCollectionContent(localizer(locale, "commands.config.panel.none_label"));
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.config.panel.persona_prompt_title")}**
${localizer(locale, "commands.config.panel.persona_prompt_description")}
${renderedPrompt}`,
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

  if (contextState !== "omitted") {
    const note = persona.context_note?.trim() ?? "";
    const renderedNote = note
      ? renderBoundedFencedContent(locale, note, advancedPerValueBudget).rendered
      : renderFencedCollectionContent(localizer(locale, "commands.config.panel.none_label"));
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.config.panel.context_note_title")}**
${localizer(locale, "commands.config.panel.context_note_description")}
> ${localizer(locale, "commands.config.panel.context_note_depth", {
          depth: persona.context_note_depth ?? 0,
        })}
${renderedNote}`,
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

  if (attgState !== "omitted") {
    const attgParts = [attgHeader];
    for (const { label, value } of attgValues) {
      attgParts.push(`**${label}**`);
      attgParts.push(value ? renderBoundedFencedContent(locale, value, advancedPerValueBudget).rendered : noneContent);
    }
    attgParts.push(attgStars);
    components.push(
      { type: ComponentType.TextDisplay, content: attgParts.join("\n") },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({ action: "attg-open", locale, personaId }),
            label: localizer(locale, "commands.config.panel.edit_nai_button"),
            disabled: writesDisabled || attgState === "disabled",
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildConfigRouteId({ action: "attg-clear-all", locale, personaId }),
            label: localizer(locale, "commands.config.panel.clear_override_button"),
            disabled:
              writesDisabled ||
              attgState === "disabled" ||
              (attgValues.every(({ value }) => !value) &&
                (persona.nai_attg_stars === null || persona.nai_attg_stars === undefined)),
          },
        ],
      },
    );
  }

  return components;
}

function buildPersonaOverridesBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor, personas, selectedPersonaId, readStatus } = input;
  const persona = personas.find((candidate) => candidate.persona_id === selectedPersonaId) ?? null;
  if (!persona) {
    return [
      buildOptionalThumbnailSection(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.config.panel.overrides_title")}
${localizer(locale, "commands.config.panel.overrides_description")}`,
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
        content: `### ${localizer(locale, "commands.config.panel.overrides_title")}
${localizer(locale, "commands.config.panel.overrides_description")}`,
      },
      input.selectedPersonaAvatarUrl,
    ),
  ];
  const personaId = persona.persona_id as number;
  const actionState = (action: Parameters<typeof resolvePersonaOverridesActionState>[0]) =>
    resolvePersonaOverridesActionState(action, actor);
  const humanizerState = actionState("humanizer");
  const humanizerValue = persona.humanizer_degree_override ?? null;
  const humanizerTextDisplay: ComponentInContainerData | undefined =
    humanizerState !== "omitted"
      ? {
          type: ComponentType.TextDisplay,
          content: `**${localizer(locale, "commands.config.panel.response_style_title")}**
${localizer(locale, "commands.config.panel.response_style_description")}
> ${localizer(locale, "commands.config.panel.persona_override_label")}: ${getHumanizerLabel(locale, humanizerValue)}
> ${localizer(locale, "commands.config.panel.server_default_label")}: ${renderHumanizerDegree(locale, input.serverHumanizerDegree)}`,
        }
      : undefined;

  const textState = actionState("text-override");
  const textOverride = persona.persona_llm
    ? `${persona.persona_llm.llm_provider} / ${persona.persona_llm.llm_codename}`
    : localizer(locale, "commands.config.panel.none_label");
  const serverModel = persona.llm
    ? `${persona.llm.llm_provider} / ${persona.llm.llm_codename}`
    : localizer(locale, "commands.config.panel.none_label");
  const textOverrideTextDisplay: ComponentInContainerData | undefined =
    textState !== "omitted"
      ? {
          type: ComponentType.TextDisplay,
          content: `**${localizer(locale, "commands.config.panel.text_override_title")}**
${localizer(locale, "commands.config.panel.text_override_description")}
> ${localizer(locale, "commands.config.panel.persona_override_label")}: ${textOverride}
> ${localizer(locale, "commands.config.panel.server_default_label")}: ${serverModel}`,
        }
      : undefined;

  if (humanizerTextDisplay) {
    components.push(humanizerTextDisplay);
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

  if (textOverrideTextDisplay) {
    components.push(textOverrideTextDisplay);

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

  const addState = actionState("add");
  if (sprites.length === 0) {
    components.push({
      type: ComponentType.TextDisplay,
      content: localizer(locale, "commands.config.panel.sprites_none"),
    });
  }
  if (sprites.length > 0 || addState === "enabled") {
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
            options: [
              ...(addState === "enabled"
                ? [
                    {
                      label: safeSelectOptionText(localizer(locale, "commands.config.panel.sprite_add_option"), 100),
                      value: "add",
                    },
                  ]
                : []),
              ...visibleSprites.map((sprite, offset) => ({
                label: safeSelectOptionText(sprite.sprite_name, 100),
                value: String(start + offset),
                description: safeSelectOptionText(
                  sprite.usage_instructions.trim() || localizer(locale, "commands.config.panel.none_label"),
                  100,
                ),
                default: start + offset === selectedIndex,
              })),
            ],
            disabled: writesDisabled || (sprites.length === 0 && addState !== "enabled"),
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
        input.selectedSpriteAvatarUrl,
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
  let conditioningTextDisplay: ComponentInContainerData | undefined;
  let conditioningActionRow: ComponentInContainerData | undefined;
  let conditioningFooterDisplay: ComponentInContainerData | undefined;
  if (input.actor.workspaceKind === "guild") {
    const conditioningGroups = (view?.conditioningGroups ?? []).filter((group) => group.reasonText.trim().length > 0);
    const conditioningLines = CONDITIONING_TYPE_ORDER.flatMap((conditioningType) => {
      const groups = conditioningGroups.filter((group) => group.conditioningType === conditioningType);
      const total = groups.reduce((sum, group) => sum + group.totalCount, 0);
      const summaryKeys = CONDITIONING_SUMMARY_LOCALE_KEYS[conditioningType];
      const headingKey = total === 0 ? summaryKeys.none : total === 1 ? summaryKeys.one : summaryKeys.many;
      const marker = localizer(locale, CONDITIONING_MARKER_LOCALE_KEYS[conditioningType]);
      const summaryLines = [`> ${marker} ${localizer(locale, headingKey, { count: total })}`];

      // Groups split on reason as well as action, so one action can own several rows and its
      // total has to be summed rather than read off whichever row happens to come first.
      const perAction = new Map<string, number>();
      for (const group of groups) {
        perAction.set(group.actionKey, (perAction.get(group.actionKey) ?? 0) + group.totalCount);
      }
      const ranked = [...perAction.entries()].sort(
        ([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey),
      );
      for (const [actionKey, count] of ranked) {
        const labelKey = count === 1 ? "history_label" : "history_label_plural";
        summaryLines.push(`> ${count} ${localizer(locale, `commands.${conditioningType}.${actionKey}.${labelKey}`)}`);
      }
      return summaryLines;
    });
    conditioningTextDisplay = {
      type: ComponentType.TextDisplay,
      content: `${localizer(locale, "commands.config.panel.conditioning_title")}
${localizer(locale, "commands.config.panel.conditioning_description")}
${conditioningLines.join("\n")}`,
    };
    conditioningActionRow = {
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
    };
    conditioningFooterDisplay = {
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.conditioning_footer")),
    };
  }

  const baseAllowance = getBasePageTextAllowance(input, true);
  let fixedTextLength = measureComponentTextLength(components) + getDiscordTextLength(stmHeader);
  if (conditioningTextDisplay) fixedTextLength += measureComponentTextLength(conditioningTextDisplay);
  if (conditioningFooterDisplay) fixedTextLength += measureComponentTextLength(conditioningFooterDisplay);
  const personaMemoryStmBudget = Math.max(0, baseAllowance - fixedTextLength);

  const stmContent =
    stmSections.length > 0
      ? renderBoundedFencedContent(locale, stmSections.join("\n\n"), personaMemoryStmBudget).rendered
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

  if (conditioningTextDisplay && conditioningActionRow && conditioningFooterDisplay) {
    components.push(conditioningTextDisplay, conditioningActionRow, conditioningFooterDisplay);
  }

  return components;
}

/** Reward before punish, matching the order the two conditioning command families are listed in. */
const CONDITIONING_TYPE_ORDER = ["reward", "punish"] as const;

/**
 * Literal locale keys per conditioning type. `check-locales` only sees literal strings, so a key
 * assembled from the type at the call site would drop out of its parity check.
 */
const CONDITIONING_MARKER_LOCALE_KEYS: Record<(typeof CONDITIONING_TYPE_ORDER)[number], string> = {
  reward: "commands.conditioning.shared.marker_reward",
  punish: "commands.conditioning.shared.marker_punish",
};

const CONDITIONING_SUMMARY_LOCALE_KEYS: Record<
  (typeof CONDITIONING_TYPE_ORDER)[number],
  { none: string; one: string; many: string }
> = {
  reward: {
    none: "commands.config.panel.conditioning_reward_none",
    one: "commands.config.panel.conditioning_reward_summary_one",
    many: "commands.config.panel.conditioning_reward_summary",
  },
  punish: {
    none: "commands.config.panel.conditioning_punish_none",
    one: "commands.config.panel.conditioning_punish_summary_one",
    many: "commands.config.panel.conditioning_punish_summary",
  },
};

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
  const contextNote = view.contextNote?.trim() ?? "";
  const promptHeader = `**${localizer(locale, "commands.config.panel.system_prompt_title")}**\n${localizer(
    locale,
    "commands.config.panel.system_prompt_description",
  )}\n`;
  const contextHeader = `**${localizer(locale, "commands.config.panel.context_note_title")}**\n${localizer(
    locale,
    "commands.config.panel.global_context_note_description",
  )}\n`;
  const noneContent = renderFencedCollectionContent(localizer(locale, "commands.config.panel.none_label"));
  const responseStyleTextDisplay: ComponentInContainerData = {
    type: ComponentType.TextDisplay,
    content: `**${localizer(locale, "commands.config.panel.response_style_title")}**\n${localizer(
      locale,
      "commands.config.panel.global_response_style_description",
    )}\n> ${localizer(locale, "commands.config.panel.humanizer_label")}: ${getHumanizerLabel(
      locale,
      view.humanizerDegree,
    )}\n> ${localizer(locale, "commands.config.panel.message_fetch_limit_label")}: ${view.messageFetchLimit}`,
  };
  const timezoneTextDisplay: ComponentInContainerData | undefined =
    input.actor.workspaceKind === "guild"
      ? {
          type: ComponentType.TextDisplay,
          content: `**${localizer(locale, "commands.config.panel.server_timezone_title")}**\n${localizer(
            locale,
            "commands.config.panel.server_timezone_description",
          )}\n> ${localizer(locale, "commands.config.panel.utc_offset_label")}: ${formatUTCOffset(view.timezoneOffset)}`,
        }
      : undefined;

  const baseAllowance = getBasePageTextAllowance(input, false);
  let fixedTextLength =
    measureComponentTextLength(components[0]) +
    getDiscordTextLength(promptHeader) +
    getDiscordTextLength(contextHeader) +
    (contextNote ? 0 : getDiscordTextLength(noneContent)) +
    measureComponentTextLength(responseStyleTextDisplay);
  if (timezoneTextDisplay) {
    fixedTextLength += measureComponentTextLength(timezoneTextDisplay);
  }
  const generalDynamicAllowance = Math.max(0, baseAllowance - fixedTextLength);
  const generalPerValueBudget = contextNote ? Math.floor(generalDynamicAllowance / 2) : generalDynamicAllowance;

  const renderedPrompt = renderBoundedFencedContent(locale, prompt, generalPerValueBudget).rendered;
  const renderedContextNote = contextNote
    ? renderBoundedFencedContent(locale, contextNote, generalPerValueBudget).rendered
    : renderFencedCollectionContent(localizer(locale, "commands.config.panel.none_label"));

  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.system_prompt_title")}**\n${localizer(
        locale,
        "commands.config.panel.system_prompt_description",
      )}\n${renderedPrompt}`,
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
      )}\n${renderedContextNote}`,
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
    responseStyleTextDisplay,
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

  if (timezoneTextDisplay) {
    components.push(timezoneTextDisplay, {
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
    });
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

/**
 * The explicit removal-range state: only this state offers the range selector and its window
 * navigation, so an overflow server keeps the ordinary Trigger page free of removal chrome until
 * Remove is pressed. Cancel returns to the ordinary page at the position this state was reached.
 */
function buildRandomTriggerRemoveRangeComponents(
  locale: string,
  view: ConfigBehaviorTriggerView,
  start: number,
  writesDisabled: boolean,
): ComponentInContainerData[] {
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.random_trigger_remove_mode_title")}**\n${localizer(
        locale,
        "commands.config.panel.random_trigger_remove_mode_description",
      )}`,
    },
  ];
  const triggerPageCount = Math.ceil(view.randomTriggers.length / RANDOM_TRIGGER_PAGE_SIZE);
  if (triggerPageCount > 0) {
    const selectedTriggerPage = Math.min(
      Math.max(Math.floor(start / RANDOM_TRIGGER_PAGE_SIZE), 0),
      triggerPageCount - 1,
    );
    const selectWindowStart =
      Math.floor(selectedTriggerPage / CONFIG_PERSONA_SELECT_PAGE_SIZE) * CONFIG_PERSONA_SELECT_PAGE_SIZE;
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildConfigRouteId({ action: "behavior-random-remove-select", locale }),
          placeholder: localizer(locale, "commands.config.panel.random_trigger_page_placeholder"),
          options: Array.from(
            {
              length: Math.min(triggerPageCount - selectWindowStart, CONFIG_PERSONA_SELECT_PAGE_SIZE),
            },
            (_page, offset) => {
              const page = selectWindowStart + offset;
              const rangeStart = page * RANDOM_TRIGGER_PAGE_SIZE;
              const rangeEnd = Math.min(rangeStart + RANDOM_TRIGGER_PAGE_SIZE, view.randomTriggers.length);
              return {
                label: safeSelectOptionText(
                  localizer(locale, "commands.config.panel.random_trigger_page_option", {
                    first: rangeStart + 1,
                    last: rangeEnd,
                  }),
                  100,
                ),
                value: String(rangeStart),
                default: page === selectedTriggerPage,
              };
            },
          ),
          disabled: writesDisabled,
        } satisfies StringSelectMenuComponentData,
      ],
    } satisfies ActionRowData<StringSelectMenuComponentData>);

    const rangeCount = Math.max(1, Math.ceil(triggerPageCount / CONFIG_PERSONA_SELECT_PAGE_SIZE));
    const paginationRow = buildPaginationRow({
      locale,
      rangeIndex: Math.floor(selectedTriggerPage / CONFIG_PERSONA_SELECT_PAGE_SIZE),
      rangeCount,
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
    if (paginationRow) components.push(paginationRow);
  }
  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildConfigRouteId({ action: "behavior-random-remove-cancel", locale }),
        label: localizer(locale, "commands.config.panel.cancel_button"),
        disabled: writesDisabled,
      },
    ],
  });
  return components;
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

  if (input.randomTriggerRemoveMode) {
    components.push(
      ...buildRandomTriggerRemoveRangeComponents(locale, view, input.randomTriggerPageStart ?? 0, writesDisabled),
    );
    return components;
  }

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
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.random_triggers_title")}**\n${localizer(
        locale,
        "commands.config.panel.random_triggers_description",
      )}\n${withLinePrefix("-# ", localizer(locale, "commands.config.panel.random_triggers_help_hint"))}\n${triggerSummary}`,
    },
    ...buildPersonaRangeEntry({
      locale,
      personas: input.personas,
      pageSize: RANDOM_TRIGGER_ADD_PERSONA_PAGE_SIZE,
      // A fresh Add carries no stored persona, so no page can open marked over the others.
      selectedPersonaId: null,
      disabled: writesDisabled,
      buttonCustomId: buildConfigRouteId({ action: "behavior-random-add-open", locale }),
      buttonLabelKey: "commands.config.panel.add_random_trigger_button",
      selectCustomId: buildConfigRouteId({ action: "behavior-random-add-range-select", locale }),
      selectPlaceholderKey: "commands.config.panel.random_trigger_add_persona_range_placeholder",
      siblingButtons: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildConfigRouteId({ action: "behavior-random-remove-open", locale }),
          label: localizer(locale, "commands.config.panel.remove_random_trigger_button"),
          disabled: writesDisabled || view.randomTriggers.length === 0,
        },
      ],
    }),
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
      )}\n> ${cooldownLabel(locale, view.cooldownType)}${view.cooldownType === CooldownType.OFF ? "" : ` · ${view.cooldownLength}s`}`,
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
  const noticeLines = TOOL_NOTICE_DEFINITIONS.map(
    (definition) => `> ${hiddenSet.has(definition.key) ? "🔴" : "🟢"} ${localizer(locale, definition.labelKey)}`,
  ).join("\n");
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.notice_embeds_title")}**\n${localizer(locale, "commands.config.panel.notice_embeds_description")}\n${noticeLines}\n${withLinePrefix("-# ", localizer(locale, "commands.config.panel.disabled_notices_log_hint"))}`,
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
  const stmPromptHeader = `**${localizer(locale, "commands.config.panel.stm_prompt_title")}**\n${localizer(
    locale,
    "commands.config.panel.stm_prompt_description",
  )}\n`;
  const baseAllowance = getBasePageTextAllowance(input, false);
  const fixedTextLength = measureComponentTextLength(components) + getDiscordTextLength(stmPromptHeader) + 1;
  const memoryDynamicAllowance = Math.max(0, baseAllowance - fixedTextLength);
  const memoryPerValueBudget = Math.floor(memoryDynamicAllowance / 2);

  const renderedToolDescription = renderBoundedFencedContent(locale, toolDescription, memoryPerValueBudget).rendered;
  const renderedUpdateNudge = renderBoundedFencedContent(locale, updateNudge, memoryPerValueBudget).rendered;

  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `${stmPromptHeader}${renderedToolDescription}\n${renderedUpdateNudge}`,
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

function buildPluginsAvailableToolsBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor } = input;
  const view = input.permissionsView?.capabilities;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.plugins_available_tools_title")}
${localizer(locale, "commands.config.panel.plugins_available_tools_description")}`,
    },
  ];

  if (actor.workspaceKind === "guild" && !actor.isManager) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only")),
    });
    return components;
  }
  if (!view) return components;

  const actionDisabled = writesDisabled || resolvePermissionsCapabilitiesActionState("tool-use", actor) !== "enabled";
  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.plugins_tool_use_title")}**
${localizer(locale, "commands.config.panel.plugins_tool_use_description")}`,
    },
    buildStateControlRow(
      [
        {
          value: false,
          label: localizer(locale, "commands.config.panel.off_button"),
          customId: buildConfigRouteId({ action: "permissions-tool-use-set", locale, enabled: false }),
        },
        {
          value: true,
          label: localizer(locale, "commands.config.panel.on_button"),
          customId: buildConfigRouteId({ action: "permissions-tool-use-set", locale, enabled: true }),
        },
      ],
      view.toolUseEnabled,
      actionDisabled,
    ),
    {
      type: ComponentType.TextDisplay,
      content: withLinePrefix(
        "> ",
        localizer(
          locale,
          view.toolUseEnabled
            ? "commands.config.panel.plugins_tool_use_on"
            : "commands.config.panel.plugins_tool_use_off",
        ),
      ),
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.plugins_available_tools_state_title")}**
${localizer(locale, "commands.config.panel.plugins_available_tools_state_description")}
${getCapabilitiesManagePermissionDefinitions({ includeElevenLabs: view.includeElevenLabs })
  .filter((definition) => definition.page === "available-tools")
  .map(
    (definition) =>
      `> ${view.toolUseEnabled ? "" : "~~"}${view.definitionStates[definition.value] ? "🟢" : "🔴"} ${localizer(locale, definition.labelKey)}${view.toolUseEnabled ? "" : "~~"}`,
  )
  .join("\n")}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "permissions-manage-open", locale, page: "available-tools" }),
          label: localizer(locale, "commands.config.panel.plugins_manage_button"),
          disabled: writesDisabled || resolvePermissionsCapabilitiesActionState("manage", actor) !== "enabled",
        },
      ],
    },
  );
  return components;
}

function buildPluginsContextAdditionsBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor } = input;
  const view = input.permissionsView?.capabilities;
  const selfDebug = input.behaviorView?.experimental?.selfDebugEnabled ?? false;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.plugins_context_additions_title")}
${localizer(locale, "commands.config.panel.plugins_context_additions_description")}`,
    },
  ];

  if (actor.workspaceKind === "guild" && !actor.isManager) {
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
      content: `**${localizer(locale, "commands.config.panel.plugins_context_additions_state_title")}**
${localizer(locale, "commands.config.panel.plugins_context_additions_state_description")}
${getCapabilitiesManagePermissionDefinitions({ includeElevenLabs: view.includeElevenLabs })
  .filter((definition) => definition.page === "context-additions")
  .map(
    (definition) =>
      `> ${view.definitionStates[definition.value] ? "🟢" : "🔴"} ${localizer(locale, definition.labelKey)}`,
  )
  .join("\n")}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "permissions-manage-open", locale, page: "context-additions" }),
          label: localizer(locale, "commands.config.panel.plugins_manage_button"),
          disabled: writesDisabled || resolvePermissionsCapabilitiesActionState("manage", actor) !== "enabled",
        },
      ],
    },
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.self_debug_title")}**
${localizer(locale, "commands.config.panel.self_debug_description")}`,
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
      selfDebug,
      writesDisabled || resolvePluginsContextAdditionsActionState("self-debug", actor) !== "enabled",
    ),
    {
      type: ComponentType.TextDisplay,
      content: `> ${localizer(
        locale,
        selfDebug ? "commands.config.panel.self_debug_on" : "commands.config.panel.self_debug_off",
      )}`,
    },
  );
  return components;
}

export interface PersonaRangeEntryInput {
  locale: string;
  personas: readonly TomoriState[];
  pageSize: number;
  selectedPersonaId: number | null;
  disabled: boolean;
  buttonCustomId: string;
  buttonLabelKey: string;
  selectCustomId: string;
  selectPlaceholderKey: string;
  /** Buttons sharing the entry point's row while it is a button, and their own row once it is not. */
  siblingButtons?: ButtonComponentData[];
  /** Places the siblings ahead of the entry point rather than after it, in both layouts. */
  siblingsFirst?: boolean;
}

/**
 * Renders the entry point for a modal whose persona select cannot hold the whole roster.
 *
 * Within one page the plain button is kept, because a select carrying a single range would be the
 * inert one-option selector the shell already avoids. Past that the button becomes a range select,
 * so every persona is reachable through the page that holds it.
 */
function buildPersonaRangeEntry(input: PersonaRangeEntryInput): ComponentInContainerData[] {
  const roster = selectablePersonas(input.personas);
  const siblings = input.siblingButtons ?? [];

  if (roster.length <= input.pageSize) {
    const entryButton: ButtonComponentData = {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: input.buttonCustomId,
      label: localizer(input.locale, input.buttonLabelKey),
      disabled: input.disabled,
    };
    return [
      {
        type: ComponentType.ActionRow,
        components: input.siblingsFirst ? [...siblings, entryButton] : [entryButton, ...siblings],
      } satisfies ActionRowData<ButtonComponentData>,
    ];
  }

  const selectedIndex = roster.findIndex((persona) => persona.persona_id === input.selectedPersonaId);
  const rows: ComponentInContainerData[] = [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: input.selectCustomId,
          placeholder: localizer(input.locale, input.selectPlaceholderKey),
          options: buildRangeSelectOptions({
            totalCount: roster.length,
            pageSize: input.pageSize,
            selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
            describe: (start, end) => ({
              label: safeSelectOptionText(
                localizer(input.locale, "commands.config.panel.channels_persona_range_label", {
                  start: start + 1,
                  end,
                }),
                100,
              ),
              description: safeSelectOptionText(
                localizer(input.locale, "commands.config.panel.channels_persona_range_description", {
                  first: roster[start]?.persona_nickname ?? "",
                  last: roster[end - 1]?.persona_nickname ?? "",
                }),
                100,
              ),
            }),
          }),
          disabled: input.disabled,
        },
      ],
    } satisfies ActionRowData<StringSelectMenuComponentData>,
  ];
  if (siblings.length > 0) {
    const siblingRow = {
      type: ComponentType.ActionRow,
      components: siblings,
    } satisfies ActionRowData<ButtonComponentData>;
    if (input.siblingsFirst) rows.unshift(siblingRow);
    else rows.push(siblingRow);
  }
  return rows;
}

function buildChannelsDestinationsBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor } = input;
  const view = input.channelsView?.destinations;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.channels_destinations_title")}
${localizer(locale, "commands.config.panel.channels_destinations_description")}`,
    },
  ];

  if (actor.workspaceKind === "guild" && !actor.isManager) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only")),
    });
    return components;
  }
  if (!view) return components;

  const actionDisabled = writesDisabled || resolveChannelsDestinationsActionState("log", actor) !== "enabled";
  const logChannelId = view.thoughtLogChannelId;
  const welcomeChannelId = view.welcomeChannelId;
  const none = localizer(locale, "commands.config.panel.none_label");
  const welcomePersona =
    view.welcomePersonaId === null
      ? localizer(locale, "commands.config.panel.channels_welcome_random_label")
      : (input.personas.find((persona) => persona.persona_id === view.welcomePersonaId)?.persona_nickname ?? none);
  const clearLogDisabled = actionDisabled || !logChannelId;
  const clearWelcomeDisabled = actionDisabled || (!welcomeChannelId && !view.welcomePrompt);

  const logTextDisplay: ComponentInContainerData = {
    type: ComponentType.TextDisplay,
    content: `**${localizer(locale, "commands.config.panel.channels_logs_title")}**
${localizer(locale, "commands.config.panel.channels_logs_description")}
> ${localizer(locale, "commands.config.panel.channels_destination_label")}: ${logChannelId ? `<#${logChannelId}>` : none}`,
  };

  const welcomeHeader = `**${localizer(locale, "commands.config.panel.channels_welcome_title")}**
${localizer(locale, "commands.config.panel.channels_welcome_description")}
> ${localizer(locale, "commands.config.panel.channels_destination_label")}: ${welcomeChannelId ? `<#${welcomeChannelId}>` : none}
> ${localizer(locale, "commands.config.panel.channels_welcome_persona_value_label")}: ${welcomePersona}
${localizer(locale, "commands.config.panel.channels_welcome_prompt_value_label")}:
`;
  const baseAllowance = getBasePageTextAllowance(input, false);
  const fixedTextLength =
    measureComponentTextLength([components[0], logTextDisplay]) +
    getDiscordTextLength(welcomeHeader) +
    (view.welcomePrompt ? 0 : getDiscordTextLength(renderFencedCollectionContent(none)));
  const destinationsBudget = Math.max(0, baseAllowance - fixedTextLength);

  components.push(
    logTextDisplay,
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "channels-log-open", locale }),
          label: localizer(locale, "commands.config.panel.channels_set_log_button"),
          disabled: actionDisabled,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({
            action: "channels-log-clear",
            locale,
            ...(logChannelId ? { channelId: logChannelId } : {}),
          }),
          label: localizer(locale, "commands.config.panel.channels_clear_log_button"),
          disabled: clearLogDisabled,
        },
      ],
    },
    {
      type: ComponentType.TextDisplay,
      content: `${welcomeHeader}${
        view.welcomePrompt
          ? renderBoundedFencedContent(locale, view.welcomePrompt, destinationsBudget).rendered
          : renderFencedCollectionContent(none)
      }`,
    },
    ...buildPersonaRangeEntry({
      locale,
      personas: input.personas,
      pageSize: WELCOME_PERSONA_PAGE_SIZE,
      selectedPersonaId: view.welcomePersonaId,
      disabled: actionDisabled,
      buttonCustomId: buildConfigRouteId({ action: "channels-welcome-open", locale }),
      buttonLabelKey: "commands.config.panel.channels_configure_welcome_button",
      selectCustomId: buildConfigRouteId({ action: "channels-welcome-range-select", locale }),
      selectPlaceholderKey: "commands.config.panel.channels_welcome_range_placeholder",
      siblingButtons: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({
            action: "channels-welcome-clear",
            locale,
            ...(welcomeChannelId ? { channelId: welcomeChannelId } : {}),
          }),
          label: localizer(locale, "commands.config.panel.channels_clear_welcome_button"),
          disabled: clearWelcomeDisabled,
        },
      ],
    }),
  );
  return components;
}

function autoTriggerPersonaName(
  channelId: string,
  overrides: ReadonlyMap<string, number>,
  personas: readonly TomoriState[],
  locale: string,
): string {
  const mainPersona = personas.find((persona) => !persona.is_alter) ?? personas[0];
  const personaId = overrides.get(channelId) ?? mainPersona?.persona_id;
  return (
    escapeDiscordMarkdown(personas.find((persona) => persona.persona_id === personaId)?.persona_nickname ?? "") ||
    localizer(locale, "commands.config.panel.none_label")
  );
}

export function buildChannelsAutoTriggerBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor } = input;
  const view = input.channelsView?.autoTrigger;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.channels_auto_trigger_title")}
${localizer(locale, "commands.config.panel.channels_auto_trigger_description")}`,
    },
  ];

  if (actor.workspaceKind === "guild" && !actor.isManager) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only")),
    });
    return components;
  }
  if (!view || !input.channelsView) return components;

  const actionDisabled = writesDisabled || resolveChannelsAutoTriggerActionState("auto-trigger", actor) !== "enabled";
  const rangeIndex = input.channelsAutoTriggerRangeIndex ?? 0;
  const overrides = new Map(view.personaOverrides.map((override) => [override.channel_disc_id, override.persona_id]));
  const enabledRows = view.enabledChannels.map(
    (channel) => `<#${channel.id}>: ${autoTriggerPersonaName(channel.id, overrides, input.personas, locale)}`,
  );
  const threshold =
    view.threshold === 0
      ? localizer(locale, "commands.config.panel.channels_auto_trigger_every_message")
      : view.maxThreshold > view.threshold
        ? localizer(locale, "commands.config.panel.channels_auto_trigger_range_value", {
            min: view.threshold,
            max: view.maxThreshold,
          })
        : localizer(locale, "commands.config.panel.channels_auto_trigger_fixed_value", {
            threshold: view.threshold,
          });

  const enabledHeader = `**${localizer(locale, "commands.config.panel.channels_auto_trigger_enabled_title")}**
${localizer(locale, "commands.config.panel.channels_auto_trigger_enabled_description")}
`;
  const thresholdTextDisplay: ComponentInContainerData = {
    type: ComponentType.TextDisplay,
    content: `**${localizer(locale, "commands.config.panel.channels_auto_trigger_threshold_title")}**
${localizer(locale, "commands.config.panel.channels_auto_trigger_threshold_description")}
> ${localizer(locale, "commands.config.panel.channels_auto_trigger_threshold_value_label")}: ${threshold}`,
  };

  const baseAllowance = getBasePageTextAllowance(input, false);
  const fixedTextLength =
    measureComponentTextLength([components[0], thresholdTextDisplay]) + getDiscordTextLength(enabledHeader);
  const autoTriggerBudget = Math.max(0, baseAllowance - fixedTextLength);

  components.push(
    {
      type: ComponentType.TextDisplay,
      content: `${enabledHeader}${renderBoundedChannelRows(locale, enabledRows, autoTriggerBudget, localizer(locale, "commands.config.panel.channels_auto_trigger_none"))}`,
    },
    ...buildPersonaRangeEntry({
      locale,
      personas: input.personas,
      pageSize: AUTO_TRIGGER_PERSONA_PAGE_SIZE,
      siblingsFirst: true,
      siblingButtons: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "channels-autoch-manage-open", locale, start: rangeIndex }),
          label: localizer(locale, "commands.config.panel.channels_auto_trigger_manage_button"),
          disabled: actionDisabled || input.channelsView.availableTextChannels.length === 0,
        },
      ],
      // Auto-Trigger assigns a persona per channel, so no single stored value can be marked here.
      selectedPersonaId: null,
      disabled: actionDisabled || input.channelsView.availableTextChannels.length === 0,
      buttonCustomId: buildConfigRouteId({ action: "channels-autoch-configure-open", locale }),
      buttonLabelKey: "commands.config.panel.channels_auto_trigger_configure_button",
      selectCustomId: buildConfigRouteId({ action: "channels-autoch-range-select", locale }),
      selectPlaceholderKey: "commands.config.panel.channels_auto_trigger_range_placeholder",
    }),
    {
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, "commands.config.panel.channels_auto_trigger_threshold_title")}**
${localizer(locale, "commands.config.panel.channels_auto_trigger_threshold_description")}
> ${localizer(locale, "commands.config.panel.channels_auto_trigger_threshold_value_label")}: ${threshold}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildConfigRouteId({ action: "channels-autoch-threshold-open", locale }),
          label: localizer(locale, "commands.config.panel.channels_auto_trigger_edit_threshold_button"),
          disabled: writesDisabled || resolveChannelsAutoTriggerActionState("threshold", actor) !== "enabled",
        },
      ],
    },
  );

  const rangeCount = Math.max(
    1,
    Math.ceil(input.channelsView.availableTextChannels.length / CHECKLIST_CHANNELS_PER_PAGE),
  );
  const pagination = buildPaginationRow({
    locale,
    rangeIndex,
    rangeCount,
    namespace: CONFIG_ROUTE_NAMESPACE,
    version: CONFIG_ROUTE_VERSION,
    buildSegments: {
      page: (start) => buildConfigRouteSegments({ action: "channels-autoch-page", locale, start }),
    },
    disabled: writesDisabled,
  });
  if (pagination) components.push(pagination);

  return components;
}

function buildChannelRulesCollectionSection(options: {
  locale: string;
  title: string;
  description: string;
  members: string[];
  budget: number;
  manageCustomId: string;
  manageLabel: string;
  pagination: ActionRowData<ButtonComponentData> | null;
  disabled: boolean;
  noChannels: boolean;
}): ComponentInContainerData[] {
  return [
    {
      type: ComponentType.TextDisplay,
      content: `**${options.title}**
${options.description}
${renderBoundedChannelRows(options.locale, options.members, options.budget, localizer(options.locale, "commands.config.panel.none_label"))}`,
    },
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: options.manageCustomId,
          label: options.manageLabel,
          disabled: options.disabled || options.noChannels,
        },
      ],
    },
    ...(options.pagination ? [options.pagination] : []),
  ];
}

export function buildChannelsRulesBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor } = input;
  const view = input.channelsView?.rules;
  const writesDisabled = input.readStatus !== "fresh";
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.channels_rules_title")}
${localizer(locale, "commands.config.panel.channels_rules_description")}`,
    },
  ];

  if (actor.workspaceKind === "guild" && !actor.isManager) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only")),
    });
    return components;
  }
  if (!view || !input.channelsView) return components;

  const privateTitle = localizer(locale, "commands.config.panel.channels_rules_private_title");
  const privateDesc = localizer(locale, "commands.config.panel.channels_rules_private_description");
  const roleplayTitle = `[${localizer(locale, "commands.config.panel.channels_rules_roleplay_title")}](${buildDocsUrl(DOCS_PATHS.ROLEPLAY_CHANNELS)})`;
  const roleplayDesc = localizer(locale, "commands.config.panel.channels_rules_roleplay_description");
  const blocklistTitle = localizer(locale, "commands.config.panel.channels_rules_blocklist_title");
  const blocklistDesc = localizer(locale, "commands.config.panel.channels_rules_blocklist_description");
  const privacyView = input.permissionsView?.privacy;
  const privacyTitle = localizer(locale, "commands.config.panel.channels_rules_memory_privacy_title");
  const privacyDesc = localizer(locale, "commands.config.panel.channels_rules_memory_privacy_description");

  const baseAllowance = getBasePageTextAllowance(input, false);
  const fixedTextLength =
    measureComponentTextLength(components[0]) +
    getDiscordTextLength(`**${privateTitle}**\n${privateDesc}\n`) +
    (privacyView ? getDiscordTextLength(`**${privacyTitle}**\n${privacyDesc}\n`) : 0) +
    getDiscordTextLength(`**${roleplayTitle}**\n${roleplayDesc}\n`) +
    getDiscordTextLength(`**${blocklistTitle}**\n${blocklistDesc}\n`);
  const rulesAvailable = Math.max(0, baseAllowance - fixedTextLength);
  const rulesPerSectionBudget = Math.floor(rulesAvailable / 3);

  const privateActionDisabled = writesDisabled || resolveChannelsRulesActionState("private", actor) !== "enabled";
  const roleplayActionDisabled = writesDisabled || resolveChannelsRulesActionState("roleplay", actor) !== "enabled";
  const blocklistActionDisabled = writesDisabled || resolveChannelsRulesActionState("blocklist", actor) !== "enabled";
  const privateRangeCount = Math.max(
    1,
    Math.ceil(input.channelsView.availableTextChannels.length / CHECKLIST_CHANNELS_PER_PAGE),
  );
  const roleplayRangeCount = privateRangeCount;
  const blocklistRangeCount = Math.max(
    1,
    Math.ceil(input.channelsView.availableBlocklistChannels.length / CHECKLIST_CHANNELS_PER_PAGE),
  );

  components.push(
    ...buildChannelRulesCollectionSection({
      locale,
      title: localizer(locale, "commands.config.panel.channels_rules_private_title"),
      description: localizer(locale, "commands.config.panel.channels_rules_private_description"),
      members: view.privateChannels.map((channel) => `<#${channel.id}>`),
      budget: rulesPerSectionBudget,
      manageCustomId: buildConfigRouteId({
        action: "channels-private-manage-open",
        locale,
        start: input.channelsPrivateRangeIndex ?? 0,
      }),
      manageLabel: localizer(locale, "commands.config.panel.channels_rules_private_manage_button"),
      pagination: buildPaginationRow({
        locale,
        rangeIndex: input.channelsPrivateRangeIndex ?? 0,
        rangeCount: privateRangeCount,
        namespace: CONFIG_ROUTE_NAMESPACE,
        version: CONFIG_ROUTE_VERSION,
        buildSegments: {
          page: (start) => buildConfigRouteSegments({ action: "channels-private-page", locale, start }),
        },
        disabled: writesDisabled,
      }),
      disabled: privateActionDisabled,
      noChannels: input.channelsView.availableTextChannels.length === 0,
    }),
    ...(privacyView
      ? [
          {
            type: ComponentType.TextDisplay as const,
            content: `**${privacyTitle}**\n${privacyDesc}`,
          },
          buildStateControlRow(
            [
              {
                value: false,
                label: localizer(locale, "commands.config.panel.off_button"),
                customId: buildConfigRouteId({ action: "permissions-privacy-bypass-set", locale, enabled: false }),
              },
              {
                value: true,
                label: localizer(locale, "commands.config.panel.on_button"),
                customId: buildConfigRouteId({ action: "permissions-privacy-bypass-set", locale, enabled: true }),
              },
            ],
            privacyView.stmPrivacyBypass,
            writesDisabled || resolvePermissionsPrivacyActionState("privacy-bypass", actor) !== "enabled",
          ),
          {
            type: ComponentType.TextDisplay as const,
            content: withLinePrefix(
              "> ",
              localizer(
                locale,
                privacyView.stmPrivacyBypass
                  ? "commands.config.panel.permissions_privacy_on"
                  : "commands.config.panel.permissions_privacy_off",
              ),
            ),
          },
          {
            type: ComponentType.TextDisplay as const,
            content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.permissions_privacy_direction")),
          },
        ]
      : []),
    ...buildChannelRulesCollectionSection({
      locale,
      title: `[${localizer(locale, "commands.config.panel.channels_rules_roleplay_title")}](${buildDocsUrl(DOCS_PATHS.ROLEPLAY_CHANNELS)})`,
      description: localizer(locale, "commands.config.panel.channels_rules_roleplay_description"),
      members: view.roleplayChannels.map((channel) => `<#${channel.id}>`),
      budget: rulesPerSectionBudget,
      manageCustomId: buildConfigRouteId({
        action: "channels-rp-manage-open",
        locale,
        start: input.channelsRoleplayRangeIndex ?? 0,
      }),
      manageLabel: localizer(locale, "commands.config.panel.channels_rules_roleplay_manage_button"),
      pagination: buildPaginationRow({
        locale,
        rangeIndex: input.channelsRoleplayRangeIndex ?? 0,
        rangeCount: roleplayRangeCount,
        namespace: CONFIG_ROUTE_NAMESPACE,
        version: CONFIG_ROUTE_VERSION,
        buildSegments: {
          page: (start) => buildConfigRouteSegments({ action: "channels-rp-page", locale, start }),
        },
        disabled: writesDisabled,
      }),
      disabled: roleplayActionDisabled,
      noChannels: input.channelsView.availableTextChannels.length === 0,
    }),
    ...buildChannelRulesCollectionSection({
      locale,
      title: localizer(locale, "commands.config.panel.channels_rules_blocklist_title"),
      description: localizer(locale, "commands.config.panel.channels_rules_blocklist_description"),
      members: view.crossChannelBlocklist.map((channel) => `<#${channel.id}>`),
      budget: rulesPerSectionBudget,
      manageCustomId: buildConfigRouteId({
        action: "channels-blocklist-manage-open",
        locale,
        start: input.channelsBlocklistRangeIndex ?? 0,
      }),
      manageLabel: localizer(locale, "commands.config.panel.channels_rules_blocklist_manage_button"),
      pagination: buildPaginationRow({
        locale,
        rangeIndex: input.channelsBlocklistRangeIndex ?? 0,
        rangeCount: blocklistRangeCount,
        namespace: CONFIG_ROUTE_NAMESPACE,
        version: CONFIG_ROUTE_VERSION,
        buildSegments: {
          page: (start) => buildConfigRouteSegments({ action: "channels-blocklist-page", locale, start }),
        },
        disabled: writesDisabled,
      }),
      disabled: blocklistActionDisabled,
      noChannels: input.channelsView.availableBlocklistChannels.length === 0,
    }),
  );

  return components;
}

function channelOverrideModelLabel(locale: string, model: LlmRow | null): string {
  return model
    ? `${model.llm_provider} / ${model.llm_codename}`
    : localizer(locale, "commands.config.panel.none_label");
}

function buildChannelsOverridesBody(input: ConfigPanelRenderInput): ComponentInContainerData[] {
  const { locale, actor } = input;
  const channelsView = input.channelsView;
  const overrides: ConfigChannelsOverridesView | undefined = channelsView?.overrides;
  const selectedChannelId =
    input.channelsSelectedChannelId !== undefined
      ? input.channelsSelectedChannelId
      : (overrides?.selectedChannelId ?? null);
  const selectedChannel = channelsView?.availableOverrideChannels.find((channel) => channel.id === selectedChannelId);
  const writesDisabled = input.readStatus !== "fresh";
  const actionDisabled =
    writesDisabled || resolveChannelsOverridesActionState("prompt", actor) !== "enabled" || !selectedChannel;
  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.channels_overrides_title")}
${localizer(locale, "commands.config.panel.channels_overrides_description")}`,
    },
    {
      type: ComponentType.TextDisplay,
      content: localizer(locale, "commands.config.panel.channels_overrides_select_description"),
    },
  ];

  const channelSelector: ActionRowData<ChannelSelectMenuComponentData> = {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.ChannelSelect,
        customId: buildConfigRouteId({ action: "channels-overrides-select", locale }),
        placeholder: localizer(locale, "commands.config.panel.channels_overrides_select_placeholder"),
        channelTypes: [
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread,
        ],
        minValues: 1,
        maxValues: 1,
        defaultValues: selectedChannelId ? [{ id: selectedChannelId, type: SelectMenuDefaultValueType.Channel }] : [],
        disabled: writesDisabled || actor.workspaceKind === "dm" || !actor.isManager,
      },
    ],
  };
  components.push(channelSelector);

  if (actor.workspaceKind === "guild" && !actor.isManager) {
    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only")),
    });
  }

  const none = localizer(locale, "commands.config.panel.none_label");
  const prompt = overrides?.prompt;
  const contextNote = overrides?.contextNote;
  const textOverride = overrides?.textModelOverride ?? null;
  const serverTextModel = input.personas[0]?.llm ?? null;
  const hasPromptContent = Boolean(prompt?.prompt);
  const hasContextContent = Boolean(contextNote?.note);

  const promptTitleDesc = `**${localizer(locale, "commands.config.panel.channels_overrides_prompt_title")}**
${localizer(locale, "commands.config.panel.channels_overrides_prompt_description")}`;
  const contextTitleDesc = `**${localizer(locale, "commands.config.panel.channels_overrides_context_note_title")}**
${localizer(locale, "commands.config.panel.channels_overrides_context_note_description")}`;
  const textModelTitleDesc = `**${localizer(locale, "commands.config.panel.channels_overrides_text_model_title")}**
${localizer(locale, "commands.config.panel.channels_overrides_text_model_description")}`;

  const promptMode = prompt
    ? localizer(locale, `commands.config.panel.channels_overrides_prompt_mode_${prompt.mode}`)
    : none;
  const promptModeLine = selectedChannel
    ? `> ${localizer(locale, "commands.config.panel.channels_overrides_prompt_mode_label")}: ${promptMode}\n`
    : "";
  const contextDepthLine = selectedChannel
    ? `> ${localizer(locale, "commands.config.panel.channels_overrides_context_note_depth_label")}: ${contextNote?.depth ?? none}\n`
    : "";
  const textModelValues = selectedChannel
    ? `> ${localizer(locale, "commands.config.panel.channels_overrides_channel_override_label")}: ${channelOverrideModelLabel(locale, textOverride)}
> ${localizer(locale, "commands.config.panel.channels_overrides_server_default_label")}: ${channelOverrideModelLabel(locale, serverTextModel)}`
    : "";
  const noneContent = renderFencedCollectionContent(none);

  const baseAllowance = getBasePageTextAllowance(input, false);
  let fixedTextLength = measureComponentTextLength(components);
  fixedTextLength += getDiscordTextLength(promptTitleDesc);
  if (selectedChannel) {
    fixedTextLength += getDiscordTextLength(promptModeLine);
    if (!hasPromptContent) fixedTextLength += getDiscordTextLength(noneContent);

    fixedTextLength += getDiscordTextLength(contextTitleDesc);
    fixedTextLength += getDiscordTextLength(contextDepthLine);
    if (!hasContextContent) fixedTextLength += getDiscordTextLength(noneContent);

    fixedTextLength += getDiscordTextLength(textModelTitleDesc);
    fixedTextLength += getDiscordTextLength(textModelValues);
  }
  const overridesDynamicAllowance = Math.max(0, baseAllowance - fixedTextLength);
  const overridesPerValueBudget =
    hasPromptContent && hasContextContent ? Math.floor(overridesDynamicAllowance / 2) : overridesDynamicAllowance;

  components.push({
    type: ComponentType.TextDisplay,
    content: promptTitleDesc,
  });
  if (selectedChannel) {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `> ${localizer(locale, "commands.config.panel.channels_overrides_prompt_mode_label")}: ${promptMode}
${
  prompt?.prompt
    ? renderBoundedFencedContent(locale, prompt.prompt, overridesPerValueBudget).rendered
    : renderFencedCollectionContent(none)
}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({
              action: "channels-overrides-prompt-open",
              locale,
              channelId: selectedChannel.id,
            }),
            label: localizer(locale, "commands.config.panel.channels_overrides_set_prompt_button"),
            disabled: actionDisabled,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({
              action: "channels-overrides-prompt-clear",
              locale,
              channelId: selectedChannel.id,
              fp: computeChannelOverridesFingerprintForView(input, selectedChannel.id),
            }),
            label: localizer(locale, "commands.config.panel.channels_overrides_clear_prompt_button"),
            disabled: actionDisabled || !prompt,
          },
        ],
      },
    );
  }

  components.push({
    type: ComponentType.TextDisplay,
    content: `**${localizer(locale, "commands.config.panel.channels_overrides_context_note_title")}**
${localizer(locale, "commands.config.panel.channels_overrides_context_note_description")}`,
  });
  if (selectedChannel) {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `> ${localizer(locale, "commands.config.panel.channels_overrides_context_note_depth_label")}: ${contextNote?.depth ?? none}
${
  contextNote?.note
    ? renderBoundedFencedContent(locale, contextNote.note, overridesPerValueBudget).rendered
    : renderFencedCollectionContent(none)
}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({
              action: "channels-overrides-context-note-open",
              locale,
              channelId: selectedChannel.id,
            }),
            label: localizer(locale, "commands.config.panel.channels_overrides_edit_context_note_button"),
            disabled: actionDisabled,
          },
        ],
      },
    );
  }

  components.push({
    type: ComponentType.TextDisplay,
    content: `**${localizer(locale, "commands.config.panel.channels_overrides_text_model_title")}**
${localizer(locale, "commands.config.panel.channels_overrides_text_model_description")}`,
  });
  if (selectedChannel) {
    components.push({
      type: ComponentType.TextDisplay,
      content: `> ${localizer(locale, "commands.config.panel.channels_overrides_channel_override_label")}: ${channelOverrideModelLabel(locale, textOverride)}
> ${localizer(locale, "commands.config.panel.channels_overrides_server_default_label")}: ${channelOverrideModelLabel(locale, serverTextModel)}`,
    });

    const textView = input.view;
    if (textView?.kind === "channel-text-override-provider" && textView.channelId === selectedChannel.id) {
      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildConfigRouteId({
              action: "channels-overrides-text-provider-select",
              locale,
              channelId: selectedChannel.id,
              fp: textView.fp,
            }),
            placeholder: localizer(locale, "commands.config.panel.text_override_provider_placeholder"),
            options: textView.providers.map((provider) => ({
              label: safeSelectOptionText(provider, 100),
              value: provider,
            })),
            disabled: actionDisabled,
          },
        ],
      });
    } else if (textView?.kind === "channel-text-override-model-range" && textView.channelId === selectedChannel.id) {
      const pageCount = Math.max(1, Math.ceil(textView.modelCount / CONFIG_MODEL_PAGE_SIZE));
      const rangeWindowSize = pageCount > CONFIG_MODEL_PAGE_SIZE ? CONFIG_MODEL_PAGE_SIZE - 1 : pageCount;
      const rangePageIndex = Math.min(Math.max(textView.rangePageIndex, 0), pageCount - 1);
      const visiblePageCount = Math.min(rangeWindowSize, pageCount - rangePageIndex);
      const rangeOptions = Array.from({ length: visiblePageCount }, (_, offset) => {
        const pageIndex = rangePageIndex + offset;
        return {
          label: safeSelectOptionText(
            localizer(locale, "commands.config.panel.provider_page_label", {
              provider: textView.provider,
              page: pageIndex + 1,
            }),
            100,
          ),
          value: String(pageIndex * CONFIG_MODEL_PAGE_SIZE),
        };
      });
      if (pageCount > CONFIG_MODEL_PAGE_SIZE) {
        const nextRangePageIndex =
          rangePageIndex + visiblePageCount < pageCount ? rangePageIndex + visiblePageCount : 0;
        rangeOptions.push({
          label: safeSelectOptionText(
            localizer(locale, "commands.config.panel.model_provider_more_option", {
              capability: localizer(locale, "commands.config.panel.capability_text"),
              page: nextRangePageIndex + 1,
              total: pageCount,
            }),
            100,
          ),
          value: `__range__${nextRangePageIndex}`,
        });
      }
      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildConfigRouteId({
              action: "channels-overrides-text-model-range-select",
              locale,
              channelId: selectedChannel.id,
              provider: textView.provider,
              fp: textView.fp,
            }),
            placeholder: localizer(locale, "commands.config.panel.text_override_model_placeholder"),
            options: rangeOptions,
            disabled: actionDisabled,
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
            customId: buildConfigRouteId({
              action: "channels-overrides-text-open",
              locale,
              channelId: selectedChannel.id,
            }),
            label: localizer(locale, "commands.config.panel.change_override_button"),
            disabled: actionDisabled,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildConfigRouteId({
              action: "channels-overrides-text-clear",
              locale,
              channelId: selectedChannel.id,
              fp: computeChannelOverridesFingerprintForView(input, selectedChannel.id),
            }),
            label: localizer(locale, "commands.config.panel.clear_override_button"),
            disabled: actionDisabled || !textOverride,
          },
        ],
      });
    }
  }

  return components;
}

function computeChannelOverridesFingerprintForView(input: ConfigPanelRenderInput, channelId: string): string {
  const overrides = input.channelsView?.overrides;
  const state = input.personas[0];
  return computeChannelOverridesFingerprint(
    state?.server_id ?? 0,
    channelId,
    overrides?.prompt ?? null,
    overrides?.contextNote ?? null,
    overrides?.textModelOverride?.llm_id ?? null,
    state?.llm?.llm_id ?? null,
  );
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
    const personaNavigationId =
      input.selectedPersonaId ?? input.personas.find((persona) => persona.is_alter !== true)?.persona_id;
    const pageSelectorRow: ActionRowData<StringSelectMenuComponentData> = {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildConfigRouteId(
            category === "persona" && personaNavigationId !== undefined
              ? {
                  action: "persona-page-select",
                  locale,
                  category,
                  page,
                  personaId: personaNavigationId,
                }
              : { action: "page", locale, category, page },
          ),
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
    appendPersonaCreateHint(components, locale);
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "triggers") {
    components.push(...buildPersonaTriggersBody(input));
    appendPersonaCreateHint(components, locale);
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "memories") {
    components.push(...buildPersonaMemoriesBody(input));
    appendPersonaCreateHint(components, locale);
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "naming") {
    components.push(...buildPersonaNamingBody(input));
    appendPersonaCreateHint(components, locale);
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "sprites") {
    components.push(...buildPersonaSpritesBody(input));
    appendPersonaCreateHint(components, locale);
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "appearance") {
    if (resolveConfigPageState(category, page, actor) !== "omitted") {
      components.push(...buildPersonaAppearanceBody(input));
    }
    appendPersonaCreateHint(components, locale);
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "advanced") {
    if (resolveConfigPageState(category, page, actor) !== "omitted") {
      components.push(...buildPersonaAdvancedBody(input));
    }
    appendPersonaCreateHint(components, locale);
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "overrides") {
    if (resolveConfigPageState(category, page, actor) !== "omitted") {
      components.push(...buildPersonaOverridesBody(input));
    }
    appendPersonaCreateHint(components, locale);
    return buildPayload(components, receipt);
  }

  if (category === "persona" && page === "voice") {
    if (resolveConfigPageState(category, page, actor) !== "omitted") {
      const selectedPersona = input.personas.find((persona) => persona.persona_id === input.selectedPersonaId) ?? null;
      components.push(
        ...buildConfigVoiceBody({
          locale,
          actor,
          readStatus,
          selectedPersona,
          selectedPersonaAvatarUrl: input.selectedPersonaAvatarUrl,
          view: input.personaVoiceView,
          remoteView: input.personaVoiceRemoteView,
          samplePageStart: input.personaVoicePageStart,
          remotePageStart: input.personaVoicePageStart,
        }),
      );
    }
    appendPersonaCreateHint(components, locale);
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
          voicesView: input.voicesView,
        }),
      );
    }
    return buildPayload(components, receipt, page === "voices" ? buildVoiceSampleFiles(input.voicesView) : []);
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

  if (category === "plugins" && page === "available-tools") {
    components.push(...buildPluginsAvailableToolsBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "plugins" && page === "context-additions") {
    components.push(...buildPluginsContextAdditionsBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "channels" && page === "destinations") {
    components.push(...buildChannelsDestinationsBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "channels" && page === "auto-trigger") {
    components.push(...buildChannelsAutoTriggerBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "channels" && page === "rules") {
    components.push(...buildChannelsRulesBody(input));
    return buildPayload(components, receipt);
  }

  if (category === "channels" && page === "overrides") {
    components.push(...buildChannelsOverridesBody(input));
    return buildPayload(components, receipt);
  }

  // Every other destination lands in a later Phase D slice. `/config` registers no slash command
  // until that cutover, so this placeholder is unreachable rather than shipped.
  const fallbackPageKey = PAGE_LOCALE_KEYS[category]?.[page];
  if (!fallbackPageKey) {
    components.push({
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.config.panel.unavailable")}`,
    });
    return buildPayload(components, receipt);
  }
  components.push({
    type: ComponentType.TextDisplay,
    content: `### ${localizer(locale, fallbackPageKey)}
${localizer(locale, "commands.config.panel.page_pending")}${
  resolveConfigPageState(category, page, actor) === "read-only"
    ? `\n${withLinePrefix("-# ", localizer(locale, "commands.config.panel.page_read_only"))}`
    : ""
}`,
  });
  return buildPayload(components, receipt);
}
