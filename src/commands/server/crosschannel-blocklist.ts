import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { CheckboxGroupOption, ModalCheckboxGroupField } from "@/types/discord/modal";
import type { ErrorContext, TomoriState, UserRow } from "@/types/db/schema";
import { getCachedTomoriState, invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { configRepository } from "@/utils/db/repositories";
import { createStandardEmbed } from "@/utils/discord/embedHelper";
import { promptWithRawModal, safeSelectOptionText } from "@/utils/discord/ui/modals";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { log, ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const MODAL_CUSTOM_ID = "server_crosschannel_blocklist_modal";
const CHANNEL_CHECKBOX_ID_PREFIX = "server_crosschannel_blocklist_checkbox_group";
const PAGE_BUTTON_PREFIX = "server_crosschannel_blocklist_page_";
const DONE_BUTTON_ID = "server_crosschannel_blocklist_done";

const MAX_OPTIONS_PER_GROUP = 10;
const MAX_GROUPS_PER_MODAL = 5;
const CHANNELS_PER_PAGE = MAX_OPTIONS_PER_GROUP * MAX_GROUPS_PER_MODAL;
const PAGE_SELECT_TIMEOUT_MS = 300_000;
const MAX_PAGE_BUTTONS = 24;

type BlocklistChannelTarget = {
  id: string;
  name: string;
  type: ChannelType.GuildText | ChannelType.GuildAnnouncement | ChannelType.GuildForum | ChannelType.GuildMedia;
  parentName: string | null;
  rawPosition: number;
  parentRawPosition: number;
};

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("crosschannel-blocklist")
    .setDescription(localizer("en-US", "commands.server.crosschannel-blocklist.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guild || !interaction.guildId) {
    await replyInfoEmbed(interaction, userData.language_pref, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  try {
    const tomoriState = await getCachedTomoriState(interaction.guildId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const availableChannels = await loadBlocklistChannels(interaction.guild);
    if (availableChannels.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.server.crosschannel-blocklist.no_channels_title",
        descriptionKey: "commands.server.crosschannel-blocklist.no_channels_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const availableChannelIds = new Set(availableChannels.map((c) => c.id));
    const initialBlockedIds = new Set(
      (tomoriState.config.crosschannel_blocklist_ids ?? []).filter((id) => availableChannelIds.has(id)),
    );

    if (availableChannels.length <= CHANNELS_PER_PAGE) {
      await executeSinglePageBlocklist(
        interaction,
        locale,
        tomoriState,
        interaction.guild.id,
        availableChannels,
        initialBlockedIds,
      );
      return;
    }

    await executeMultiPageBlocklist(
      interaction,
      locale,
      tomoriState,
      interaction.guild.id,
      availableChannels,
      initialBlockedIds,
    );
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "server crosschannel-blocklist",
        guildId: interaction.guildId,
      },
    };
    await log.error("Error in /server crosschannel-blocklist command", error, context);

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
    });
  }
}
async function executeSinglePageBlocklist(
  interaction: ChatInputCommandInteraction,
  locale: string,
  tomoriState: TomoriState,
  guildId: string,
  availableChannels: BlocklistChannelTarget[],
  blockedIds: Set<string>,
): Promise<void> {
  const modalResult = await promptWithRawModal(
    interaction,
    locale,
    {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.server.crosschannel-blocklist.modal_title",
      components: buildCheckboxGroups(availableChannels, blockedIds, locale),
    },
    MessageFlags.Ephemeral,
  );

  if (modalResult.outcome !== "submit" || !modalResult.interaction) {
    log.info(`[CrossChannelBlocklist] Single-page modal ${modalResult.outcome}`);
    return;
  }

  const selectedIds = collectSelectedIds(
    modalResult.multiValues,
    Math.ceil(availableChannels.length / MAX_OPTIONS_PER_GROUP),
  );
  await persistBlocklistUpdate(
    modalResult.interaction,
    locale,
    tomoriState,
    guildId,
    blockedIds,
    selectedIds,
    availableChannels,
  );
}

async function executeMultiPageBlocklist(
  interaction: ChatInputCommandInteraction,
  locale: string,
  tomoriState: TomoriState,
  guildId: string,
  availableChannels: BlocklistChannelTarget[],
  initialBlockedIds: Set<string>,
): Promise<void> {
  const totalPages = Math.ceil(availableChannels.length / CHANNELS_PER_PAGE);
  let blockedIds = new Set(initialBlockedIds);

  if (totalPages > MAX_PAGE_BUTTONS) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.server.crosschannel-blocklist.too_many_pages_title",
      descriptionKey: "commands.server.crosschannel-blocklist.too_many_pages_description",
      descriptionVars: {
        channel_count: availableChannels.length.toString(),
        max_pages: MAX_PAGE_BUTTONS.toString(),
      },
      color: ColorCode.WARN,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const pageSelectEmbed = buildPageSelectEmbed(locale, availableChannels.length, totalPages, blockedIds.size);

  await interaction.reply({
    embeds: [pageSelectEmbed],
    components: buildPageActionRows(totalPages, availableChannels.length, locale),
    flags: MessageFlags.Ephemeral,
  });

  const pageSelectMessage = await interaction.fetchReply();

  while (true) {
    let buttonInteraction: ButtonInteraction;

    try {
      buttonInteraction = (await pageSelectMessage.awaitMessageComponent({
        filter: (i) =>
          i.user.id === interaction.user.id &&
          (i.customId.startsWith(PAGE_BUTTON_PREFIX) || i.customId === DONE_BUTTON_ID),
        time: PAGE_SELECT_TIMEOUT_MS,
      })) as ButtonInteraction;
    } catch {
      log.info("[CrossChannelBlocklist] Page selection timed out");
      break;
    }

    if (buttonInteraction.customId === DONE_BUTTON_ID) {
      await buttonInteraction.deferUpdate();
      break;
    }

    const selectedPage = Number.parseInt(buttonInteraction.customId.replace(PAGE_BUTTON_PREFIX, ""), 10);
    if (!Number.isInteger(selectedPage) || selectedPage < 1 || selectedPage > totalPages) {
      await buttonInteraction.deferUpdate();
      continue;
    }

    const startIndex = (selectedPage - 1) * CHANNELS_PER_PAGE;
    const pageChannels = availableChannels.slice(startIndex, startIndex + CHANNELS_PER_PAGE);
    const checkboxGroups = buildCheckboxGroups(pageChannels, blockedIds, locale);

    const modalResult = await promptWithRawModal(
      buttonInteraction,
      locale,
      {
        modalCustomId: MODAL_CUSTOM_ID,
        modalTitleKey: "commands.server.crosschannel-blocklist.modal_title",
        components: checkboxGroups,
      },
      MessageFlags.Ephemeral,
    );

    if (modalResult.outcome === "submit" && modalResult.interaction) {
      const selectedIds = collectSelectedIds(modalResult.multiValues, checkboxGroups.length);
      const nextBlockedIds = new Set(blockedIds);

      for (const channel of pageChannels) {
        nextBlockedIds.delete(channel.id);
      }

      for (const channelId of selectedIds) {
        nextBlockedIds.add(channelId);
      }

      blockedIds = await persistBlocklistUpdate(
        modalResult.interaction,
        locale,
        tomoriState,
        guildId,
        blockedIds,
        nextBlockedIds,
        availableChannels,
      );
    } else {
      log.info(`[CrossChannelBlocklist] Page modal ${modalResult.outcome}, returning to page selector`);
    }

    try {
      await interaction.editReply({
        embeds: [buildPageSelectEmbed(locale, availableChannels.length, totalPages, blockedIds.size)],
        components: buildPageActionRows(totalPages, availableChannels.length, locale),
      });
    } catch {
      log.info("[CrossChannelBlocklist] Could not refresh page buttons, ending loop");
      break;
    }
  }

  try {
    await interaction.editReply({
      embeds: [buildPageSelectEmbed(locale, availableChannels.length, totalPages, blockedIds.size)],
      components: [],
    });
  } catch {
    // Best-effort cleanup
  }
}

async function loadBlocklistChannels(guild: ChatInputCommandInteraction["guild"]): Promise<BlocklistChannelTarget[]> {
  if (!guild) {
    return [];
  }

  await guild.channels.fetch();

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

function buildCheckboxGroups(
  channels: BlocklistChannelTarget[],
  blockedIds: Set<string>,
  locale: string,
): ModalCheckboxGroupField[] {
  const checkboxGroups: ModalCheckboxGroupField[] = [];

  for (let index = 0; index < channels.length; index += MAX_OPTIONS_PER_GROUP) {
    const chunk = channels.slice(index, index + MAX_OPTIONS_PER_GROUP);
    const groupIndex = Math.floor(index / MAX_OPTIONS_PER_GROUP);
    const options: CheckboxGroupOption[] = chunk.map((channel) => ({
      label: safeSelectOptionText(formatChannelOptionLabel(channel, locale)),
      value: channel.id,
      description: channel.parentName
        ? safeSelectOptionText(
            localizer(locale, "commands.server.crosschannel-blocklist.option_description_category", {
              category_name: channel.parentName,
            }),
          )
        : undefined,
      default: blockedIds.has(channel.id),
    }));

    checkboxGroups.push({
      kind: "checkboxGroup",
      customId: `${CHANNEL_CHECKBOX_ID_PREFIX}_${groupIndex}`,
      labelKey:
        groupIndex === 0
          ? "commands.server.crosschannel-blocklist.checkbox_label"
          : "commands.server.crosschannel-blocklist.checkbox_label_continued",
      descriptionKey: groupIndex === 0 ? "commands.server.crosschannel-blocklist.checkbox_description" : undefined,
      minValues: 0,
      maxValues: options.length,
      required: false,
      options,
    });
  }

  return checkboxGroups;
}

function formatChannelOptionLabel(channel: BlocklistChannelTarget, locale: string): string {
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

function collectSelectedIds(multiValues: Record<string, string[]> | undefined, groupCount: number): Set<string> {
  const selectedIds = new Set<string>();

  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    const values = multiValues?.[`${CHANNEL_CHECKBOX_ID_PREFIX}_${groupIndex}`] ?? [];
    for (const channelId of values) {
      selectedIds.add(channelId);
    }
  }

  return selectedIds;
}

function buildPageActionRows(
  totalPages: number,
  totalChannels: number,
  locale: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];

  for (let page = 1; page <= totalPages; page++) {
    const start = (page - 1) * CHANNELS_PER_PAGE + 1;
    const end = Math.min(page * CHANNELS_PER_PAGE, totalChannels);

    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${PAGE_BUTTON_PREFIX}${page}`)
        .setLabel(`${start}-${end}`)
        .setStyle(ButtonStyle.Secondary),
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(DONE_BUTTON_ID)
      .setLabel(localizer(locale, "commands.server.crosschannel-blocklist.done_button"))
      .setStyle(ButtonStyle.Secondary),
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(index, index + 5)));
  }

  return rows;
}

function buildPageSelectEmbed(locale: string, channelCount: number, totalPages: number, blockedCount: number) {
  return createStandardEmbed(locale, {
    titleKey: "commands.server.crosschannel-blocklist.select_page_title",
    descriptionKey: "commands.server.crosschannel-blocklist.select_page_description",
    descriptionVars: {
      channel_count: channelCount,
      total_pages: totalPages,
      blocked_count: blockedCount,
    },
    color: ColorCode.INFO,
  });
}

async function persistBlocklistUpdate(
  responseInteraction: ModalSubmitInteraction,
  locale: string,
  tomoriState: TomoriState,
  guildId: string,
  previousBlockedIds: Set<string>,
  nextBlockedIds: Set<string>,
  availableChannels: BlocklistChannelTarget[],
): Promise<Set<string>> {
  const enabledIds = [...nextBlockedIds].filter((channelId) => !previousBlockedIds.has(channelId));
  const disabledIds = [...previousBlockedIds].filter((channelId) => !nextBlockedIds.has(channelId));

  if (enabledIds.length === 0 && disabledIds.length === 0) {
    await replyInfoEmbed(responseInteraction, locale, {
      titleKey: "commands.server.crosschannel-blocklist.no_changes_title",
      descriptionKey: "commands.server.crosschannel-blocklist.no_changes_description",
      color: ColorCode.INFO,
    });
    return previousBlockedIds;
  }

  const updated = await configRepository.updateChannelScopeConfig(tomoriState.server_id, {
    crosschannel_blocklist_ids: [...nextBlockedIds],
  });

  if (!updated) {
    const context: ErrorContext = {
      personaId: tomoriState.persona_id,
      serverId: tomoriState.server_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "server crosschannel-blocklist",
        guildId,
      },
    };
    await log.error("Failed to update crosschannel_blocklist_ids config", new Error("Database update failed"), context);

    await replyInfoEmbed(responseInteraction, locale, {
      titleKey: "general.errors.update_failed_title",
      descriptionKey: "general.errors.update_failed_description",
      color: ColorCode.ERROR,
    });
    return previousBlockedIds;
  }

  invalidateTomoriStateCache(guildId);

  const channelLookup = new Map(availableChannels.map((channel) => [channel.id, channel]));
  await replyInfoEmbed(responseInteraction, locale, {
    titleKey: "commands.server.crosschannel-blocklist.success_title",
    descriptionKey: "commands.server.crosschannel-blocklist.success_description",
    descriptionVars: {
      enabled_count: enabledIds.length.toString(),
      enabled_channels: formatChannelMentionList(enabledIds, channelLookup, locale),
      disabled_count: disabledIds.length.toString(),
      disabled_channels: formatChannelMentionList(disabledIds, channelLookup, locale),
      blocked_count: nextBlockedIds.size.toString(),
    },
    color: ColorCode.SUCCESS,
  });

  log.info(
    `[CrossChannelBlocklist] Updated in guild ${guildId}: +${enabledIds.length} / -${disabledIds.length} / total ${nextBlockedIds.size}`,
  );

  return nextBlockedIds;
}

function formatChannelMentionList(
  channelIds: string[],
  channelLookup: Map<string, BlocklistChannelTarget>,
  locale: string,
): string {
  if (channelIds.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  return channelIds
    .map((channelId) =>
      channelLookup.has(channelId) ? `<#${channelId}>` : `${localizer(locale, "general.unknown")} (${channelId})`,
    )
    .join(", ");
}
