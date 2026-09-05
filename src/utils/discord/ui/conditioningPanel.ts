import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type TopLevelComponentData,
} from "discord.js";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import type { PanelReceipt } from "@/types/discord/panel";
import {
  CONDITIONING_ROUTE_NAMESPACE,
  CONDITIONING_ROUTE_VERSION,
  buildConditioningRouteId,
  buildConditioningRouteSegments,
  computeConditioningAggregateFingerprint,
  type ConditioningAggregateEntry,
} from "@/utils/discord/conditioningPanelCatalog";
import {
  MODERATION_PANEL_RANGE_SIZE,
  resolveRangeSelection,
  validateAndFallbackPanelPayload,
} from "@/utils/discord/interactions/panelController";
import {
  DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX,
  measureComponentTextLength,
} from "@/utils/discord/ui/componentsV2Limits";
import { buildConfigModalFieldId } from "@/utils/discord/ui/configModals";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { buildPaginationRow, buildPanelContainer, buildPanelReceiptContainer } from "@/utils/discord/ui/panel";
import { escapeDiscordMarkdown } from "@/utils/text/discordMarkdown";
import { getDiscordTextLength } from "@/utils/text/discordTextLimits";
import { localizer } from "@/utils/text/localizer";
import { buildTextPreview, textPreviewFooterKey, textPreviewFooterVars } from "@/utils/text/textPreview";

export const CONDITIONING_PANEL_PAGE_SIZE = MODERATION_PANEL_RANGE_SIZE;
export const CONDITIONING_ROW_TEXT_PREVIEW_BUDGET = 250;

export interface ConditioningPanelPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export interface ConditioningPanelRenderInput {
  locale: string;
  entries: readonly ConditioningAggregateEntry[];
  rangeIndex?: number;
  writesDisabled?: boolean;
  receipt?: PanelReceipt;
}

function renderReasonBlock(locale: string, reasonText: string, budget: number): string {
  const fenceOverhead = getDiscordTextLength("```markdown\n\n```");
  const rawBudget = Math.max(0, budget - fenceOverhead);
  const initialPreview = buildTextPreview(reasonText, rawBudget);
  if (!initialPreview.truncated) {
    return ["```markdown", initialPreview.text, "```"].join("\n");
  }
  const footerKey = textPreviewFooterKey(initialPreview);
  const footerVars = textPreviewFooterVars(initialPreview);
  const initialFooter = footerKey ? `\n-# ${localizer(locale, footerKey, footerVars)}` : "";
  const footerReserve = getDiscordTextLength(initialFooter);
  const refinedBudget = Math.max(0, budget - fenceOverhead - footerReserve);
  const preview = buildTextPreview(reasonText, refinedBudget);
  const finalFooterKey = textPreviewFooterKey(preview);
  const finalFooterVars = textPreviewFooterVars(preview);
  const finalFooter = finalFooterKey ? `\n-# ${localizer(locale, finalFooterKey, finalFooterVars)}` : "";
  return ["```markdown", preview.text, "```"].join("\n") + finalFooter;
}

