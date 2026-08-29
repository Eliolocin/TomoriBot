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
  type TextDisplayComponentData,
  type TopLevelComponentData,
} from "discord.js";
import type { ServerMemoryRow, TomoriState } from "@/types/db/schema";
import type { ModalCheckboxGroupField } from "@/types/discord/modal";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import { resolveRangeSelection } from "@/utils/discord/interactions/panelController";
import {
  buildMemoriesRouteId,
  buildMemoriesRouteSegments,
  MEMORIES_ROUTE_NAMESPACE,
  MEMORIES_ROUTE_VERSION,
  type MemoriesCategory,
} from "@/utils/discord/memoriesPanelCatalog";
import type { DocumentChunkRow, DocumentListRow } from "@/utils/discord/interactions/memoriesDocumentOperations";
import {
  buildCategoryButtonRow,
  buildPanelContainer,
  buildPanelReceiptContainer,
  buildRangeChooserComponents,
  RANGE_BUTTONS_PER_ROW,
  withLinePrefix,
} from "@/utils/discord/ui/panel";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { localizer } from "@/utils/text/localizer";

const MAX_SERVER_MEMORY_PAGE_SIZE = 24;
const MAX_DOCUMENT_PAGE_SIZE = 24;
export const MAX_STM_OPTIONS_PER_GROUP = 10;
const MAX_STM_GROUPS = 5;
/**
 * Ceiling on entries one removal modal can present.
 *
 * The submit handler derives its clear set from the rows it presented, so a route reading a
 * different group count than the modal built would see nothing checked and clear every entry.
 * Both sides read this instead of repeating the product.
 */
export const MAX_STM_MANAGEABLE_ENTRIES = MAX_STM_OPTIONS_PER_GROUP * MAX_STM_GROUPS;
const PERSONA_SELECT_MAX_OPTIONS = 25;
const MAX_SERVER_MEMORY_TAGS = 5;
const MAX_SERVER_MEMORY_TAG_LENGTH = 32;

const memoryLimits = getMemoryLimits();

