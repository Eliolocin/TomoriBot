import { type ChatInputCommandInteraction, type Client, MessageFlags } from "discord.js";
import type { SummaryEmbedOptions } from "@/types/discord/embed";
import type { TomoriState } from "@/types/db/schema";
import { personaRepository, serverScheduleRepository, userRepository } from "@/utils/db/repositories";
import { whitelistRepository } from "@/utils/db/repositories/WhitelistRepository";
import { replyPaginatedStatusPages } from "@/utils/discord/ui/statusComponents";
import { ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";
import { formatBooleanLocalized } from "@/utils/text/processors/formatters";
import {
  formatAutochatChannels,
  formatChannelList,
  formatRandomTriggers,
  formatWelcomeChannel,
  formatWhitelistEntries,
  formatWhitelistPersonaEntries,
  formatWhitelistRolesEntries,
} from "@/utils/metrics/status/channelFormatters";
import { MAX_ITEMS_DISPLAY } from "@/utils/metrics/status/sharedFormatters";

export async function showServerChannelsStatus(
  client: Client,
  interaction: ChatInputCommandInteraction,
  serverDiscId: string,
  tomoriState: TomoriState,
  locale: string,
): Promise<void> {
  const config = tomoriState.config;
  const [blacklistedMemberIds, whitelistPersonas, whitelistChannels, whitelistRoles, randomTriggers, allPersonas] =
    await Promise.all([
      userRepository.getBlacklistedMemberIds(tomoriState.server_id),
      whitelistRepository.getAllWhitelistPersonas(tomoriState.server_id),
      whitelistRepository.getAllWhitelistChannels(tomoriState.server_id),
      whitelistRepository.getAllWhitelistRoles(tomoriState.server_id),
      serverScheduleRepository.getServerTriggers(tomoriState.server_id),
      personaRepository.loadAllForServer(serverDiscId),
    ]);

  const personaNameMap = new Map<number, string>();
  for (const persona of allPersonas) {
    if (persona.persona_id) {
      personaNameMap.set(persona.persona_id, persona.persona_nickname);
    }
  }
  const mainPersonaName =
    allPersonas.find((persona) => !persona.is_alter)?.persona_nickname ?? localizer(locale, "commands.choices.none");

  const blacklistedCount = blacklistedMemberIds.length;
  const blacklistedValue =
    blacklistedCount === 0
      ? localizer(locale, "commands.choices.none")
      : blacklistedCount <= MAX_ITEMS_DISPLAY
        ? blacklistedMemberIds.map((id) => `<@${id}>`).join(", ")
        : localizer(locale, "commands.status.field_blacklisted_members_with_count", {
            current: blacklistedCount,
          });

  const [
    autoChannelsValue,
    rpChannelsValue,
    privateChannelsValue,
    crosschannelBlocklistValue,
    welcomeChannelValue,
    thoughtLogChannelValue,
    whitelistPersonasValue,
    whitelistValue,
    whitelistRolesValue,
    randomTriggersValue,
  ] = await Promise.all([
    formatAutochatChannels(client, config, personaNameMap, mainPersonaName, locale),
    formatChannelList(client, config.rp_channel_ids, locale),
    formatChannelList(client, config.private_channel_ids, locale),
    formatChannelList(client, config.crosschannel_blocklist_ids ?? [], locale),
    formatWelcomeChannel(client, config, personaNameMap, locale),
    formatChannelList(client, config.thought_log_channel_disc_id ? [config.thought_log_channel_disc_id] : [], locale),
    formatWhitelistPersonaEntries(client, whitelistPersonas, personaNameMap, locale),
    formatWhitelistEntries(client, whitelistChannels, locale),
    formatWhitelistRolesEntries(whitelistRoles, locale),
    formatRandomTriggers(client, randomTriggers, personaNameMap, locale),
  ]);
  const welcomePromptConfiguredValue = formatBooleanLocalized(!!config.welcome_prompt?.trim(), locale);

  const channelsPage: SummaryEmbedOptions = {
    titleKey: "commands.status.server_page3_title",
    descriptionKey: "commands.status.server_page3_description",
    color: ColorCode.INFO,
    fields: [
      {
        nameKey: "commands.status.field_autoch_channels",
        value: autoChannelsValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_rp_channels",
        value: rpChannelsValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_private_channels",
        value: privateChannelsValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_crosschannel_blocklist",
        value: crosschannelBlocklistValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_welcome_channel",
        value: welcomeChannelValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_welcome_prompt",
        value: welcomePromptConfiguredValue,
        inline: true,
      },
      {
        nameKey: "commands.status.field_thought_logs_channel",
        value: thoughtLogChannelValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_whitelist_personas",
        value: whitelistPersonasValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_whitelist_channels",
        value: whitelistValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_whitelist_roles",
        value: whitelistRolesValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_random_triggers",
        value: randomTriggersValue,
        inline: false,
      },
      {
        nameKey: "commands.status.field_blacklisted_members",
        value: blacklistedValue,
        inline: blacklistedCount <= MAX_ITEMS_DISPLAY,
      },
    ],
  };

  await replyPaginatedStatusPages(interaction, locale, [channelsPage], MessageFlags.Ephemeral);
}
