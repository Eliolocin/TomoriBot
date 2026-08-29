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
  | { kind: "remove"; memoryId: number };

export interface MemoriesPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export interface MemoriesPanelRenderInput {
  locale: string;
  category: MemoriesCategory;
  selectedLineageId: number;
  personas: TomoriState[];
  eligibleLineageIds?: ReadonlySet<number>;
  memoryCountsByLineage?: ReadonlyMap<number, number>;
  selectedPersonaAvatarUrl?: string | null;
  memories: ServerMemoryRow[];
  stmCount?: number;
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
    eligibleLineageIds,
    memoryCountsByLineage,
    selectedPersonaAvatarUrl,
    memories,
    canManage,
    readStatus,
    page,
    receipt,
  } = input;
  const writesDisabled = readStatus !== "fresh";

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
        const count =
          memoryCountsByLineage?.get(lineage) ??
          (lineage === selectedLineageId ? memories.length : eligibleLineageIds?.has(lineage) ? 1 : 0);
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
          content: `> ${localizer(locale, "commands.memories.no_memories")}`,
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
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.memories.documents_title")}\n${localizer(locale, "commands.memories.documents_description")}`,
      },
      {
        type: ComponentType.TextDisplay,
        content: withLinePrefix("> ", localizer(locale, "commands.memories.documents_pending")),
      },
    );
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
        components.push({
          type: ComponentType.TextDisplay,
          content: `> ${localizer(locale, "commands.memories.stm_active_count", { count })}`,
        });
      }
    }
  }

  return buildPayload(components, receipt);
}
