import { type Client, TextChannel } from "discord.js";
import type {
  ChannelPersonaWhitelistRow,
  ChannelWhitelistRow,
  LlmRow,
  RandomTriggerRow,
  RoleWhitelistRow,
  AssembledServerConfig,
} from "@/types/db/schema";
import { CooldownType, type TomoriState } from "@/types/db/schema";
import { formatLlmDisplayLabel } from "@/utils/provider/modelDisplay";
import { localizer } from "@/utils/text/localizer";
import { getCooldownTypeLabel, MAX_ITEMS_DISPLAY, truncateText } from "@/utils/metrics/status/sharedFormatters";

export interface MatrixLinkStatusRow {
  channel_disc_id: string;
}

async function resolveChannelMention(client: Client, id: string, locale: string): Promise<string> {
  try {
    const channel = await client.channels.fetch(id);
    return channel instanceof TextChannel ? channel.toString() : `<#${id}>`;
  } catch {
    return `*<${localizer(locale, "commands.status.unknown_channel")} ${id}>*`;
  }
}

/**
 * Formats a list of channel IDs as mentions, collapsing to a count if over the max.
 * @returns Formatted channel list string, or localized "None" if empty
 */
export async function formatChannelList(client: Client, ids: string[], locale: string): Promise<string> {
  if (ids.length === 0) {
    return localizer(locale, "commands.choices.none");
  }
  const mentions = await Promise.all(ids.map((id) => resolveChannelMention(client, id, locale)));
  return mentions.length <= MAX_ITEMS_DISPLAY
    ? mentions.join(", ")
    : localizer(locale, "commands.status.item_count", {
        count: mentions.length,
      });
}

/**
 * Formats the channel whitelist as a numbered list.
 * Shows each whitelisted channel with its per-channel cooldown type and duration.
 * When no entries exist, shows an "all channels allowed" message instead.
 * @returns Formatted whitelist string
 */
export async function formatWhitelistEntries(
  client: Client,
  entries: ChannelWhitelistRow[],
  locale: string,
): Promise<string> {
  if (entries.length === 0) {
    return localizer(locale, "commands.status.whitelist_all_allowed");
  }

  const lines = await Promise.all(
    entries.map(async (entry, index) => {
      const mention = await resolveChannelMention(client, entry.channel_disc_id, locale);
      if (entry.cooldown_type === null || entry.cooldown_length === null) {
        return `${index + 1}. ${mention} (${localizer(locale, "commands.choices.inherit_global")})`;
      }

      const cooldownType = entry.cooldown_type;
      const typeLabel = getCooldownTypeLabel(locale, cooldownType);

      const detail = cooldownType === CooldownType.OFF ? typeLabel : `${typeLabel}, ${entry.cooldown_length}s`;

      return `${index + 1}. ${mention} (${detail})`;
    }),
  );

  return lines.join("\n");
}

/**
 * Formats the role whitelist as a numbered list.
 * When no entries exist, shows an "all roles allowed" message instead.
 * @returns Formatted role whitelist string
 */
export function formatWhitelistRolesEntries(entries: RoleWhitelistRow[], locale: string): string {
  if (entries.length === 0) {
    return localizer(locale, "commands.status.whitelist_roles_all_allowed");
  }

  return entries
    .map((entry, index) => {
      return `${index + 1}. <@&${entry.role_disc_id}>`;
    })
    .join("\n");
}

export async function formatWhitelistPersonaEntries(
  client: Client,
  entries: ChannelPersonaWhitelistRow[],
  personaNameMap: Map<number, string>,
  locale: string,
): Promise<string> {
  if (entries.length === 0) {
    return localizer(locale, "commands.status.whitelist_personas_all_allowed");
  }

  const channelsByPersona = new Map<number, string[]>();
  for (const entry of entries) {
    const channelIds = channelsByPersona.get(entry.persona_id) ?? [];
    channelIds.push(entry.channel_disc_id);
    channelsByPersona.set(entry.persona_id, channelIds);
  }

  const lines = await Promise.all(
    Array.from(channelsByPersona.entries()).map(async ([personaId, channelIds], index) => {
      const personaName = personaNameMap.get(personaId) ?? `ID:${personaId}`;
      const sortedChannelIds = [...new Set(channelIds)].sort((left, right) => left.localeCompare(right));
      const channelsValue =
        sortedChannelIds.length <= MAX_ITEMS_DISPLAY
          ? (
              await Promise.all(sortedChannelIds.map((channelId) => resolveChannelMention(client, channelId, locale)))
            ).join(", ")
          : localizer(locale, "commands.status.item_count", {
              count: sortedChannelIds.length,
            });
      return `${index + 1}. **${personaName}**: ${channelsValue}`;
    }),
  );

  return lines.join("\n");
}

/**
 * Each entry shows channel, persona name, timer interval, and trigger probability.
 * @returns Formatted random trigger list string, or localized "None" if empty
 */
