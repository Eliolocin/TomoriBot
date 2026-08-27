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
  type TopLevelComponentData,
} from "discord.js";
import { PrivacyLevel, type PersonalMemoryRow, type TomoriState } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import { escapeDiscordMarkdown, resolveRangeSelection } from "@/utils/discord/interactions/panelController";
import {
  buildPersonalMemoriesCustomId,
  PERSONAL_MEMORIES_ROUTE_NAMESPACE,
  PERSONAL_MEMORIES_ROUTE_VERSION,
  type PersonalMemoriesCategory,
} from "@/utils/discord/personalMemoriesPanelCatalog";
import {
  buildCategoryButtonRow,
  buildPanelContainer,
  buildPanelReceiptContainer,
  buildRangeChooserComponents,
} from "@/utils/discord/ui/panel";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { localizer } from "@/utils/text/localizer";

const MAX_PERSONAL_MEMORY_PAGE_SIZE = 24;
const MAX_PERSONAL_MEMORY_TAGS = 5;
const MAX_PERSONAL_MEMORY_TAG_LENGTH = 32;

const memoryLimits = getMemoryLimits();

type PersonalMemoriesPanelPage =
  | { kind: "main"; selectedMemoryId?: number; rangeIndex?: number }
  | { kind: "range-chooser"; chooserPage?: number }
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

