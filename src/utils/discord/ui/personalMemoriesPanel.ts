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
import { PrivacyLevel, type PersonalMemoryRow, type TomoriState } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import { resolveRangeSelection } from "@/utils/discord/interactions/panelController";
import {
  buildPersonalMemoriesRouteId,
  buildPersonalMemoriesRouteSegments,
  PERSONAL_MEMORIES_ROUTE_NAMESPACE,
  PERSONAL_MEMORIES_ROUTE_VERSION,
  type PersonalMemoriesCategory,
} from "@/utils/discord/personalMemoriesPanelCatalog";
import {
  buildCategoryButtonRow,
  buildOptionalThumbnailSection,
  buildPanelContainer,
  buildPanelReceiptContainer,
  buildPaginationRow,
  withLinePrefix,
} from "@/utils/discord/ui/panel";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { localizer } from "@/utils/text/localizer";
import { personaRepresentativeForLineage } from "@/utils/persona/lineage";

export const MAX_PERSONAL_MEMORY_PAGE_SIZE = 24;
const PERSONA_SELECT_MAX_OPTIONS = 25;

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

/**
 * Option description for one persona lineage in the memories selector.
 *
 * Counts exclude global memories, matching what selecting that persona actually lists. The four
 * variants stay literal rather than composed: `check-locales` only sees literal keys, so a
 * fragment-built string can go missing with every gate green.
 */
function describeLineageMemories(locale: string, memoryCount: number, personaCount: number): string {
  const singular = memoryCount === 1;
  if (personaCount > 1) {
    return localizer(
      locale,
      singular
        ? "commands.personal.memories.persona_memory_count_one_shared"
        : "commands.personal.memories.persona_memory_count_shared",
      { count: memoryCount, personas: personaCount },
    );
  }
  return localizer(
    locale,
    singular
      ? "commands.personal.memories.persona_memory_count_one"
      : "commands.personal.memories.persona_memory_count",
    { count: memoryCount },
  );
}
const MAX_PERSONAL_MEMORY_TAGS = 5;
const MAX_PERSONAL_MEMORY_TAG_LENGTH = 32;

const memoryLimits = getMemoryLimits();

type PersonalMemoriesPanelPage =
  | { kind: "main"; selectedMemoryId?: number; rangeIndex?: number; personaRangeIndex?: number }
  | { kind: "remove"; memoryId: number };

export interface PersonalMemoriesPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export interface PersonalMemoriesPanelRenderInput {
  locale: string;
  category: PersonalMemoriesCategory;
  selectedLineageId: number;
  personas: TomoriState[];
  memoryCountsByLineage?: ReadonlyMap<number, number>;
  selectedPersonaAvatarUrl?: string | null;
  memories: PersonalMemoryRow[];
  stmCount: number;
  privacyLevel: PrivacyLevel;
  readStatus: PanelReadStatus;
  page: PersonalMemoriesPanelPage;
  receipt?: PanelReceipt;
}

