import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  TextInputStyle,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type StringSelectMenuComponentData,
  type SelectMenuComponentOptionData,
  type TopLevelComponentData,
} from "discord.js";
import type { StPresetNodeRow, StPresetRow } from "@/types/db/schema";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import { resolveRangeSelection } from "@/utils/discord/interactions/panelController";
import { escapeDiscordMarkdown } from "@/utils/text/discordMarkdown";
import {
  buildStPresetsRouteId,
  buildStPresetsRouteSegments,
  MAX_NODES_PER_MODAL_PAGE,
  NODE_RANGE_OPTIONS_PER_PAGE,
  ST_PRESETS_ROUTE_NAMESPACE,
  ST_PRESETS_ROUTE_VERSION,
} from "@/utils/discord/stPresetsPanelCatalog";
import {
  buildPanelContainer,
  buildPanelReceiptContainer,
  buildPaginationRow,
  withLinePrefix,
} from "@/utils/discord/ui/panel";
import { safeModalLocalizer, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { localizer } from "@/utils/text/localizer";

const MAX_PRESETS_PER_SELECTOR_PAGE = 23;
const MAX_NODE_OPTIONS_PER_GROUP = 10;

export type StPresetsPanelPage =
  | {
      kind: "preset";
      presetId?: number;
      nodeRangeIndex?: number;
      nodeRangeCount?: number;
      nodeTotalCount?: number;
    }
  | { kind: "none" }
  | { kind: "delete"; presetId: number };

export interface StPresetsPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export interface StPresetsPanelRenderInput {
  locale: string;
  scope: "guild" | "dm";
  presets: StPresetRow[];
  activePresetId: number | null;
  activeNodeCounts?: { total: number; enabled: number } | null;
  readStatus: PanelReadStatus;
  page: StPresetsPanelPage;
  rangeIndex?: number;
  receipt?: PanelReceipt;
}

export type StPresetsAddModalField = "file" | "name" | "description";

export function buildStPresetsAddModalFieldId(field: StPresetsAddModalField, nonce: string): string {
  return `${field}_${nonce}`;
}

export function buildStPresetsNodesModalFieldId(nonce: string, groupIndex: number): string {
  return `nodes_${groupIndex}_${nonce}`;
}

function buildRetryRow(locale: string): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildStPresetsRouteId({ action: "retry", locale }),
        label: localizer(locale, "commands.st-presets.retry"),
      },
    ],
  };
}

function buildNodeDescription(content: string): string | undefined {
  const cleaned = content
    .replace(/\{\{\/\/[^}]*\}\}/g, "")
    .replace(/\{\{trim\}\}/g, "")
    .replace(/\{\{(?:setvar|addvar)::[^:}]+::([^}]*)\}\}/g, "$1")
    .replace(/\{\{getvar::([^}]*)\}\}/g, "[$1]")
    .replace(/\{\{(\w+)\}\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length === 0) return undefined;
  if (cleaned.length > 100) return `${cleaned.slice(0, 97)}...`;
  return cleaned;
}

function buildCommentNodeDescription(content: string): string | undefined {
  const commentText = [...content.matchAll(/\{\{\/\/([^}]*)\}\}/g)]
    .map((m) => m[1].trim())
    .filter((t) => t.length > 0)
    .join(" ");

  if (commentText.length === 0) return undefined;
  if (commentText.length > 100) return `${commentText.slice(0, 97)}...`;
  return commentText;
}

