import { ButtonStyle, ComponentType, type ActionRowData, type ButtonComponentData, type Guild } from "discord.js";
import type { RawDiscordComponent } from "@/types/discord/rawApiTypes";
import {
  MODEL_OVERRIDE_MODAL_CAPACITY,
  buildModelOverrideRouteId,
  formatModelOverrideModelSummary,
  type ModelOverrideEntry,
} from "@/utils/discord/modelOverrideCatalog";
import { buildConfigModalFieldId } from "@/utils/discord/ui/configModals";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { DISCORD_ACTION_ROW_BUTTONS_MAX } from "@/utils/discord/ui/componentsV2Limits";
import { localizer } from "@/utils/text/localizer";

const MODEL_OVERRIDE_MAX_OPTIONS_PER_GROUP = 10;
export const MODEL_OVERRIDE_PAGE_SELECT_MAX_BUTTONS = DISCORD_ACTION_ROW_BUTTONS_MAX * 5;
export const MODEL_OVERRIDE_PAGE_SELECT_MAX_ENTRIES =
  MODEL_OVERRIDE_PAGE_SELECT_MAX_BUTTONS * MODEL_OVERRIDE_MODAL_CAPACITY;

export function buildModelOverrideCheckboxGroupId(groupIndex: number, nonce: string): string {
  return buildConfigModalFieldId(`model_override_${groupIndex}`, nonce);
}

export function buildModelOverrideRemoveModal(
  locale: string,
  page: number,
  fp: string,
  nonce: string,
  entries: readonly ModelOverrideEntry[],
  guild?: Guild | null,
): {
  custom_id: string;
  title: string;
  components: RawDiscordComponent[];
} {
  const components: RawDiscordComponent[] = [];
  const chunkSize = MODEL_OVERRIDE_MAX_OPTIONS_PER_GROUP;
  let channelGroupCount = 0;
  let personaGroupCount = 0;
  let mixedGroupCount = 0;

  for (let offset = 0; offset < entries.length; offset += chunkSize) {
    const groupIndex = Math.floor(offset / chunkSize);
    const chunk = entries.slice(offset, offset + chunkSize);

    const hasChannel = chunk.some((entry) => entry.scope === "channel");
    const hasPersona = chunk.some((entry) => entry.scope === "persona");

    let labelKey: string;
    let descriptionKey: string | undefined;

    if (hasChannel && !hasPersona) {
      labelKey =
        channelGroupCount === 0
          ? "commands.model.override.remove.channel_checkbox_label"
          : "commands.model.override.remove.channel_checkbox_label_continued";
      descriptionKey =
        channelGroupCount === 0 ? "commands.model.override.remove.channel_checkbox_description" : undefined;
      channelGroupCount++;
    } else if (!hasChannel && hasPersona) {
      labelKey =
        personaGroupCount === 0
          ? "commands.model.override.remove.persona_checkbox_label"
          : "commands.model.override.remove.persona_checkbox_label_continued";
      descriptionKey =
        personaGroupCount === 0 ? "commands.model.override.remove.persona_checkbox_description" : undefined;
      personaGroupCount++;
    } else {
      labelKey =
        mixedGroupCount === 0
          ? "commands.model.override.remove.mixed_checkbox_label"
          : "commands.model.override.remove.mixed_checkbox_label_continued";
      descriptionKey = mixedGroupCount === 0 ? "commands.model.override.remove.mixed_checkbox_description" : undefined;
      mixedGroupCount++;
    }

    components.push({
      type: 18,
      label: safeSelectOptionText(localizer(locale, labelKey), 45),
      description: descriptionKey ? safeSelectOptionText(localizer(locale, descriptionKey), 100) : undefined,
      component: {
        type: 22,
        custom_id: buildModelOverrideCheckboxGroupId(groupIndex, nonce),
        min_values: 0,
        max_values: chunk.length,
        required: false,
        options: chunk.map((entry, indexInChunk) => {
          const positionalIndex = String(offset + indexInChunk);
          // Each row names its target and prints only the effective model. Scope stays in the
          // group label above the rows, so identical models never make same-scope targets
          // indistinguishable and the option description never repeats the editor destination.
          if (entry.scope === "channel") {
            const channel = guild?.channels.cache.get(entry.channelDiscId);
            const unknownTarget = localizer(locale, "commands.model.override.remove.channel_unknown");
            const label = channel?.isTextBased()
              ? `#${channel.name}`
              : (channel?.name ?? `${unknownTarget} (${entry.channelDiscId.substring(0, 10)}...)`);
            return {
              label: safeSelectOptionText(label, 100),
              value: positionalIndex,
              description: formatModelOverrideModelSummary(entry.llm),
              default: true,
            };
          }

          return {
            label: safeSelectOptionText(entry.persona_nickname, 100),
            value: positionalIndex,
            description: formatModelOverrideModelSummary(entry.persona_llm),
            default: true,
          };
        }),
      },
    });
  }

  return {
    custom_id: buildModelOverrideRouteId({
      action: "remove-submit",
      locale,
      page,
      fp,
      nonce,
    }),
    title: safeSelectOptionText(localizer(locale, "commands.model.override.remove.modal_title"), 45),
    components,
  };
}

export function buildModelOverridePageSelectRows(
  locale: string,
  totalEntries: number,
): ActionRowData<ButtonComponentData>[] {
  const totalPages = Math.min(
    Math.ceil(totalEntries / MODEL_OVERRIDE_MODAL_CAPACITY),
    MODEL_OVERRIDE_PAGE_SELECT_MAX_BUTTONS,
  );
  const buttons: ButtonComponentData[] = [];

  for (let page = 0; page < totalPages; page++) {
    const start = page * MODEL_OVERRIDE_MODAL_CAPACITY + 1;
    const end = Math.min((page + 1) * MODEL_OVERRIDE_MODAL_CAPACITY, totalEntries);
    buttons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      customId: buildModelOverrideRouteId({
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
