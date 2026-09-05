import { ButtonStyle, ComponentType, type ActionRowData, type ButtonComponentData } from "discord.js";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import {
  CONDITIONING_MODAL_CAPACITY,
  buildConditioningRouteId,
  type ConditioningAggregateEntry,
} from "@/utils/discord/conditioningPanelCatalog";
import { buildConfigModalFieldId } from "@/utils/discord/ui/configModals";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { DISCORD_ACTION_ROW_BUTTONS_MAX } from "@/utils/discord/ui/componentsV2Limits";
import { localizer } from "@/utils/text/localizer";

export function buildConditioningCheckboxGroupId(groupIndex: number, nonce: string): string {
  return buildConfigModalFieldId(`conditioning_${groupIndex}`, nonce);
}

export function buildConditioningRemoveModal(
  locale: string,
  page: number,
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
      page,
      fp,
      nonce,
    }),
    title: safeSelectOptionText(localizer(locale, "commands.conditioning.panel.remove_modal_title"), 45),
    components,
  };
}

/**
 * A legacy message carries at most five action rows of five buttons, so the page selector can
 * address 25 batches. Entries are sorted newest first, so a server past this ceiling reaches its
 * most recent 1,250 and the prompt reports both counts rather than dropping the rest silently.
 */
export const CONDITIONING_PAGE_SELECT_MAX_BUTTONS = DISCORD_ACTION_ROW_BUTTONS_MAX * 5;
export const CONDITIONING_PAGE_SELECT_MAX_ENTRIES = CONDITIONING_PAGE_SELECT_MAX_BUTTONS * CONDITIONING_MODAL_CAPACITY;

export function buildConditioningPageSelectRows(
  locale: string,
  totalEntries: number,
): ActionRowData<ButtonComponentData>[] {
  const totalPages = Math.min(
    Math.ceil(totalEntries / CONDITIONING_MODAL_CAPACITY),
    CONDITIONING_PAGE_SELECT_MAX_BUTTONS,
  );
  const buttons: ButtonComponentData[] = [];

  for (let page = 0; page < totalPages; page++) {
    const start = page * CONDITIONING_MODAL_CAPACITY + 1;
    const end = Math.min((page + 1) * CONDITIONING_MODAL_CAPACITY, totalEntries);
    buttons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: buildConditioningRouteId({
        action: "page",
        locale,
        page,
      }),
      label: `${start}-${end}`,
    });
  }

  const rows: ActionRowData<ButtonComponentData>[] = [];
  for (let offset = 0; offset < buttons.length; offset += DISCORD_ACTION_ROW_BUTTONS_MAX) {
    rows.push({
      type: ComponentType.ActionRow,
      components: buttons.slice(offset, offset + DISCORD_ACTION_ROW_BUTTONS_MAX),
    });
  }

  return rows;
}
