import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, type Guild } from "discord.js";
import type { CheckboxGroupOption, ModalCheckboxGroupField } from "@/types/discord/modal";
import { safeSelectOptionText } from "@/utils/discord/ui/modals";
import { localizer } from "@/utils/text/localizer";

const CHECKLIST_MAX_OPTIONS_PER_GROUP = 10;
const CHECKLIST_MAX_GROUPS_PER_MODAL = 5;
export const CHECKLIST_CHANNELS_PER_PAGE = CHECKLIST_MAX_OPTIONS_PER_GROUP * CHECKLIST_MAX_GROUPS_PER_MODAL;
export const CHECKLIST_PAGE_SELECT_TIMEOUT_MS = 300_000;
export const CHECKLIST_MAX_PAGE_BUTTONS = 24;

export type ChecklistChannelTarget = {
  id: string;
  name: string;
  rawPosition: number;
  parentRawPosition: number;
};

export async function loadGuildTextChecklistChannels(guild: Guild): Promise<ChecklistChannelTarget[]> {
  await guild.channels.fetch();

  const channels: ChecklistChannelTarget[] = [];
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) {
      continue;
    }

    channels.push({
      id: channel.id,
      name: channel.name,
      rawPosition: channel.rawPosition,
      parentRawPosition: channel.parent?.rawPosition ?? -1,
    });
  }

  return channels.sort((a, b) => {
    if (a.parentRawPosition !== b.parentRawPosition) {
      return a.parentRawPosition - b.parentRawPosition;
    }

    if (a.rawPosition !== b.rawPosition) {
      return a.rawPosition - b.rawPosition;
    }

    return a.name.localeCompare(b.name);
  });
}
export function buildChannelCheckboxGroups(params: {
  channels: ChecklistChannelTarget[];
  selectedIds: Set<string>;
  locale: string;
  checkboxIdPrefix: string;
  labelKey: string;
  labelKeyContinued: string;
  descriptionKey: string;
}): ModalCheckboxGroupField[] {
  const checkboxGroups: ModalCheckboxGroupField[] = [];

  for (let index = 0; index < params.channels.length; index += CHECKLIST_MAX_OPTIONS_PER_GROUP) {
    const chunk = params.channels.slice(index, index + CHECKLIST_MAX_OPTIONS_PER_GROUP);
    const groupIndex = Math.floor(index / CHECKLIST_MAX_OPTIONS_PER_GROUP);
    const options: CheckboxGroupOption[] = chunk.map((channel) => ({
      label: safeSelectOptionText(`#${channel.name}`),
      value: channel.id,
      default: params.selectedIds.has(channel.id),
    }));

    checkboxGroups.push({
      kind: "checkboxGroup",
      customId: `${params.checkboxIdPrefix}_${groupIndex}`,
      labelKey: groupIndex === 0 ? params.labelKey : params.labelKeyContinued,
      descriptionKey: groupIndex === 0 ? params.descriptionKey : undefined,
      minValues: 0,
      maxValues: options.length,
      required: false,
      options,
    });
  }

  return checkboxGroups;
}

export function collectCheckedIds(
  multiValues: Record<string, string[]> | undefined,
  checkboxIdPrefix: string,
  groupCount: number,
): Set<string> {
  const selectedIds = new Set<string>();

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const values = multiValues?.[`${checkboxIdPrefix}_${groupIndex}`] ?? [];
    for (const channelId of values) {
      selectedIds.add(channelId);
    }
  }

  return selectedIds;
}

export function buildChecklistPageActionRows(
  totalPages: number,
  totalItems: number,
  doneLabel: string,
  pageButtonPrefix: string,
  doneButtonId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];

  for (let page = 1; page <= totalPages; page++) {
    const start = (page - 1) * CHECKLIST_CHANNELS_PER_PAGE + 1;
    const end = Math.min(page * CHECKLIST_CHANNELS_PER_PAGE, totalItems);

    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${pageButtonPrefix}${page}`)
        .setLabel(`${start}-${end}`)
        .setStyle(ButtonStyle.Secondary),
    );
  }

  buttons.push(new ButtonBuilder().setCustomId(doneButtonId).setLabel(doneLabel).setStyle(ButtonStyle.Secondary));

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(index, index + 5)));
  }

  return rows;
}

export function formatChecklistChannelMentions(
  ids: string[],
  availableChannels: ChecklistChannelTarget[],
  locale: string,
): string {
  if (ids.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  const knownIds = new Set(availableChannels.map((channel) => channel.id));
  return ids
    .map((channelId) =>
      knownIds.has(channelId) ? `<#${channelId}>` : `${localizer(locale, "general.unknown")} (${channelId})`,
    )
    .join(", ");
}