export async function formatRandomTriggers(
  client: Client,
  triggers: RandomTriggerRow[],
  personaNameMap: Map<number, string>,
  locale: string,
): Promise<string> {
  if (triggers.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  const lines = await Promise.all(
    triggers.map(async (trigger, index) => {
      const mention = await resolveChannelMention(client, trigger.channel_disc_id, locale);

      const personaName =
        trigger.persona_id != null
          ? (personaNameMap.get(trigger.persona_id) ?? `ID:${trigger.persona_id}`)
          : localizer(locale, "commands.status.random_trigger_persona_random");
      const offsetSegment =
        trigger.random_offset_range != null && trigger.random_offset_range > 0
          ? ` · ${localizer(locale, "commands.status.random_trigger_offset_segment", {
              hours: trigger.random_offset_range,
            })}`
          : "";
      const silenceSegment =
        trigger.silence_threshold_hours != null && trigger.silence_threshold_hours > 0
          ? ` · ${localizer(locale, "commands.status.random_trigger_silence_segment", {
              hours: trigger.silence_threshold_hours,
            })}`
          : "";
      const respondToSelfSegment = trigger.respond_to_self
        ? ` · ${localizer(locale, "commands.status.random_trigger_self_segment")}`
        : "";
      const promptSegment = trigger.custom_prompt?.trim()
        ? ` · ${localizer(locale, "commands.status.random_trigger_prompt_segment")}`
        : "";
      const failureSegment =
        trigger.failure_threshold != null && trigger.failure_threshold > 0
          ? ` · ${localizer(locale, "commands.status.random_trigger_failure_segment", {
              count: trigger.failure_threshold,
            })}`
          : "";

      return truncateText(
        `${index + 1}. ${mention} · ${personaName} · ${localizer(
          locale,
          "commands.status.random_trigger_timer_segment",
          {
            hours: trigger.timer_hours,
          },
        )}${offsetSegment} · ${localizer(locale, "commands.status.random_trigger_chance_segment", {
          chance: trigger.chance_percent,
        })}${silenceSegment}${respondToSelfSegment}${promptSegment}${failureSegment}`,
        220,
      );
    }),
  );

  return lines.join("\n");
}

export async function formatAutochatChannels(
  client: Client,
  config: AssembledServerConfig,
  personaNameMap: Map<number, string>,
  mainPersonaName: string,
  locale: string,
): Promise<string> {
  const channelIds = config.autoch_disc_ids ?? [];
  if (channelIds.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  if (channelIds.length > MAX_ITEMS_DISPLAY) {
    return localizer(locale, "commands.status.item_count", {
      count: channelIds.length,
    });
  }

  const overrideMap = new Map(
    (config.autoch_persona_overrides ?? []).map((override) => [override.channel_disc_id, override.persona_id]),
  );

  const lines = await Promise.all(
    channelIds.map(async (channelId, index) => {
      const mention = await resolveChannelMention(client, channelId, locale);
      const personaId = overrideMap.get(channelId);
      const personaName = personaId != null ? (personaNameMap.get(personaId) ?? `ID:${personaId}`) : mainPersonaName;
      return `${index + 1}. ${mention} · ${personaName}`;
    }),
  );

  return lines.join("\n");
}

/**
 * Formats the list of channel-level LLM overrides as a numbered list.
 * Each entry shows channel mention and the model codename + provider.
 * @returns Formatted channel LLM override list string, or localized "None" if empty
 */
export async function formatChannelLlmOverrides(
  client: Client,
  overrides: { channelDiscId: string; llm: LlmRow }[],
  locale: string,
  customModelName?: string | null,
  otherModelCodename?: string | null,
): Promise<string> {
  if (overrides.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  const lines = await Promise.all(
    overrides.map(async (entry, index) => {
      const mention = await resolveChannelMention(client, entry.channelDiscId, locale);
      return `${index + 1}. ${mention} → ${formatLlmDisplayLabel(entry.llm, customModelName, otherModelCodename)}`;
    }),
  );

  return lines.join("\n");
}

/**
 * Formats the list of persona-level LLM overrides as a numbered list.
 * Only includes personas that have an explicit model override set.
 * @returns Formatted persona LLM override list string, or localized "None" if empty
 */
export function formatPersonaLlmOverrides(
  personas: TomoriState[],
  locale: string,
  customModelName?: string | null,
  otherModelCodename?: string | null,
): string {
  const overrides = personas.filter((p): p is TomoriState & { persona_llm: LlmRow } => p.persona_llm != null);

  if (overrides.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  return overrides
    .map((p, index) => {
      return `${index + 1}. **${p.persona_nickname}** → ${formatLlmDisplayLabel(p.persona_llm, customModelName, otherModelCodename)}`;
    })
    .join("\n");
}

/**
 * Formats welcome channel configuration as a single-line string.
 * Shows channel mention with associated persona if configured.
 * When no welcome channel is set, shows a localized "None" message.
 * @param config - TomoriState config containing welcome_channel_disc_id and welcome_persona_id
 * @param personaNameMap - Map of persona IDs to nicknames
 */
export async function formatWelcomeChannel(
  client: Client,
  config: AssembledServerConfig,
  personaNameMap: Map<number, string>,
  locale: string,
): Promise<string> {
  const welcomeChannelId = config.welcome_channel_disc_id;

  if (!welcomeChannelId) {
    return localizer(locale, "commands.choices.none");
  }

  const channelMention = await resolveChannelMention(client, welcomeChannelId, locale);

  const personaName =
    config.welcome_persona_id != null
      ? (personaNameMap.get(config.welcome_persona_id) ?? `ID:${config.welcome_persona_id}`)
      : localizer(locale, "commands.status.random_trigger_persona_random");

  return `${channelMention} · ${personaName}`;
}

export async function formatMatrixLinks(client: Client, links: MatrixLinkStatusRow[], locale: string): Promise<string> {
  if (links.length === 0) {
    return localizer(locale, "commands.choices.none");
  }

  const channelIds = links.map((link) => link.channel_disc_id);
  if (channelIds.length > MAX_ITEMS_DISPLAY) {
    return localizer(locale, "commands.status.item_count", {
      count: channelIds.length,
    });
  }

  const mentions = await Promise.all(channelIds.map((channelId) => resolveChannelMention(client, channelId, locale)));
  return mentions.map((mention, index) => `${index + 1}. ${mention}`).join("\n");
}