function buildPayload(components: ComponentInContainerData[], receipt?: PanelReceipt): StPresetsPanelPayload {
  return {
    components: [...(receipt ? [buildPanelReceiptContainer(receipt)] : []), buildPanelContainer(components)],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function buildStPresetsPanelPayload(input: StPresetsPanelRenderInput): StPresetsPanelPayload {
  const { locale, presets, activePresetId, readStatus, page } = input;
  const writesDisabled = readStatus !== "fresh";

  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `## ${localizer(locale, "commands.st-presets.title")}\n${localizer(
        locale,
        "commands.st-presets.selector_guidance",
      )}`,
    },
  ];

  if (readStatus === "unavailable") {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.st-presets.unavailable"),
      },
      buildRetryRow(locale),
    );
    return buildPayload(components, input.receipt);
  }

  // Preset Selector building
  // A repaint that names a preset has to land on the selector page holding it. Defaulting to the
  // first page instead drops the reader back to page 1 after every action taken further in, and
  // leaves the selection off-screen so no option carries the default marker.
  const anchorPresetId =
    page.kind === "delete" ? page.presetId : page.kind === "preset" ? (page.presetId ?? activePresetId) : null;
  const anchorIndex = anchorPresetId == null ? -1 : presets.findIndex((p) => p.preset_id === anchorPresetId);
  const anchorRangeIndex = anchorIndex < 0 ? 0 : Math.floor(anchorIndex / MAX_PRESETS_PER_SELECTOR_PAGE);
  const rangeSelection = resolveRangeSelection(
    presets,
    input.rangeIndex ?? anchorRangeIndex,
    MAX_PRESETS_PER_SELECTOR_PAGE,
  );
  const visiblePresets = rangeSelection.visibleItems;

  const selectedValue: string =
    page.kind === "none"
      ? "none"
      : page.kind === "preset"
        ? String(page.presetId ?? activePresetId ?? "none")
        : activePresetId !== null
          ? String(activePresetId)
          : "none";

  const selectOptions: SelectMenuComponentOptionData[] = [
    {
      label: localizer(locale, "commands.st-presets.select_add"),
      value: "add",
      description: localizer(locale, "commands.st-presets.select_add_description"),
    },
    {
      label: localizer(locale, "commands.st-presets.select_none"),
      value: "none",
      description: localizer(locale, "commands.st-presets.select_none_description"),
      default: selectedValue === "none",
    },
    ...visiblePresets.map((preset) => ({
      label: safeSelectOptionText(preset.preset_name, 100),
      value: String(preset.preset_id),
      description: preset.description ? safeSelectOptionText(preset.description, 100) : undefined,
      default: selectedValue === String(preset.preset_id),
    })),
  ];

  const selectRow: ActionRowData<StringSelectMenuComponentData> = {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildStPresetsRouteId({ action: "select", locale }),
        placeholder: localizer(locale, "commands.st-presets.select_placeholder"),
        options: selectOptions,
        disabled: writesDisabled,
      },
    ],
  };

  components.push(selectRow);

  if (rangeSelection.rangeCount > 1) {
    const paginationRow = buildPaginationRow({
      locale,
      rangeIndex: rangeSelection.rangeIndex,
      rangeCount: rangeSelection.rangeCount,
      namespace: ST_PRESETS_ROUTE_NAMESPACE,
      version: ST_PRESETS_ROUTE_VERSION,
      disabled: writesDisabled,
      buildSegments: {
        page: (rangeIndex) => buildStPresetsRouteSegments({ action: "range", locale, rangeIndex }),
      },
    });
    if (paginationRow) {
      components.push(paginationRow);
    }
  }

  components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });

  // Page body rendering
  if (page.kind === "none") {
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.st-presets.none_heading")}`,
      },
      {
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.st-presets.none_disabled_explanation"),
      },
    );
  } else if (page.kind === "preset") {
    const targetPreset =
      (page.presetId ? presets.find((p) => p.preset_id === page.presetId) : null) ??
      (activePresetId ? presets.find((p) => p.preset_id === activePresetId) : null) ??
      presets[0];

    if (targetPreset && targetPreset.preset_id !== undefined) {
      const targetPresetId = targetPreset.preset_id;
      const isActive = targetPreset.preset_id === activePresetId;
      const activeLine =
        isActive && input.activeNodeCounts
          ? `**🟢 ${localizer(locale, "commands.st-presets.currently_active_with_nodes", {
              enabled: input.activeNodeCounts.enabled,
              total: input.activeNodeCounts.total,
            })}**`
          : `🟢 ${localizer(locale, "commands.st-presets.currently_active")}`;

      const bodyLines = [activeLine];
      if (targetPreset.description && targetPreset.description.trim().length > 0) {
        bodyLines.push(`> ${escapeDiscordMarkdown(targetPreset.description.trim())}`);
      }

      components.push(
        {
          type: ComponentType.TextDisplay,
          content: bodyLines.join("\n"),
        },
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              customId: buildStPresetsRouteId({ action: "nodes-open", locale, presetId: targetPresetId }),
              label: localizer(locale, "commands.st-presets.toggle_nodes"),
              disabled: writesDisabled,
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              customId: buildStPresetsRouteId({ action: "delete-prompt", locale, presetId: targetPresetId }),
              label: localizer(locale, "commands.st-presets.delete_preset"),
              disabled: writesDisabled,
            },
          ],
        },
      );
      const nodeRangeCount = page.nodeRangeCount ?? 0;
      if (nodeRangeCount > 1) {
        const nodeTotalCount = page.nodeTotalCount ?? nodeRangeCount * MAX_NODES_PER_MODAL_PAGE;
        // Every range is its own option because the modal is the only place nodes can be toggled:
        // a prev/next row disables the position it sits on, so the range it is parked on could
        // never be opened.
        // nodeRangeIndex names a range that must stay visible, not the first option: snapping to its
        // block keeps a full selector and lets a legacy node-page ID land on a complete list.
        const visibleRange = Math.min(Math.max(0, page.nodeRangeIndex ?? 0), Math.max(0, nodeRangeCount - 1));
        const blockStart = Math.floor(visibleRange / NODE_RANGE_OPTIONS_PER_PAGE) * NODE_RANGE_OPTIONS_PER_PAGE;
        const visibleRanges = Math.min(NODE_RANGE_OPTIONS_PER_PAGE, nodeRangeCount - blockStart);
        components.push({
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: buildStPresetsRouteId({
                action: "nodes-range-select",
                locale,
                presetId: targetPresetId,
              }),
              placeholder: safeSelectOptionText(localizer(locale, "commands.st-presets.nodes_range_placeholder"), 150),
              options: Array.from({ length: visibleRanges }, (_, offset) => {
                const rangeIndex = blockStart + offset;
                const first = rangeIndex * MAX_NODES_PER_MODAL_PAGE;
                return {
                  value: String(rangeIndex),
                  label: safeSelectOptionText(
                    localizer(locale, "commands.st-presets.nodes_range_option", {
                      start: first + 1,
                      end: Math.min(first + MAX_NODES_PER_MODAL_PAGE, nodeTotalCount),
                    }),
                    100,
                  ),
                } satisfies SelectMenuComponentOptionData;
              }),
              disabled: writesDisabled,
            },
          ],
        } satisfies ActionRowData<StringSelectMenuComponentData>);

        const nodeBlockRow = buildPaginationRow({
          locale,
          rangeIndex: Math.floor(blockStart / NODE_RANGE_OPTIONS_PER_PAGE),
          rangeCount: Math.ceil(nodeRangeCount / NODE_RANGE_OPTIONS_PER_PAGE),
          namespace: ST_PRESETS_ROUTE_NAMESPACE,
          version: ST_PRESETS_ROUTE_VERSION,
          disabled: writesDisabled,
          buildSegments: {
            page: (blockIndex) =>
              buildStPresetsRouteSegments({
                action: "nodes-page",
                locale,
                presetId: targetPresetId,
                chooserPage: blockIndex * NODE_RANGE_OPTIONS_PER_PAGE,
              }),
          },
        });
        if (nodeBlockRow) {
          components.push(nodeBlockRow);
        }
      }
    } else {
      components.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, "commands.st-presets.none_disabled_explanation"),
      });
    }
  } else if (page.kind === "delete") {
    const targetPreset = presets.find((p) => p.preset_id === page.presetId);
    components.push(
      {
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, "commands.st-presets.delete_title")}\n${localizer(
          locale,
          "commands.st-presets.delete_description",
          { name: escapeDiscordMarkdown(targetPreset?.preset_name ?? "preset") },
        )}`,
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            customId: buildStPresetsRouteId({ action: "delete-confirm", locale, presetId: page.presetId }),
            label: localizer(locale, "commands.st-presets.delete_confirm"),
            disabled: writesDisabled,
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            customId: buildStPresetsRouteId({ action: "delete-cancel", locale, presetId: page.presetId }),
            label: localizer(locale, "commands.st-presets.cancel"),
          },
        ],
      },
    );
  }

  if (readStatus === "stale") {
    components.push({ type: ComponentType.Separator, divider: true, spacing: 1 }, buildRetryRow(locale), {
      type: ComponentType.TextDisplay,
      content: withLinePrefix("-# ", localizer(locale, "commands.st-presets.stale_warning")),
    });
  }

  return buildPayload(components, input.receipt);
}

export function buildAddStPresetModal(
  locale: string,
  nonce: string,
): {
  custom_id: string;
  title: string;
  components: RawDiscordComponent[];
} {
  return {
    custom_id: buildStPresetsRouteId({ action: "add-submit", locale, nonce }),
    title: safeSelectOptionText(localizer(locale, "commands.st-presets.add_modal_title"), 45),
    components: [
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.st-presets.file_label"), 45),
        description: safeModalLocalizer(locale, "commands.st-presets.file_description"),
        component: {
          type: 19,
          custom_id: buildStPresetsAddModalFieldId("file", nonce),
          min_values: 1,
          max_values: 1,
          required: true,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.st-presets.name_label"), 45),
        component: {
          type: 4,
          custom_id: buildStPresetsAddModalFieldId("name", nonce),
          style: TextInputStyle.Short,
          placeholder: safeSelectOptionText(localizer(locale, "commands.st-presets.name_placeholder"), 100),
          max_length: 64,
          required: false,
        },
      },
      {
        type: 18,
        label: safeSelectOptionText(localizer(locale, "commands.st-presets.description_label"), 45),
        component: {
          type: 4,
          custom_id: buildStPresetsAddModalFieldId("description", nonce),
          style: TextInputStyle.Paragraph,
          placeholder: safeSelectOptionText(localizer(locale, "commands.st-presets.description_placeholder"), 100),
          max_length: 500,
          required: false,
        },
      },
    ],
  };
}

export function buildNodesToggleModal(
  locale: string,
  preset: StPresetRow,
  pageNodes: StPresetNodeRow[],
  pageOffset: number,
  nonce: string,
): {
  custom_id: string;
  title: string;
  components: RawDiscordComponent[];
} {
  const modalComponents: RawDiscordComponent[] = [];

  for (let i = 0; i < pageNodes.length; i += MAX_NODE_OPTIONS_PER_GROUP) {
    const chunk = pageNodes.slice(i, i + MAX_NODE_OPTIONS_PER_GROUP);
    const groupIndex = Math.floor(i / MAX_NODE_OPTIONS_PER_GROUP);

    const options = chunk.map((node, chunkIdx) => {
      const rawName = node.name.trim();
      const nodeNumber = pageOffset + i + chunkIdx + 1;
      const label =
        rawName.length === 0 ? `Node ${nodeNumber}` : rawName.length > 100 ? `${rawName.slice(0, 97)}...` : rawName;
      return {
        label: safeSelectOptionText(label, 100),
        value: node.identifier,
        description: node.is_comment ? buildCommentNodeDescription(node.content) : buildNodeDescription(node.content),
        default: node.is_enabled,
      };
    });

    const rangeStart = pageOffset + i + 1;
    const rangeEnd = pageOffset + i + chunk.length;
    const dynamicLabel = `Nodes ${rangeStart}-${rangeEnd}`;

    modalComponents.push({
      type: 18,
      label: safeSelectOptionText(dynamicLabel, 45),
      description: safeModalLocalizer(locale, "commands.st-presets.nodes_group_description"),
      component: {
        type: 22,
        custom_id: buildStPresetsNodesModalFieldId(nonce, groupIndex),
        min_values: 0,
        max_values: chunk.length,
        required: false,
        options,
      },
    });
  }

  return {
    custom_id: buildStPresetsRouteId({
      action: "nodes-submit",
      locale,
      presetId: preset.preset_id as number,
      nonce,
    }),
    title: safeSelectOptionText(preset.preset_name, 45),
    components: modalComponents,
  };
}