export function buildConditioningPanelPayload(input: ConditioningPanelRenderInput): ConditioningPanelPayload {
  const requestedRange = input.rangeIndex ?? 0;
  const writesDisabled = input.writesDisabled ?? false;
  const selection = resolveRangeSelection(input.entries, requestedRange, CONDITIONING_PANEL_PAGE_SIZE);

  const components: ComponentInContainerData[] = [
    {
      type: ComponentType.TextDisplay,
      content: `## ${localizer(input.locale, "commands.conditioning.panel.title")}\n> ${localizer(input.locale, "commands.conditioning.panel.description")}`,
    },
  ];

  const hiddenCount = selection.totalCount - selection.visibleItems.length;
  if (hiddenCount > 0) {
    components.push({
      type: ComponentType.TextDisplay,
      content: `> ${localizer(input.locale, "commands.conditioning.panel.hidden_count", {
        shown: String(selection.visibleItems.length),
        total: String(selection.totalCount),
        hidden: String(hiddenCount),
      })}`,
    });
  }

  if (selection.totalCount === 0) {
    components.push({
      type: ComponentType.TextDisplay,
      content: `### ${localizer(input.locale, "commands.conditioning.panel.empty_title")}\n> ${localizer(input.locale, "commands.conditioning.panel.empty_description")}`,
    });
  } else {
    for (let index = 0; index < selection.visibleItems.length; index++) {
      const entry = selection.visibleItems[index];
      const remainingCount = selection.visibleItems.length - index;
      const currentLength = measureComponentTextLength(components);
      const remainingBudget = Math.max(0, DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX - currentLength - 200);
      const budgetPerEntry = Math.min(
        CONDITIONING_ROW_TEXT_PREVIEW_BUDGET,
        Math.max(60, Math.floor(remainingBudget / remainingCount)),
      );

      const marker = localizer(input.locale, `commands.conditioning.shared.marker_${entry.conditioningType}`);
      const actionLabel = localizer(
        input.locale,
        `commands.${entry.conditioningType}.${entry.actionKey}.history_label`,
      );
      const header = localizer(input.locale, "commands.conditioning.shared.option_label", {
        type_marker: marker,
        persona_name: escapeDiscordMarkdown(entry.personaName),
        action: actionLabel,
      });
      const countText = localizer(
        input.locale,
        entry.totalCount === 1
          ? "commands.conditioning.panel.entry_count_single"
          : "commands.conditioning.panel.entry_count",
        { count: entry.totalCount.toLocaleString(input.locale) },
      );
      const reasonBlock = renderReasonBlock(input.locale, entry.reasonText, budgetPerEntry);

      components.push({
        type: ComponentType.TextDisplay,
        content: `### ${header}\n> ${countText}\n${reasonBlock}`,
      });
    }
  }

  const paginationRow = buildPaginationRow({
    locale: input.locale,
    rangeIndex: selection.rangeIndex,
    rangeCount: selection.rangeCount,
    namespace: CONDITIONING_ROUTE_NAMESPACE,
    version: CONDITIONING_ROUTE_VERSION,
    disabled: writesDisabled,
    buildSegments: {
      page: (targetRangeIndex) =>
        buildConditioningRouteSegments({
          action: "range",
          locale: input.locale,
          range: targetRangeIndex,
        }),
    },
  });
  if (paginationRow) {
    components.push(paginationRow);
  }

  const fp = computeConditioningAggregateFingerprint(selection.visibleItems, selection.rangeIndex);
  const removalRow: ActionRowData<ButtonComponentData> = {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Danger,
        customId: buildConditioningRouteId({
          action: "remove-open",
          locale: input.locale,
          range: selection.rangeIndex,
          fp,
        }),
        label: localizer(input.locale, "commands.conditioning.panel.remove_button"),
        disabled: writesDisabled || selection.totalCount === 0,
      },
    ],
  };
  components.push(removalRow);

  const topLevelComponents: TopLevelComponentData[] = [];
  if (input.receipt) {
    topLevelComponents.push(buildPanelReceiptContainer(input.receipt));
  }
  topLevelComponents.push(buildPanelContainer(components));

  return validateAndFallbackPanelPayload(
    {
      components: topLevelComponents,
      flags: MessageFlags.IsComponentsV2,
    },
    input.locale,
  );
}

export function buildConditioningCheckboxGroupId(groupIndex: number, nonce: string): string {
  return buildConfigModalFieldId(`conditioning_${groupIndex}`, nonce);
}

export function buildConditioningRemoveModal(
  locale: string,
  range: number,
  fp: string,
  nonce: string,
  entries: readonly ConditioningAggregateEntry[],
): {
  custom_id: string;
  title: string;
  components: RawDiscordComponent[];
} {
  const components: RawDiscordComponent[] = [];
  const chunkSize = 10;

  for (let offset = 0; offset < entries.length; offset += chunkSize) {
    const groupIndex = offset / chunkSize;
    const chunk = entries.slice(offset, offset + chunkSize);
    components.push({
      type: 18,
      label: safeSelectOptionText(
        localizer(
          locale,
          groupIndex === 0
            ? "commands.conditioning.panel.remove_checkbox_label"
            : "commands.conditioning.panel.remove_checkbox_label_continued",
        ),
        45,
      ),
      description:
        groupIndex === 0
          ? safeSelectOptionText(localizer(locale, "commands.conditioning.panel.remove_checkbox_description"), 100)
          : undefined,
      component: {
        type: 22,
        custom_id: buildConditioningCheckboxGroupId(groupIndex, nonce),
        min_values: 0,
        max_values: chunk.length,
        required: false,
        options: chunk.map((entry, indexInChunk) => {
          const marker = localizer(locale, `commands.conditioning.shared.marker_${entry.conditioningType}`);
          const actionLabel = localizer(locale, `commands.${entry.conditioningType}.${entry.actionKey}.history_label`);
          const label = localizer(locale, "commands.conditioning.shared.option_label", {
            type_marker: marker,
            persona_name: entry.personaName,
            action: actionLabel,
          });
          const descriptionKey =
            entry.totalCount > 1
              ? "commands.conditioning.shared.option_reason_description"
              : "commands.conditioning.shared.option_reason_description_single";
          let description = localizer(locale, descriptionKey, {
            count: String(entry.totalCount),
            reason: entry.reasonText,
          });
          if (entry.actionText) description = `${description} • ${entry.actionText}`;

          return {
            label: safeSelectOptionText(label, 100),
            value: String(offset + indexInChunk),
            description: safeSelectOptionText(description, 100),
            default: true,
          };
        }),
      },
    });
  }

  return {
    custom_id: buildConditioningRouteId({
      action: "remove-submit",
      locale,
      range,
      fp,
      nonce,
    }),
    title: safeSelectOptionText(localizer(locale, "commands.conditioning.panel.remove_modal_title"), 45),
    components,
  };
}