export function parsePersonalMemoryTags(rawTags: string): string[] {
  if (!rawTags?.trim()) return [];
  const parts = rawTags
    .split(",")
    .map((t) => t.trim().replace(/^["']+|["']+$/g, ""))
    .filter((t) => t.length > 0 && t.length <= MAX_PERSONAL_MEMORY_TAG_LENGTH);
  return [...new Set(parts)].slice(0, MAX_PERSONAL_MEMORY_TAGS);
}

export function buildPersonalMemoryModalFieldId(field: "content" | "tags" | "file", nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildAddPersonalMemoryModal(
  locale: string,
  category: PersonalMemoriesCategory,
  lineageId: number,
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalMemoriesRouteId({ action: "add-submit", locale, category, lineageId, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.personal.memories.add_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.memories.modal_content_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.memories.modal_content_placeholder"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildPersonalMemoryModalFieldId("content", nonce),
          style: TextInputStyle.Paragraph,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.memories.modal_content_placeholder"),
            100,
          ),
          max_length: memoryLimits.maxMemoryLength,
          // Optional because the file field below can supply the memories instead. The submit
          // handler rejects the case where both arrive empty.
          required: false,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.memories.modal_file_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.memories.modal_file_description"), 100),
        component: {
          // 19 is FileUpload. 22 is CheckboxGroup and 3 is StringSelect, and Discord accepts any of
          // them in a modal without complaint, so the number is load-bearing.
          type: 19,
          custom_id: buildPersonalMemoryModalFieldId("file", nonce),
          min_values: 0,
          max_values: 1,
          required: false,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.memories.modal_tags_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.memories.modal_tags_description"), 100),
        component: {
          type: 4,
          custom_id: buildPersonalMemoryModalFieldId("tags", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.memories.modal_tags_placeholder"),
            100,
          ),
          max_length: MAX_PERSONAL_MEMORY_TAGS * (MAX_PERSONAL_MEMORY_TAG_LENGTH + 2),
          required: false,
        },
      },
    ],
  };
}

export function buildEditPersonalMemoryModal(
  locale: string,
  category: PersonalMemoriesCategory,
  lineageId: number,
  memoryId: number,
  content: string,
  tags: string[],
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalMemoriesRouteId({
      action: "edit-submit",
      locale,
      category,
      lineageId,
      memoryId,
      nonce,
    }),
    title: safeSelectOptionText(localizer(locale, "commands.personal.memories.edit_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.memories.modal_content_label"), 45),
        description: safeSelectOptionText(
          localizer(locale, "commands.personal.memories.modal_content_placeholder"),
          100,
        ),
        component: {
          type: 4,
          custom_id: buildPersonalMemoryModalFieldId("content", nonce),
          style: TextInputStyle.Paragraph,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.memories.modal_content_placeholder"),
            100,
          ),
          max_length: memoryLimits.maxMemoryLength,
          required: true,
          value: content,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.personal.memories.modal_tags_label"), 45),
        description: safeSelectOptionText(localizer(locale, "commands.personal.memories.modal_tags_description"), 100),
        component: {
          type: 4,
          custom_id: buildPersonalMemoryModalFieldId("tags", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(
            localizer(locale, "commands.personal.memories.modal_tags_placeholder"),
            100,
          ),
          max_length: MAX_PERSONAL_MEMORY_TAGS * (MAX_PERSONAL_MEMORY_TAG_LENGTH + 2),
          required: false,
          value: tags.join(", "),
        },
      },
    ],
  };
}

function buildRetryRow(
  locale: string,
  category: PersonalMemoriesCategory,
  lineageId: number,
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildPersonalMemoriesRouteId({ action: "retry", locale, category, lineageId }),
        label: localizer(locale, "commands.personal.memories.retry"),
      },
    ],
  };
}

