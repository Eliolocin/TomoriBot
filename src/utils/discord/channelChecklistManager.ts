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

export type BlocklistChannelTarget = {
  id: string;
  name: string;
  type: ChannelType.GuildText | ChannelType.GuildAnnouncement | ChannelType.GuildForum | ChannelType.GuildMedia;
  parentName: string | null;
  rawPosition: number;
  parentRawPosition: number;
};

export type ChannelOverrideChannelTarget = {
  id: string;
  name: string;
  type:
    | ChannelType.GuildText
    | ChannelType.GuildAnnouncement
    | ChannelType.PublicThread
    | ChannelType.PrivateThread
    | ChannelType.AnnouncementThread;
  rawPosition: number;
  parentRawPosition: number;
};

function sortChecklistChannels<T extends { name: string; rawPosition: number; parentRawPosition: number }>(
  channels: T[],
): T[] {
  return channels.sort((left, right) => {
    if (left.parentRawPosition !== right.parentRawPosition) {
      return left.parentRawPosition - right.parentRawPosition;
    }

    if (left.rawPosition !== right.rawPosition) {
      return left.rawPosition - right.rawPosition;
    }

    return left.name.localeCompare(right.name);
  });
}

function readGuildTextChecklistChannels(guild: Guild): ChecklistChannelTarget[] {
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

  return sortChecklistChannels(channels);
}

export async function loadGuildTextChecklistChannels(guild: Guild): Promise<ChecklistChannelTarget[]> {
  await guild.channels.fetch();
  return readGuildTextChecklistChannels(guild);
}

export function loadCachedGuildTextChecklistChannels(guild: Guild): ChecklistChannelTarget[] {
  return readGuildTextChecklistChannels(guild);
}

function readGuildChannelOverrideChannels(guild: Guild): ChannelOverrideChannelTarget[] {
  const channels: ChannelOverrideChannelTarget[] = [];

  for (const channel of guild.channels.cache.values()) {
    switch (channel.type) {
      case ChannelType.GuildText:
      case ChannelType.GuildAnnouncement:
      case ChannelType.PublicThread:
      case ChannelType.PrivateThread:
      case ChannelType.AnnouncementThread:
        channels.push({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          rawPosition:
            "rawPosition" in channel && typeof channel.rawPosition === "number"
              ? channel.rawPosition
              : (channel.parent?.rawPosition ?? -1),
          parentRawPosition: channel.parent?.rawPosition ?? -1,
        });
        break;
      default:
        break;
    }
  }

  return sortChecklistChannels(channels);
}

export function loadCachedGuildChannelOverrideChannels(guild: Guild): ChannelOverrideChannelTarget[] {
  return readGuildChannelOverrideChannels(guild);
}

export async function loadGuildBlocklistChannels(guild: Guild | null): Promise<BlocklistChannelTarget[]> {
  if (!guild) {
    return [];
  }

  await guild.channels.fetch();
  return readGuildBlocklistChannels(guild);
}

export function loadCachedGuildBlocklistChannels(guild: Guild): BlocklistChannelTarget[] {
  return readGuildBlocklistChannels(guild);
}

function readGuildBlocklistChannels(guild: Guild): BlocklistChannelTarget[] {
  const channels: BlocklistChannelTarget[] = [];

  for (const channel of guild.channels.cache.values()) {
    switch (channel.type) {
      case ChannelType.GuildText:
      case ChannelType.GuildAnnouncement:
      case ChannelType.GuildForum:
      case ChannelType.GuildMedia:
        channels.push({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          parentName: channel.parent?.name ?? null,
          rawPosition: channel.rawPosition,
          parentRawPosition: channel.parent?.rawPosition ?? -1,
        });
        break;
      default:
        break;
    }
  }

  return sortChecklistChannels(channels);
}

export function formatGuildBlocklistChannelOptionLabel(channel: BlocklistChannelTarget, locale: string): string {
  switch (channel.type) {
    case ChannelType.GuildForum:
      return localizer(locale, "commands.server.crosschannel-blocklist.channel_label_forum", {
        channel_name: channel.name,
      });
    case ChannelType.GuildMedia:
      return localizer(locale, "commands.server.crosschannel-blocklist.channel_label_media", {
        channel_name: channel.name,
      });
    default:
      return `#${channel.name}`;
  }
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