export function buildPersonalMemoryModalFieldId(field: "content" | "tags", nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildAddPersonalMemoryModal(
  locale: string,
  category: PersonalMemoriesCategory,
  lineageId: number,
  nonce: string,
): { custom_id: string; title: string; components: RawDiscordComponent[] } {
  return {
    custom_id: buildPersonalMemoriesCustomId("add-submit", locale, category, lineageId, nonce),
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
          required: true,
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
    custom_id: buildPersonalMemoriesCustomId("edit-submit", locale, category, lineageId, memoryId, nonce),
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
        customId: buildPersonalMemoriesCustomId("retry", locale, category, lineageId),
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
  const { locale, category, selectedLineageId, personas, memories, privacyLevel, readStatus, page, receipt } = input;
  const writesDisabled = readStatus !== "fresh";
  const isPrivacyFull = privacyLevel === PrivacyLevel.FULL;

  const categoryButtons = buildCategoryButtonRow(
    [
      {
        id: "global",
        label: localizer(locale, "commands.personal.memories.category_global"),
        customId: buildPersonalMemoriesCustomId("category", locale, "global"),
      },
      {
        id: "persona",
        label: localizer(locale, "commands.personal.memories.category_persona"),
        customId: buildPersonalMemoriesCustomId("category", locale, "persona"),
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
  memory: escapeDiscordMarkdown(targetMemory.content),
})}`,
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildPersonalMemoriesCustomId(
                "remove-confirm",
                locale,
                category,
                selectedLineageId,
                targetMemory.personal_memory_id,
              ),
              label: localizer(locale, "commands.personal.memories.remove_confirm"),
              disabled: writesDisabled,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalMemoriesCustomId(
                "remove-cancel",
                locale,
                category,
                selectedLineageId,
                targetMemory.personal_memory_id,
              ),
              label: localizer(locale, "commands.personal.memories.cancel"),
            },
          ],
        },
      );
      return buildPayload(components, receipt);
    }
  }

  if (page.kind === "range-chooser") {
    components.push(
      ...buildRangeChooserComponents({
        locale,
        totalCount: memories.length,
        pageSize: MAX_PERSONAL_MEMORY_PAGE_SIZE,
        chooserPage: page.chooserPage,
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: PERSONAL_MEMORIES_ROUTE_VERSION,
        buildSegments: {
          range: (rangeIndex) => ["range", locale, category, String(selectedLineageId), String(rangeIndex)],
          previous: (targetPage) => ["range-page", locale, category, String(selectedLineageId), String(targetPage)],
          next: (targetPage) => ["range-page", locale, category, String(selectedLineageId), String(targetPage)],
          cancel: () => ["range-cancel", locale, category, String(selectedLineageId)],
        },
      }),
    );
    return buildPayload(components, receipt);
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
${localizer(locale, "commands.personal.memories.global_description")}`,
    });

    if (isPrivacyFull) {
      components.push({
        type: ComponentType.TextDisplay,
        content: `> ⚠️ ${localizer(locale, "commands.personal.memories.privacy_full_warning")}`,
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
          customId: buildPersonalMemoriesCustomId("select", locale, "global", 0, rangeSelection.rangeIndex),
          placeholder: localizer(locale, "commands.personal.memories.select_placeholder"),
          options: [addOption, ...memoryOptions],
          disabled: writesDisabled,
        },
      ],
    };
    components.push(selectRow);

    if (rangeSelection.rangeCount > 1) {
      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildPersonalMemoriesCustomId("range-open", locale, "global", 0),
            label: localizer(locale, "general.pagination.select_page_title"),
          },
        ],
      });
    }

    if (selectedMemory) {
      components.push({
        type: ComponentType.TextDisplay,
        content: `> ${escapeDiscordMarkdown(selectedMemory.content)}`,
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
          customId: buildPersonalMemoriesCustomId(
            "edit-open",
            locale,
            "global",
            0,
            selectedMemory?.personal_memory_id ?? 0,
          ),
          label: localizer(locale, "commands.personal.memories.edit_button"),
          disabled: writesDisabled || !selectedMemory || isPrivacyFull,
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          customId: buildPersonalMemoriesCustomId(
            "remove-prompt",
            locale,
            "global",
            0,
            selectedMemory?.personal_memory_id ?? 0,
          ),
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
            customId: buildPersonalMemoriesCustomId("stm-clear", locale, "global", 0),
            label: localizer(locale, "commands.personal.memories.stm_clear_button"),
            disabled: writesDisabled,
          },
        ],
      },
      {
        type: ComponentType.TextDisplay,
        content: `-# ${localizer(locale, "commands.personal.memories.stm_crossserver_hint")}`,
      },
    );
  } else {
    // Persona category
    components.push({
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, "commands.personal.memories.persona_title")}
${localizer(locale, "commands.personal.memories.persona_description")}`,
    });

    if (isPrivacyFull) {
      components.push({
        type: ComponentType.TextDisplay,
        content: `> ⚠️ ${localizer(locale, "commands.personal.memories.privacy_full_warning")}`,
      });
    }

    if (personas.length === 0) {
      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.personal.memories.no_personas"),
      });
    } else {
      const personaOptions: SelectMenuComponentOptionData[] = personas.map((p) => ({
        label: safeSelectOptionText(
          p.persona_nickname || localizer(locale, "commands.personal.memories.persona_default_name"),
          100,
        ),
        value: String(p.persona_lineage_id),
        description: safeSelectOptionText(
          localizer(
            locale,
            p.is_alter
              ? "commands.personal.memories.persona_alter_description"
              : "commands.personal.memories.persona_main_description",
          ),
          100,
        ),
        default: p.persona_lineage_id === selectedLineageId,
      }));

      components.push({
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            customId: buildPersonalMemoriesCustomId("persona-select", locale, "persona", selectedLineageId),
            placeholder: localizer(locale, "commands.personal.memories.persona_select_placeholder"),
            options: personaOptions,
            disabled: writesDisabled,
          },
        ],
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
            customId: buildPersonalMemoriesCustomId(
              "select",
              locale,
              "persona",
              selectedLineageId,
              rangeSelection.rangeIndex,
            ),
            placeholder: localizer(locale, "commands.personal.memories.select_placeholder"),
            options: [addOption, ...memoryOptions],
            disabled: writesDisabled,
          },
        ],
      };
      components.push(selectRow);

      if (rangeSelection.rangeCount > 1) {
        components.push({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildPersonalMemoriesCustomId("range-open", locale, "persona", selectedLineageId),
              label: localizer(locale, "general.pagination.select_page_title"),
            },
          ],
        });
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
            content: `> ${escapeDiscordMarkdown(selectedMemory.content)}`,
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
            customId: buildPersonalMemoriesCustomId(
              "edit-open",
              locale,
              "persona",
              selectedLineageId,
              selectedMemory?.personal_memory_id ?? 0,
            ),
            label: localizer(locale, "commands.personal.memories.edit_button"),
            disabled: writesDisabled || !selectedMemory || isPrivacyFull,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildPersonalMemoriesCustomId(
              "remove-prompt",
              locale,
              "persona",
              selectedLineageId,
              selectedMemory?.personal_memory_id ?? 0,
            ),
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