export function parseServerMemoryTags(rawTags: string): string[] {
  if (!rawTags?.trim()) return [];
  const parts = rawTags
    .split(",")
    .map((t) => t.trim().replace(/^["']+|["']+$/g, ""))
    .filter((t) => t.length > 0 && t.length <= MAX_SERVER_MEMORY_TAG_LENGTH);
  return [...new Set(parts)].slice(0, MAX_SERVER_MEMORY_TAGS);
}

export function buildServerMemoryModalFieldId(field: "content" | "tags" | "file", nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildDocumentModalFieldId(field: "name" | "file" | "channels" | "content", nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildStmCheckboxFieldId(groupIndex: number, nonce: string): string {
  return `stm_${groupIndex}_${nonce}`;
}

export function buildAddDocumentModal(
  locale: string,
  personaId: number,
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const limits = getMemoryLimits();
  return {
    custom_id: buildMemoriesRouteId({ action: "document-add-submit", locale, personaId, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.memories.document_add_modal_title"), 45),
    components: [
      {
        type: ComponentType.Label,
        label: safeSelectOptionText(localizer(locale, "commands.memories.document_name_label"), 45),
        component: {
          type: ComponentType.TextInput,
          custom_id: buildDocumentModalFieldId("name", nonce),
          style: TextInputStyle.Short,
          max_length: 64,
          required: true,
        },
      },
      {
        type: ComponentType.Label,
        label: safeSelectOptionText(localizer(locale, "commands.memories.document_file_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.memories.document_file_description", { max: limits.maxDocumentSizeMB }),
          100,
        ),
        component: {
          type: ComponentType.FileUpload,
          custom_id: buildDocumentModalFieldId("file", nonce),
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
      {
        type: ComponentType.Label,
        label: safeSelectOptionText(localizer(locale, "commands.memories.document_channels_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.memories.document_channels_description"), 100),
        component: {
          type: ComponentType.TextInput,
          custom_id: buildDocumentModalFieldId("channels", nonce),
          style: TextInputStyle.Short,
          max_length: 200,
          required: false,
        },
      },
    ],
  };
}

/**
 * Channel filters carried by a stored memory's tag list.
 *
 * Tags reach the database quoted from some writers, so the quotes come off before the `#` test;
 * otherwise a quoted channel tag reads as a plain tag and the filter silently disappears when a
 * memory is vectorized.
 */
function channelTagsFromStoredTags(tags: string[]): string[] {
  return tags.map((tag) => tag.replace(/^["']+|["']+$/g, "")).filter((tag) => tag.startsWith("#"));
}

export function buildVectorizeMemoryModal(
  locale: string,
  lineageId: number,
  personaId: number,
  memoryId: number,
  content: string,
  tags: string[],
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildMemoriesRouteId({
      action: "vectorize-submit",
      locale,
      lineageId,
      personaId,
      memoryId,
      nonce,
    }),
    title: safeSelectOptionText(localizer(locale, "commands.memories.vectorize_modal_title"), 45),
    components: [
      {
        type: ComponentType.Label,
        label: safeSelectOptionText(localizer(locale, "commands.memories.vectorize_content_label"), 45),
        component: {
          type: ComponentType.TextInput,
          custom_id: buildDocumentModalFieldId("content", nonce),
          style: TextInputStyle.Paragraph,
          value: content,
          max_length: memoryLimits.maxMemoryLength,
          required: true,
        },
      },
      {
        type: ComponentType.Label,
        label: safeSelectOptionText(localizer(locale, "commands.memories.document_name_label"), 45),
        component: {
          type: ComponentType.TextInput,
          custom_id: buildDocumentModalFieldId("name", nonce),
          style: TextInputStyle.Short,
          max_length: 64,
          required: true,
        },
      },
      {
        type: ComponentType.Label,
        label: safeSelectOptionText(localizer(locale, "commands.memories.document_channels_label"), 45),
        component: {
          type: ComponentType.TextInput,
          custom_id: buildDocumentModalFieldId("channels", nonce),
          style: TextInputStyle.Short,
          value: channelTagsFromStoredTags(tags).join(", "),
          max_length: 200,
          required: false,
        },
      },
    ],
  };
}

export function buildEditDocumentChunkModal(
  locale: string,
  personaId: number,
  documentId: number,
  chunkIdx: number,
  content: string,
  channelTags: string[],
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildMemoriesRouteId({
      action: "document-chunk-edit-submit",
      locale,
      personaId,
      documentId,
      chunkIdx,
      nonce,
    }),
    title: safeSelectOptionText(localizer(locale, "commands.memories.document_chunk_edit_title"), 45),
    components: [
      {
        type: ComponentType.Label,
        label: safeSelectOptionText(localizer(locale, "commands.memories.document_chunk_content_label"), 45),
        component: {
          type: ComponentType.TextInput,
          custom_id: buildDocumentModalFieldId("content", nonce),
          style: TextInputStyle.Paragraph,
          value: content,
          max_length: 4000,
          required: true,
        },
      },
      {
        type: ComponentType.Label,
        label: safeSelectOptionText(localizer(locale, "commands.memories.document_channels_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.memories.document_channels_description"), 100),
        component: {
          type: ComponentType.TextInput,
          custom_id: buildDocumentModalFieldId("channels", nonce),
          style: TextInputStyle.Short,
          value: channelTags.join(", "),
          max_length: 200,
          required: false,
        },
      },
    ],
  };
}

export interface StmPanelEntry {
  channelId: string;
  channelName?: string;
  personaId?: number | null;
  personaName: string;
  summary?: string;
  lastUpdated: number;
}

function checkboxGroupToRaw(locale: string, field: ModalCheckboxGroupField): RawDiscordComponent {
  return {
    type: ComponentType.Label,
    label: safeSelectOptionText(localizer(locale, field.labelKey), 45),
    description: field.descriptionKey ? safeSelectOptionText(localizer(locale, field.descriptionKey), 100) : undefined,
    component: {
      type: ComponentType.CheckboxGroup,
      custom_id: field.customId,
      min_values: field.minValues,
      max_values: field.maxValues,
      required: field.required,
      options: field.options,
    },
  };
}

export function buildServerStmModal(
  locale: string,
  entries: StmPanelEntry[],
  fingerprint: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  const groups: ModalCheckboxGroupField[] = [];
  for (let start = 0; start < entries.length; start += MAX_STM_OPTIONS_PER_GROUP) {
    const groupIndex = Math.floor(start / MAX_STM_OPTIONS_PER_GROUP);
    groups.push({
      kind: "checkboxGroup",
      customId: buildStmCheckboxFieldId(groupIndex, fingerprint),
      labelKey:
        groupIndex === 0 ? "commands.memories.stm_checkbox_label" : "commands.memories.stm_checkbox_label_continued",
      descriptionKey: groupIndex === 0 ? "commands.memories.stm_checkbox_description" : undefined,
      minValues: 0,
      required: false,
      options: entries.slice(start, start + MAX_STM_OPTIONS_PER_GROUP).map((entry) => ({
        label: safeSelectOptionText(`${entry.personaName} - #${entry.channelName ?? entry.channelId}`, 100),
        value: buildMemoriesRouteId({
          action: "stm-entry",
          locale,
          channelId: entry.channelId,
          personaId: entry.personaId ?? 0,
        }),
        description: entry.summary ? safeSelectOptionText(entry.summary.replace(/\s+/g, " "), 100) : undefined,
        default: true,
      })),
    });
  }
  return {
    custom_id: buildMemoriesRouteId({ action: "stm-submit", locale, nonce: fingerprint }),
    title: safeSelectOptionText(localizer(locale, "commands.memories.stm_modal_title"), 45),
    components: groups.map((group) => checkboxGroupToRaw(locale, group)),
  };
}

export function buildAddServerMemoryModal(
  locale: string,
  lineageId: number,
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildMemoriesRouteId({ action: "add-submit", locale, lineageId, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.memories.add_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.memories.modal_content_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.memories.modal_content_placeholder"), 100),
        component: {
          type: 4,
          custom_id: buildServerMemoryModalFieldId("content", nonce),
          style: TextInputStyle.Paragraph,
          placeholder: safeSelectOptionText(localizer(locale, "commands.memories.modal_content_placeholder"), 100),
          max_length: memoryLimits.maxMemoryLength,
          required: false,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.memories.modal_file_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.memories.modal_file_description"), 100),
        component: {
          type: 19,
          custom_id: buildServerMemoryModalFieldId("file", nonce),
          min_values: 0,
          max_values: 1,
          required: false,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.memories.modal_tags_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.memories.modal_tags_description"), 100),
        component: {
          type: 4,
          custom_id: buildServerMemoryModalFieldId("tags", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(localizer(locale, "commands.memories.modal_tags_placeholder"), 100),
          max_length: MAX_SERVER_MEMORY_TAGS * (MAX_SERVER_MEMORY_TAG_LENGTH + 2),
          required: false,
        },
      },
    ],
  };
}

export function buildEditServerMemoryModal(
  locale: string,
  lineageId: number,
  memoryId: number,
  content: string,
  tags: string[],
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildMemoriesRouteId({ action: "edit-submit", locale, lineageId, memoryId, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.memories.edit_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.memories.modal_content_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.memories.modal_content_placeholder"), 100),
        component: {
          type: 4,
          custom_id: buildServerMemoryModalFieldId("content", nonce),
          style: TextInputStyle.Paragraph,
          placeholder: safeSelectOptionText(localizer(locale, "commands.memories.modal_content_placeholder"), 100),
          value: content,
          max_length: memoryLimits.maxMemoryLength,
          required: true,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.memories.modal_tags_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.memories.modal_tags_description"), 100),
        component: {
          type: 4,
          custom_id: buildServerMemoryModalFieldId("tags", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(localizer(locale, "commands.memories.modal_tags_placeholder"), 100),
          value: tags.join(", "),
          max_length: MAX_SERVER_MEMORY_TAGS * (MAX_SERVER_MEMORY_TAG_LENGTH + 2),
          required: false,
        },
      },
    ],
  };
}

/**
 * The persona that stands for a whole lineage in the selector.
 *
 * Shared by the option label and the header thumbnail so the name and the face always describe
 * the same persona. A non-alter member wins because it is the one the lineage is named after.
 */
export function personaRepresentativeForLineage(personas: TomoriState[], lineageId: number): TomoriState | null {
  const sharing = personas.filter((persona) => persona.persona_lineage_id === lineageId);
  return sharing.find((persona) => !persona.is_alter) ?? sharing[0] ?? null;
}

/**
 * Renders one memory as a fenced block so it reads as content rather than panel prose.
 *
 * The fence is why the text is not markdown-escaped: escapes render literally inside a code block.
 * A memory holding its own triple backtick would close the fence early and spill the rest of the
 * panel into the block, so the sequence is broken with a zero-width space, which Discord renders as
 * nothing and does not treat as a fence.
 */
function renderMemoryBlock(content: string): string {
  const fenceSafe = content.replaceAll("```", "`\u200b``");
  return ["```markdown", fenceSafe, "```"].join("\n");
}

function describeServerLineageMemories(locale: string, count: number | undefined, personaCount: number): string {
  const memoryCount = count ?? 0;
  const singular = memoryCount === 1;
  if (personaCount > 1) {
    return localizer(
      locale,
      singular ? "commands.memories.persona_memory_count_one_shared" : "commands.memories.persona_memory_count_shared",
      { count: memoryCount, personas: personaCount },
    );
  }
  return localizer(
    locale,
    singular ? "commands.memories.persona_memory_count_one" : "commands.memories.persona_memory_count",
    { count: memoryCount },
  );
}

type MemoriesPanelPage =
  | { kind: "main"; selectedMemoryId?: number; rangeIndex?: number }
  | { kind: "range-chooser"; chooserPage?: number }
  | { kind: "remove"; memoryId: number }
  | { kind: "vectorize"; memoryId: number; personaId: number }
  | { kind: "documents"; selectedDocumentId?: number; chunkIdx?: number; rangeIndex?: number }
  | { kind: "document-range-chooser"; chooserPage?: number }
  | { kind: "document-remove"; documentId: number; historyOnly: boolean }
  | { kind: "document-chunk-remove"; documentId: number; chunkIdx: number };

export interface MemoriesPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export interface MemoriesPanelRenderInput {
  locale: string;
  category: MemoriesCategory;
  selectedLineageId: number;
  personas: TomoriState[];
  memoryCountsByLineage?: ReadonlyMap<number, number>;
  selectedPersonaAvatarUrl?: string | null;
  memories: ServerMemoryRow[];
  selectedDocumentPersonaId?: number;
  documents?: DocumentListRow[];
  documentCount?: number;
  documentChunkCount?: number;
  documentChunks?: DocumentChunkRow[];
  documentCountsByPersona?: ReadonlyMap<number, number>;
  eligibleHistoryPersonaIds?: ReadonlySet<number>;
  stmEntries?: StmPanelEntry[];
  stmCount?: number;
  memteachingEnabled?: boolean;
  canManage: boolean;
  readStatus: PanelReadStatus;
  page: MemoriesPanelPage;
  receipt?: PanelReceipt;
}

function buildPayload(components: ComponentInContainerData[], receipt?: PanelReceipt): MemoriesPanelPayload {
  const topLevelComponents: TopLevelComponentData[] = [];
  if (receipt) {
    topLevelComponents.push(buildPanelReceiptContainer(receipt));
  }
  topLevelComponents.push(buildPanelContainer(components));
  return {
    components: topLevelComponents,
    flags: MessageFlags.IsComponentsV2,
  };
}

function buildRetryRow(
  locale: string,
  category: MemoriesCategory,
  lineageId?: number,
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildMemoriesRouteId({ action: "retry", locale, category, lineageId }),
        label: localizer(locale, "commands.memories.retry"),
      },
    ],
  };
}

export function buildMemoriesPanelPayload(input: MemoriesPanelRenderInput): MemoriesPanelPayload {
  const {
    locale,
    category,
    selectedLineageId,
    personas,
    memoryCountsByLineage,
    selectedPersonaAvatarUrl,
    memories,
    canManage,
    readStatus,
    page,
    receipt,
  } = input;
  const writesDisabled = readStatus !== "fresh";
  const memberTeachingBlocked = !canManage && input.memteachingEnabled === false;

  const categoryButtons = buildCategoryButtonRow(
    [
      {
        id: "memories",
        label: localizer(locale, "commands.memories.category_memories"),
        customId: buildMemoriesRouteId({ action: "category", locale, category: "memories" }),
      },
      {
        id: "documents",
        label: localizer(locale, "commands.memories.category_documents"),
        customId: buildMemoriesRouteId({ action: "category", locale, category: "documents" }),
      },
      {
        id: "stm",
        label: localizer(locale, "commands.memories.category_stm"),
        customId: buildMemoriesRouteId({ action: "category", locale, category: "stm" }),
      },
    ],
    category,
    readStatus === "unavailable",
  );

  const components: ComponentInContainerData[] = [
    categoryButtons,
    { type: ComponentType.Separator, divider: true, spacing: 1 },
  ];

  if (readStatus === "unavailable") {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.memories.unavailable")}`,
      },
      {
        type: ComponentType.TextDisplay,
        content: withLinePrefix("-# ", localizer(locale, "commands.memories.stale_warning")),
      },
      buildRetryRow(locale, category, selectedLineageId),
    );
    return buildPayload(components, receipt);
  }

  if (page.kind === "remove") {
    const targetMemory = memories.find((m) => m.server_memory_id === page.memoryId);
    if (targetMemory?.server_memory_id) {
      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.memories.remove_title")}\n${localizer(
            locale,
            "commands.memories.remove_confirm_description",
            {
              memory: renderMemoryBlock(targetMemory.content),
            },
          )}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildMemoriesRouteId({
                action: "remove-confirm",
                locale,
                lineageId: selectedLineageId,
                memoryId: targetMemory.server_memory_id,
              }),
              label: localizer(locale, "commands.memories.remove_confirm"),
              disabled: writesDisabled,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildMemoriesRouteId({
                action: "remove-cancel",
                locale,
                lineageId: selectedLineageId,
                memoryId: targetMemory.server_memory_id,
              }),
              label: localizer(locale, "commands.memories.cancel"),
            },
          ],
        },
      );
      return buildPayload(components, receipt);
    }
  }

  if (page.kind === "vectorize") {
    const targetMemory = memories.find((memory) => memory.server_memory_id === page.memoryId);
    if (targetMemory?.server_memory_id) {
      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.memories.vectorize_title")}\n${localizer(
            locale,
            "commands.memories.vectorize_impact",
            { memory: renderMemoryBlock(targetMemory.content) },
          )}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildMemoriesRouteId({
                action: "vectorize-confirm",
                locale,
                lineageId: selectedLineageId,
                personaId: page.personaId,
                memoryId: targetMemory.server_memory_id,
              }),
              label: localizer(locale, "commands.memories.vectorize_confirm"),
              disabled: writesDisabled,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildMemoriesRouteId({
                action: "vectorize-cancel",
                locale,
                lineageId: selectedLineageId,
                personaId: page.personaId,
                memoryId: targetMemory.server_memory_id,
              }),
              label: localizer(locale, "commands.memories.cancel"),
            },
          ],
        },
      );
      return buildPayload(components, receipt);
    }
  }

  if (category === "memories") {
    const personaHeading: TextDisplayComponentData = {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.memories.memories_title")}\n${localizer(locale, "commands.memories.memories_description")}`,
    };

    components.push(
      selectedPersonaAvatarUrl
        ? {
            type: ComponentType.Section,
            components: [personaHeading],
            accessory: { type: ComponentType.Thumbnail, media: { url: selectedPersonaAvatarUrl } },
          }
        : personaHeading,
    );

    if (personas.length === 0) {
      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.memories.no_personas"),
      });
    } else {
      const personasByLineage = new Map<number, TomoriState[]>();
      for (const p of personas) {
        const lineage = p.persona_lineage_id;
        if (lineage === undefined || lineage === null || lineage === 0) continue;
        const bucket = personasByLineage.get(lineage);
        if (bucket) bucket.push(p);
        else personasByLineage.set(lineage, [p]);
      }

      const lineageEntries = [...personasByLineage.entries()];
      const visibleLineages = lineageEntries.slice(0, PERSONA_SELECT_MAX_OPTIONS);
      const hiddenLineageCount = lineageEntries.length - visibleLineages.length;

      const personaOptions: SelectMenuComponentOptionData[] = visibleLineages.map(([lineage, sharing]) => {
        const representative = personaRepresentativeForLineage(sharing, lineage);
        // The selected lineage's loaded rows are the freshest count available for it; every other
        // lineage falls back to zero rather than to a guess, because this number renders as
        // authoritative and an eligibility flag cannot say how many.
        const count = lineage === selectedLineageId ? memories.length : (memoryCountsByLineage?.get(lineage) ?? 0);
        return {
          label: safeSelectOptionText(
            representative?.persona_nickname || localizer(locale, "commands.memories.persona_default_name"),
            100,
          ),
          value: String(lineage),
          description: safeSelectOptionText(describeServerLineageMemories(locale, count, sharing.length), 100),
          default: lineage === selectedLineageId,
        };
      });

      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildMemoriesRouteId({ action: "persona-select", locale, lineageId: selectedLineageId }),
            placeholder: localizer(locale, "commands.memories.persona_select_placeholder"),
            options: personaOptions,
            disabled: writesDisabled,
          },
        ],
      });

      if (hiddenLineageCount > 0) {
        components.push({
          type: ComponentType.TextDisplay,
          content: withLinePrefix(
            "-# ",
            localizer(locale, "commands.memories.persona_select_truncated", { count: hiddenLineageCount }),
          ),
        });
      }

      // A non-manager's list and counts are already filtered to their own rows, and nothing on the
      // page said so, which reads as missing data rather than as scoping.
      if (!canManage) {
        components.push({
          type: ComponentType.TextDisplay,
          content: withLinePrefix("-# ", localizer(locale, "commands.memories.owner_scope_notice")),
        });
      }

      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.memories.selector_guidance"),
      });

      if (page.kind === "range-chooser") {
        components.push(
          ...buildRangeChooserComponents({
            locale,
            totalCount: memories.length,
            pageSize: MAX_SERVER_MEMORY_PAGE_SIZE,
            chooserPage: page.chooserPage,
            namespace: MEMORIES_ROUTE_NAMESPACE,
            version: MEMORIES_ROUTE_VERSION,
            buildSegments: {
              range: (rangeIndex) =>
                buildMemoriesRouteSegments({ action: "range", locale, lineageId: selectedLineageId, rangeIndex }),
              previous: (targetPage) =>
                buildMemoriesRouteSegments({
                  action: "range-page",
                  locale,
                  lineageId: selectedLineageId,
                  chooserPage: targetPage,
                }),
              next: (targetPage) =>
                buildMemoriesRouteSegments({
                  action: "range-page",
                  locale,
                  lineageId: selectedLineageId,
                  chooserPage: targetPage,
                }),
              cancel: () =>
                buildMemoriesRouteSegments({ action: "range-cancel", locale, lineageId: selectedLineageId }),
            },
          }),
        );
        return buildPayload(components, receipt);
      }

      const mainPage = page.kind === "main" ? page : { kind: "main" as const };
      const rangeIndex = mainPage.rangeIndex ?? 0;
      const rangeSelection = resolveRangeSelection(memories, rangeIndex, MAX_SERVER_MEMORY_PAGE_SIZE);

      let selectedMemory: ServerMemoryRow | null = null;
      if (mainPage.selectedMemoryId) {
        selectedMemory = memories.find((m) => m.server_memory_id === mainPage.selectedMemoryId) ?? null;
      }
      if (!selectedMemory && rangeSelection.visibleItems.length > 0) {
        selectedMemory = rangeSelection.visibleItems[0] ?? null;
      }

      const addOption: SelectMenuComponentOptionData = {
        label: safeSelectOptionText(`+ ${localizer(locale, "commands.memories.add_option")}`, 100),
        value: "action:add",
        description: safeSelectOptionText(localizer(locale, "commands.memories.add_option_description"), 100),
      };

      const memoryOptions: SelectMenuComponentOptionData[] = rangeSelection.visibleItems.map((memory) => {
        const label = safeSelectOptionText(memory.content.replace(/\s+/g, " ").trim(), 100);
        const tagsText = memory.tags && memory.tags.length > 0 ? memory.tags.join(", ") : undefined;
        return {
          label: label || localizer(locale, "commands.memories.empty_memory_label"),
          value: String(memory.server_memory_id),
          description: tagsText ? safeSelectOptionText(tagsText, 100) : undefined,
          default: selectedMemory?.server_memory_id === memory.server_memory_id,
        };
      });

      const selectRow: ActionRowData<StringSelectMenuComponentData> = {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildMemoriesRouteId({
              action: "select",
              locale,
              lineageId: selectedLineageId,
              rangeIndex: rangeSelection.rangeIndex,
            }),
            placeholder: localizer(locale, "commands.memories.select_placeholder"),
            options: [addOption, ...memoryOptions],
            disabled: writesDisabled,
          },
        ],
      };
      components.push(selectRow);

      if (rangeSelection.rangeCount > 1) {
        if (rangeSelection.rangeCount <= RANGE_BUTTONS_PER_ROW) {
          const rangeButtons: ButtonComponentData[] = [];
          for (let i = 0; i < rangeSelection.rangeCount; i++) {
            const start = i * MAX_SERVER_MEMORY_PAGE_SIZE + 1;
            const end = Math.min(start + MAX_SERVER_MEMORY_PAGE_SIZE - 1, memories.length);
            rangeButtons.push({
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildMemoriesRouteId({
                action: "range",
                locale,
                lineageId: selectedLineageId,
                rangeIndex: i,
              }),
              label: `${start}-${end}`,
              disabled: writesDisabled || i === rangeSelection.rangeIndex,
            });
          }
          components.push({
            type: ComponentType.ActionRow,
            components: rangeButtons,
          });
        } else {
          components.push({
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildMemoriesRouteId({ action: "range-open", locale, lineageId: selectedLineageId }),
                label: localizer(locale, "general.pagination.select_page_title"),
                disabled: writesDisabled,
              },
            ],
          });
        }
      }

      if (selectedMemory) {
        components.push({
          type: ComponentType.TextDisplay,
          content: renderMemoryBlock(selectedMemory.content),
        });
      } else {
        components.push({
          type: ComponentType.TextDisplay,
          content: `> ${localizer(
            locale,
            canManage ? "commands.memories.no_memories" : "commands.memories.no_owned_memories",
          )}`,
        });
      }

      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildMemoriesRouteId({
              action: "edit-open",
              locale,
              lineageId: selectedLineageId,
              memoryId: selectedMemory?.server_memory_id ?? 0,
            }),
            label: localizer(locale, "commands.memories.edit_button"),
            disabled: writesDisabled || !selectedMemory,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildMemoriesRouteId({
              action: "vectorize-prompt",
              locale,
              lineageId: selectedLineageId,
              personaId: personaRepresentativeForLineage(personas, selectedLineageId)?.persona_id ?? 0,
              memoryId: selectedMemory?.server_memory_id ?? 0,
            }),
            label: localizer(locale, "commands.memories.vectorize_button"),
            disabled: writesDisabled || !selectedMemory,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildMemoriesRouteId({
              action: "remove-prompt",
              locale,
              lineageId: selectedLineageId,
              memoryId: selectedMemory?.server_memory_id ?? 0,
            }),
            label: localizer(locale, "commands.memories.remove_button"),
            disabled: writesDisabled || !selectedMemory,
          },
        ],
      });
    }
  } else if (category === "documents") {
    const documentsHeading: TextDisplayComponentData = {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.memories.documents_title")}
${localizer(locale, "commands.memories.documents_description")}`,
    };
    // The thumbnail belongs to the persona scope only: serverwide documents have no persona whose
    // face could stand for them. Only the heading shares the Section, so the rest of the page keeps
    // the 65-character budget rather than the 40 that applies beside a Thumbnail.
    components.push(
      input.selectedDocumentPersonaId && selectedPersonaAvatarUrl
        ? {
            type: ComponentType.Section,
            components: [documentsHeading],
            accessory: { type: ComponentType.Thumbnail, media: { url: selectedPersonaAvatarUrl } },
          }
        : documentsHeading,
    );
    if (memberTeachingBlocked) {
      components.push({
        type: ComponentType.TextDisplay,
        content: withLinePrefix("> ", localizer(locale, "commands.memories.documents_teaching_disabled")),
      });
      return buildPayload(components, receipt);
    }

    // 0 is the serverwide sentinel and the page's default scope, so an absent selection stays 0
    // rather than falling through to whichever persona happens to sort first.
    const selectedPersonaId = input.selectedDocumentPersonaId ?? 0;
    const repositoryPersonaId = selectedPersonaId === 0 ? null : selectedPersonaId;
    const firstPersonaId = input.personas.find((persona) => persona.persona_id)?.persona_id ?? 0;
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildMemoriesRouteId({ action: "document-scope", locale, personaId: 0 }),
          label: localizer(locale, "commands.memories.document_scope_serverwide"),
          disabled: writesDisabled || repositoryPersonaId === null,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildMemoriesRouteId({ action: "document-scope", locale, personaId: firstPersonaId }),
          label: localizer(locale, "commands.memories.document_scope_persona"),
          disabled: writesDisabled || repositoryPersonaId !== null,
        },
      ],
    });

    if (repositoryPersonaId !== null) {
      const personaOptions: SelectMenuComponentOptionData[] = input.personas
        .filter((persona) => persona.persona_id)
        .slice(0, PERSONA_SELECT_MAX_OPTIONS)
        .map((persona) => {
          const personaId = persona.persona_id ?? 0;
          const count = input.documentCountsByPersona?.get(personaId) ?? 0;
          const hasHistory = input.eligibleHistoryPersonaIds?.has(personaId) ?? false;
          return {
            label: safeSelectOptionText(persona.persona_nickname, 100),
            value: String(personaId),
            description: safeSelectOptionText(
              count === 0
                ? localizer(locale, "commands.memories.document_persona_empty")
                : localizer(
                    locale,
                    hasHistory
                      ? count === 1
                        ? "commands.memories.document_persona_count_one_history"
                        : "commands.memories.document_persona_count_history"
                      : count === 1
                        ? "commands.memories.document_persona_count_one"
                        : "commands.memories.document_persona_count",
                    { count },
                  ),
              100,
            ),
            default: personaId === repositoryPersonaId,
          };
        });
      if (personaOptions.length > 0) {
        components.push({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: buildMemoriesRouteId({
                action: "document-persona-select",
                locale,
                personaId: repositoryPersonaId,
              }),
              placeholder: localizer(locale, "commands.memories.document_persona_placeholder"),
              options: personaOptions,
              disabled: writesDisabled,
            },
          ],
        });
      }
      const hidden = input.personas.filter((persona) => persona.persona_id).length - personaOptions.length;
      if (hidden > 0) {
        components.push({
          type: ComponentType.TextDisplay,
          content: withLinePrefix(
            "-# ",
            localizer(locale, "commands.memories.persona_select_truncated", { count: hidden }),
          ),
        });
      }
    }

    components.push({
      type: ComponentType.TextDisplay,
      content: withLinePrefix(
        "> ",
        localizer(locale, "commands.memories.document_counts", {
          documents: input.documentCount ?? 0,
          chunks: input.documentChunkCount ?? 0,
        }),
      ),
    });

    const documents = input.documents ?? [];
    if (page.kind === "document-range-chooser") {
      components.push(
        ...buildRangeChooserComponents({
          locale,
          totalCount: documents.length,
          pageSize: MAX_DOCUMENT_PAGE_SIZE,
          chooserPage: page.chooserPage,
          namespace: MEMORIES_ROUTE_NAMESPACE,
          version: MEMORIES_ROUTE_VERSION,
          buildSegments: {
            range: (rangeIndex) =>
              buildMemoriesRouteSegments({
                action: "document-range",
                locale,
                personaId: selectedPersonaId,
                rangeIndex,
              }),
            previous: (targetPage) =>
              buildMemoriesRouteSegments({
                action: "document-range-page",
                locale,
                personaId: selectedPersonaId,
                chooserPage: targetPage,
              }),
            next: (targetPage) =>
              buildMemoriesRouteSegments({
                action: "document-range-page",
                locale,
                personaId: selectedPersonaId,
                chooserPage: targetPage,
              }),
            cancel: () =>
              buildMemoriesRouteSegments({
                action: "document-range-cancel",
                locale,
                personaId: selectedPersonaId,
              }),
          },
        }),
      );
      return buildPayload(components, receipt);
    }
    if (page.kind === "document-remove") {
      const target = documents.find((document) => document.document_id === page.documentId);
      if (target) {
        components.push(
          {
            type: ComponentType.TextDisplay,
            content: page.historyOnly
              ? `### ${localizer(locale, "commands.memories.history_remove_title")}\n${localizer(
                  locale,
                  "commands.memories.history_remove_description",
                  { name: target.document_name },
                )}`
              : `### ${localizer(locale, "commands.memories.document_remove_title")}\n${localizer(
                  locale,
                  "commands.memories.document_remove_description",
                  { name: target.document_name },
                )}`,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Danger,
                customId: buildMemoriesRouteId({
                  action: page.historyOnly ? "history-remove-confirm" : "document-remove-confirm",
                  locale,
                  personaId: selectedPersonaId,
                  documentId: target.document_id,
                }),
                label: localizer(locale, "commands.memories.remove_confirm"),
                disabled: writesDisabled,
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildMemoriesRouteId({
                  action: page.historyOnly ? "history-remove-cancel" : "document-remove-cancel",
                  locale,
                  personaId: selectedPersonaId,
                  documentId: target.document_id,
                }),
                label: localizer(locale, "commands.memories.cancel"),
              },
            ],
          },
        );
        return buildPayload(components, receipt);
      }
    }

    const documentPage: Extract<MemoriesPanelPage, { kind: "documents" }> =
      page.kind === "documents"
        ? page
        : page.kind === "document-chunk-remove"
          ? { kind: "documents", selectedDocumentId: page.documentId, chunkIdx: page.chunkIdx }
          : { kind: "documents" };
    const range = resolveRangeSelection(documents, documentPage.rangeIndex ?? 0, MAX_DOCUMENT_PAGE_SIZE);
    let selectedDocument = documents.find((document) => document.document_id === documentPage.selectedDocumentId);
    selectedDocument ??= range.visibleItems[0];
    const documentOptions: SelectMenuComponentOptionData[] = [
      {
        label: safeSelectOptionText(`+ ${localizer(locale, "commands.memories.document_add_option")}`, 100),
        value: "action:add-document",
        description: safeSelectOptionText(localizer(locale, "commands.memories.document_add_option_description"), 100),
      },
      ...range.visibleItems.map((document) => ({
        label: safeSelectOptionText(document.document_name, 100),
        value: String(document.document_id),
        description: document.first_chunk
          ? safeSelectOptionText(document.first_chunk.replace(/\s+/g, " "), 100)
          : undefined,
        default: selectedDocument?.document_id === document.document_id,
      })),
    ];
    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildMemoriesRouteId({
            action: "document-select",
            locale,
            personaId: selectedPersonaId,
            rangeIndex: range.rangeIndex,
          }),
          placeholder: localizer(locale, "commands.memories.document_select_placeholder"),
          options: documentOptions,
          disabled: writesDisabled,
        },
      ],
    });
    if (range.rangeCount > 1) {
      if (range.rangeCount <= RANGE_BUTTONS_PER_ROW) {
        const buttons: ButtonComponentData[] = [];
        for (let index = 0; index < range.rangeCount; index++) {
          const start = index * MAX_DOCUMENT_PAGE_SIZE + 1;
          const end = Math.min(start + MAX_DOCUMENT_PAGE_SIZE - 1, documents.length);
          buttons.push({
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildMemoriesRouteId({
              action: "document-range",
              locale,
              personaId: selectedPersonaId,
              rangeIndex: index,
            }),
            label: `${start}-${end}`,
            disabled: writesDisabled || index === range.rangeIndex,
          });
        }
        components.push({ type: ComponentType.ActionRow, components: buttons });
      } else {
        components.push({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildMemoriesRouteId({
                action: "document-range-open",
                locale,
                personaId: selectedPersonaId,
              }),
              label: localizer(locale, "general.pagination.select_page_title"),
              disabled: writesDisabled,
            },
          ],
        });
      }
    }

    if (!selectedDocument) {
      components.push({
        type: ComponentType.TextDisplay,
        content: `> ${localizer(locale, "commands.memories.documents_empty")}`,
      });
    } else {
      const chunks = input.documentChunks ?? [];
      // chunkIdx on the wire is the stored chunk_index, not a list position: deleteChunk leaves
      // gaps, so the two stop agreeing after the first removal and only chunk_index addresses a row.
      const requestedPosition = chunks.findIndex((candidate) => candidate.chunk_index === documentPage.chunkIdx);
      const chunkIndex = requestedPosition >= 0 ? requestedPosition : 0;
      const chunk = chunks[chunkIndex];
      components.push({
        type: ComponentType.TextDisplay,
        content: `**${safeSelectOptionText(selectedDocument.document_name, 250)}**`,
      });
      components.push({
        type: ComponentType.TextDisplay,
        content: chunk
          ? renderMemoryBlock(chunk.content.slice(0, 3800))
          : `> ${localizer(locale, "commands.memories.document_no_chunks")}`,
      });
      if (chunks.length > 1) {
        components.push({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildMemoriesRouteId({
                action: "document-chunk-prev",
                locale,
                personaId: selectedPersonaId,
                documentId: selectedDocument.document_id,
                chunkIdx: chunks[Math.max(0, chunkIndex - 1)]?.chunk_index ?? 0,
              }),
              label: localizer(locale, "commands.memories.previous"),
              disabled: chunkIndex === 0,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildMemoriesRouteId({
                action: "document-chunk-next",
                locale,
                personaId: selectedPersonaId,
                documentId: selectedDocument.document_id,
                chunkIdx: chunks[Math.min(chunks.length - 1, chunkIndex + 1)]?.chunk_index ?? 0,
              }),
              label: localizer(locale, "commands.memories.next"),
              disabled: chunkIndex === chunks.length - 1,
            },
          ],
        });
      }
      const actionButtons: ButtonComponentData[] = [];
      if (canManage && chunk) {
        actionButtons.push(
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildMemoriesRouteId({
              action: "document-chunk-edit-open",
              locale,
              personaId: selectedPersonaId,
              documentId: selectedDocument.document_id,
              chunkIdx: chunk.chunk_index,
            }),
            label: localizer(locale, "commands.memories.document_chunk_edit_button"),
            disabled: writesDisabled || chunk.content.length > 4000,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildMemoriesRouteId({
              action: "document-chunk-remove-prompt",
              locale,
              personaId: selectedPersonaId,
              documentId: selectedDocument.document_id,
              chunkIdx: chunk.chunk_index,
            }),
            label: localizer(locale, "commands.memories.document_chunk_remove_button"),
            disabled: writesDisabled,
          },
        );
      }
      actionButtons.push({
        type: ComponentType.Button,
        style: ButtonStyle.Danger,
        customId: buildMemoriesRouteId({
          action: selectedDocument.isHistory ? "history-remove-prompt" : "document-remove-prompt",
          locale,
          personaId: selectedPersonaId,
          documentId: selectedDocument.document_id,
        }),
        label: localizer(
          locale,
          selectedDocument.isHistory
            ? "commands.memories.history_remove_button"
            : "commands.memories.document_remove_button",
        ),
        disabled: writesDisabled,
      });
      components.push({ type: ComponentType.ActionRow, components: actionButtons });

      if (page.kind === "document-chunk-remove" && chunk) {
        components.push(
          {
            type: ComponentType.TextDisplay,
            content: `### ${localizer(locale, "commands.memories.document_chunk_remove_title")}\n${localizer(
              locale,
              chunks.length === 1
                ? "commands.memories.document_chunk_remove_last_description"
                : "commands.memories.document_chunk_remove_description",
            )}`,
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Danger,
                customId: buildMemoriesRouteId({
                  action: "document-chunk-remove-confirm",
                  locale,
                  personaId: selectedPersonaId,
                  documentId: selectedDocument.document_id,
                  chunkIdx: chunk.chunk_index,
                }),
                label: localizer(locale, "commands.memories.remove_confirm"),
                disabled: writesDisabled,
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                customId: buildMemoriesRouteId({
                  action: "document-chunk-remove-cancel",
                  locale,
                  personaId: selectedPersonaId,
                  documentId: selectedDocument.document_id,
                  chunkIdx: chunk.chunk_index,
                }),
                label: localizer(locale, "commands.memories.cancel"),
              },
            ],
          },
        );
      }
    }
  } else if (category === "stm") {
    components.push({
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.memories.stm_title")}`,
    });
    if (!canManage) {
      components.push({
        type: ComponentType.TextDisplay,
        content: withLinePrefix("> ", localizer(locale, "commands.memories.stm_manager_only")),
      });
    } else {
      const count = input.stmCount ?? 0;
      if (count === 0) {
        components.push({
          type: ComponentType.TextDisplay,
          content: `> ${localizer(locale, "commands.memories.stm_empty")}`,
        });
      } else {
        components.push(
          {
            type: ComponentType.TextDisplay,
            content: `> ${localizer(locale, "commands.memories.stm_active_count", { count })}`,
          },
          ...(input.stmEntries ?? []).slice(0, MAX_STM_OPTIONS_PER_GROUP).map((entry) => ({
            type: ComponentType.TextDisplay as const,
            content: `> **${entry.personaName}** - <#${entry.channelId}>`,
          })),
        );
        if (count > MAX_STM_MANAGEABLE_ENTRIES) {
          components.push({
            type: ComponentType.TextDisplay,
            content: withLinePrefix(
              "-# ",
              localizer(locale, "commands.memories.stm_too_many", {
                count,
                max: MAX_STM_MANAGEABLE_ENTRIES,
              }),
            ),
          });
        } else {
          components.push({
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Danger,
                customId: buildMemoriesRouteId({ action: "stm-open", locale }),
                label: localizer(locale, "commands.memories.stm_manage_button"),
                disabled: writesDisabled,
              },
            ],
          });
        }
      }
    }
  }

  return buildPayload(components, receipt);
}