function buildPayload(components: ComponentInContainerData[], receipt?: PanelReceipt): PersonalMemoriesPanelPayload {
  return {
    components: [...(receipt ? [buildPanelReceiptContainer(receipt)] : []), buildPanelContainer(components)],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function buildPersonalMemoriesPanelPayload(
  input: PersonalMemoriesPanelRenderInput,
): PersonalMemoriesPanelPayload {
  const {
    locale,
    category,
    selectedLineageId,
    personas,
    memoryCountsByLineage,
    selectedPersonaAvatarUrl,
    memories,
    privacyLevel,
    readStatus,
    page,
    receipt,
  } = input;
  const writesDisabled = readStatus !== "fresh";
  const isPrivacyFull = privacyLevel === PrivacyLevel.FULL;

  const categoryButtons = buildCategoryButtonRow(
    [
      {
        id: "global",
        label: localizer(locale, "commands.personal.memories.category_global"),
        customId: buildPersonalMemoriesRouteId({ action: "category", locale, category: "global" }),
      },
      {
        id: "persona",
        label: localizer(locale, "commands.personal.memories.category_persona"),
        customId: buildPersonalMemoriesRouteId({ action: "category", locale, category: "persona" }),
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
        content: `### ${localizer(locale, "commands.personal.memories.unavailable")}`,
      },
      buildRetryRow(locale, category, selectedLineageId),
    );
    return buildPayload(components, receipt);
  }

  if (page.kind === "remove") {
    const targetMemory = memories.find((m) => m.personal_memory_id === page.memoryId);
    if (targetMemory?.personal_memory_id) {
      components.push(
        {
          type: ComponentType.TextDisplay,
          content: `### ${localizer(locale, "commands.personal.memories.remove_title")}
${localizer(locale, "commands.personal.memories.remove_confirm_description", {
  memory: renderMemoryBlock(targetMemory.content),
})}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildPersonalMemoriesRouteId({
                action: "remove-confirm",
                locale,
                category,
                lineageId: selectedLineageId,
                memoryId: targetMemory.personal_memory_id,
              }),
              label: localizer(locale, "commands.personal.memories.remove_confirm"),
              disabled: writesDisabled,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalMemoriesRouteId({
                action: "remove-cancel",
                locale,
                category,
                lineageId: selectedLineageId,
                memoryId: targetMemory.personal_memory_id,
              }),
              label: localizer(locale, "commands.personal.memories.cancel"),
            },
          ],
        },
      );
      return buildPayload(components, receipt);
    }
  }

  const rangeIndex = page.kind === "main" ? (page.rangeIndex ?? 0) : 0;
  const rangeSelection = resolveRangeSelection(memories, rangeIndex, MAX_PERSONAL_MEMORY_PAGE_SIZE);

  let selectedMemory: PersonalMemoryRow | null = null;
  if (page.kind === "main" && page.selectedMemoryId) {
    selectedMemory = memories.find((m) => m.personal_memory_id === page.selectedMemoryId) ?? null;
  }
  if (!selectedMemory && memories.length > 0) {
    selectedMemory = rangeSelection.visibleItems[0] ?? memories[0] ?? null;
  }

  if (category === "global") {
    components.push({
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.personal.memories.global_title")}
${localizer(locale, "commands.personal.memories.global_description")}
${localizer(locale, "commands.personal.memories.selector_guidance")}`,
    });

    if (isPrivacyFull) {
      components.push({
        type: ComponentType.TextDisplay,
        content: withLinePrefix("> ", `⚠️ ${localizer(locale, "commands.personal.memories.privacy_full_warning")}`),
      });
    }

    const addOption: SelectMenuComponentOptionData = {
      label: safeSelectOptionText(`+ ${localizer(locale, "commands.personal.memories.add_option")}`, 100),
      value: "action:add",
      description: safeSelectOptionText(localizer(locale, "commands.personal.memories.add_option_description"), 100),
    };

    const memoryOptions: SelectMenuComponentOptionData[] = rangeSelection.visibleItems.map((memory) => {
      const label = safeSelectOptionText(memory.content.replace(/\s+/g, " ").trim(), 100);
      const tagsText = memory.tags && memory.tags.length > 0 ? memory.tags.join(", ") : undefined;
      return {
        label: label || localizer(locale, "commands.personal.memories.empty_memory_label"),
        value: String(memory.personal_memory_id),
        description: tagsText ? safeSelectOptionText(tagsText, 100) : undefined,
        default: selectedMemory?.personal_memory_id === memory.personal_memory_id,
      };
    });

    const selectRow: ActionRowData<StringSelectMenuComponentData> = {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildPersonalMemoriesRouteId({
            action: "select",
            locale,
            category: "global",
            lineageId: 0,
            rangeIndex: rangeSelection.rangeIndex,
          }),
          placeholder: localizer(locale, "commands.personal.memories.select_placeholder"),
          options: [addOption, ...memoryOptions],
          disabled: writesDisabled,
        },
      ],
    };
    components.push(selectRow);

    const memoryPaginationRow = buildPaginationRow({
      locale,
      rangeIndex: rangeSelection.rangeIndex,
      rangeCount: rangeSelection.rangeCount,
      namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
      version: PERSONAL_MEMORIES_ROUTE_VERSION,
      buildSegments: {
        page: (rangeIndex) =>
          buildPersonalMemoriesRouteSegments({
            action: "range",
            locale,
            category: "global",
            lineageId: 0,
            rangeIndex,
          }),
      },
    });
    if (memoryPaginationRow) {
      components.push(memoryPaginationRow);
    }

    if (selectedMemory) {
      components.push({
        type: ComponentType.TextDisplay,
        content: renderMemoryBlock(selectedMemory.content),
      });
    } else {
      components.push({
        type: ComponentType.TextDisplay,
        content: `> ${localizer(locale, "commands.personal.memories.no_memories")}`,
      });
    }

    components.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          customId: buildPersonalMemoriesRouteId({
            action: "edit-open",
            locale,
            category: "global",
            lineageId: 0,
            memoryId: selectedMemory?.personal_memory_id ?? 0,
          }),
          label: localizer(locale, "commands.personal.memories.edit_button"),
          disabled: writesDisabled || !selectedMemory || isPrivacyFull,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildPersonalMemoriesRouteId({
            action: "remove-prompt",
            locale,
            category: "global",
            lineageId: 0,
            memoryId: selectedMemory?.personal_memory_id ?? 0,
          }),
          label: localizer(locale, "commands.personal.memories.remove_button"),
          disabled: writesDisabled || !selectedMemory,
        },
      ],
    });

    components.push(
      { type: ComponentType.Separator, divider: true, spacing: 1 },
      {
        type: ComponentType.TextDisplay,
        content: `**${localizer(locale, "commands.personal.memories.stm_title")}**
> ${localizer(locale, "commands.personal.memories.stm_active_count", { count: input.stmCount })}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildPersonalMemoriesRouteId({ action: "stm-clear", locale, category: "global", lineageId: 0 }),
            label: localizer(locale, "commands.personal.memories.stm_clear_button"),
            disabled: writesDisabled,
          },
        ],
      },
      {
        type: ComponentType.TextDisplay,
        content: withLinePrefix("-# ", localizer(locale, "commands.personal.memories.stm_crossserver_hint")),
      },
    );
  } else {
    // Persona category
    const personaHeading: TextDisplayComponentData = {
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.personal.memories.persona_title")}
${localizer(locale, "commands.personal.memories.persona_description")}`,
    };
    const personaHeadingSection = buildOptionalThumbnailSection(personaHeading, selectedPersonaAvatarUrl);

    if (personas.length === 0) {
      components.push(personaHeadingSection);
      if (isPrivacyFull) {
        components.push({
          type: ComponentType.TextDisplay,
          content: withLinePrefix("> ", `⚠️ ${localizer(locale, "commands.personal.memories.privacy_full_warning")}`),
        });
      }
      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.personal.memories.no_personas"),
      });
    } else {
      // Personal memories are keyed by lineage, not by persona, and two personas in one server can
      // share a lineage: a preset-derived persona keeps its ancestor's. One option per persona then
      // repeats an option value, which Discord rejects with COMPONENT_OPTION_VALUE_DUPLICATED.
      const personasByLineage = new Map<number, TomoriState[]>();
      for (const p of personas) {
        const lineage = p.persona_lineage_id;
        if (lineage === undefined || lineage === null) continue;
        const bucket = personasByLineage.get(lineage);
        if (bucket) bucket.push(p);
        else personasByLineage.set(lineage, [p]);
      }

      const lineageEntries = [...personasByLineage.entries()];
      const selectedLineagePosition = lineageEntries.findIndex(([lineage]) => lineage === selectedLineageId);
      const requestedPersonaRangeIndex = page.kind === "main" ? page.personaRangeIndex : undefined;
      const personaRangeIndex =
        requestedPersonaRangeIndex ??
        (selectedLineagePosition >= 0 ? Math.floor(selectedLineagePosition / PERSONA_SELECT_MAX_OPTIONS) : 0);
      const personaRangeSelection = resolveRangeSelection(
        lineageEntries,
        personaRangeIndex,
        PERSONA_SELECT_MAX_OPTIONS,
      );
      const visibleLineages = personaRangeSelection.visibleItems;

      const personaOptions: SelectMenuComponentOptionData[] = visibleLineages.map(([lineage, sharing]) => {
        const representative = personaRepresentativeForLineage(sharing, lineage);
        return {
          label: safeSelectOptionText(
            representative?.persona_nickname || localizer(locale, "commands.personal.memories.persona_default_name"),
            100,
          ),
          value: String(lineage),
          description: safeSelectOptionText(
            describeLineageMemories(locale, memoryCountsByLineage?.get(lineage) ?? 0, sharing.length),
            100,
          ),
          default: lineage === selectedLineageId,
        };
      });

      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildPersonalMemoriesRouteId({
              action: "persona-select",
              locale,
              category: "persona",
              lineageId: selectedLineageId,
            }),
            placeholder: localizer(locale, "commands.personal.memories.persona_select_placeholder"),
            options: personaOptions,
            disabled: writesDisabled,
          },
        ],
      });

      const personaPaginationRow = buildPaginationRow({
        locale,
        rangeIndex: personaRangeSelection.rangeIndex,
        rangeCount: personaRangeSelection.rangeCount,
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: PERSONAL_MEMORIES_ROUTE_VERSION,
        buildSegments: {
          page: (rangeIndex) =>
            buildPersonalMemoriesRouteSegments({
              action: "persona-page",
              locale,
              category: "persona",
              lineageId: selectedLineageId,
              rangeIndex,
            }),
        },
      });
      if (personaPaginationRow) {
        components.push(personaPaginationRow);
      }

      components.push(personaHeadingSection);

      if (isPrivacyFull) {
        components.push({
          type: ComponentType.TextDisplay,
          content: withLinePrefix("> ", `⚠️ ${localizer(locale, "commands.personal.memories.privacy_full_warning")}`),
        });
      }

      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.personal.memories.selector_guidance"),
      });

      const addOption: SelectMenuComponentOptionData = {
        label: safeSelectOptionText(`+ ${localizer(locale, "commands.personal.memories.add_option")}`, 100),
        value: "action:add",
        description: safeSelectOptionText(localizer(locale, "commands.personal.memories.add_option_description"), 100),
      };

      const memoryOptions: SelectMenuComponentOptionData[] = rangeSelection.visibleItems.map((memory) => {
        const label = safeSelectOptionText(memory.content.replace(/\s+/g, " ").trim(), 100);
        const tagsText = memory.tags && memory.tags.length > 0 ? memory.tags.join(", ") : undefined;
        return {
          label: label || localizer(locale, "commands.personal.memories.empty_memory_label"),
          value: String(memory.personal_memory_id),
          description: tagsText ? safeSelectOptionText(tagsText, 100) : undefined,
          default: selectedMemory?.personal_memory_id === memory.personal_memory_id,
        };
      });

      const selectRow: ActionRowData<StringSelectMenuComponentData> = {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildPersonalMemoriesRouteId({
              action: "select",
              locale,
              category: "persona",
              lineageId: selectedLineageId,
              rangeIndex: rangeSelection.rangeIndex,
            }),
            placeholder: localizer(locale, "commands.personal.memories.select_placeholder"),
            options: [addOption, ...memoryOptions],
            disabled: writesDisabled,
          },
        ],
      };
      components.push(selectRow);

      const memoryPaginationRow = buildPaginationRow({
        locale,
        rangeIndex: rangeSelection.rangeIndex,
        rangeCount: rangeSelection.rangeCount,
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: PERSONAL_MEMORIES_ROUTE_VERSION,
        buildSegments: {
          page: (rangeIndex) =>
            buildPersonalMemoriesRouteSegments({
              action: "range",
              locale,
              category: "persona",
              lineageId: selectedLineageId,
              rangeIndex,
            }),
        },
      });
      if (memoryPaginationRow) {
        components.push(memoryPaginationRow);
      }

      if (selectedMemory) {
        const channelTags = (selectedMemory.tags ?? []).filter((t) => t.startsWith("#"));
        const channelAccess =
          channelTags.length > 0
            ? channelTags.join(", ")
            : localizer(locale, "commands.personal.memories.channel_access_all");

        components.push(
          {
            type: ComponentType.TextDisplay,
            content: renderMemoryBlock(selectedMemory.content),
          },
          {
            type: ComponentType.TextDisplay,
            content: `> ${localizer(locale, "commands.personal.memories.channel_access", { channels: channelAccess })}`,
          },
        );
      } else {
        components.push({
          type: ComponentType.TextDisplay,
          content: `> ${localizer(locale, "commands.personal.memories.no_memories")}`,
        });
      }

      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildPersonalMemoriesRouteId({
              action: "edit-open",
              locale,
              category: "persona",
              lineageId: selectedLineageId,
              memoryId: selectedMemory?.personal_memory_id ?? 0,
            }),
            label: localizer(locale, "commands.personal.memories.edit_button"),
            disabled: writesDisabled || !selectedMemory || isPrivacyFull,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildPersonalMemoriesRouteId({
              action: "remove-prompt",
              locale,
              category: "persona",
              lineageId: selectedLineageId,
              memoryId: selectedMemory?.personal_memory_id ?? 0,
            }),
            label: localizer(locale, "commands.personal.memories.remove_button"),
            disabled: writesDisabled || !selectedMemory,
          },
        ],
      });
    }
  }

  if (readStatus === "stale") {
    components.push(
      buildRetryRow(locale, category, selectedLineageId),
      { type: ComponentType.Separator, divider: true, spacing: 1 },
      {
        type: ComponentType.TextDisplay,
        content: `-# ${localizer(locale, "commands.personal.memories.stale_warning")}`,
      },
    );
  }

  return buildPayload(components, receipt);
}
