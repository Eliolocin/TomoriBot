import {
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { llmProviderRepo } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { fetchNovelAISubscription } from "@/providers/novelai/novelaiService";
import { getOptApiKey, decryptApiKey } from "@/utils/security/crypto";
import { localizer } from "@/utils/text/localizer";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("usage").setDescription(localizer("en-US", "commands.novelai.usage.description"));

async function resolveNovelAiApiKey(tomoriState: TomoriState): Promise<string | null> {
  const optionalKey = await getOptApiKey(tomoriState.server_id, "novelai");
  if (optionalKey) return optionalKey;

  const savedConfig = await llmProviderRepo.loadSavedProviderConfig(tomoriState.server_id, "novelai");
  if (!savedConfig?.api_key) return null;
  return decryptApiKey(savedConfig.api_key, savedConfig.key_version || 1);
}

export function renderUsageMeter(percent: number): string {
  const clampedPercent = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round(clampedPercent / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

export function formatNovelAiUsageDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guild || !interaction.memberPermissions?.has("ManageGuild")) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.permission_denied_title",
      descriptionKey: "general.errors.permission_denied_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const serverId = interaction.guild.id;
    const tomoriState = await getCachedTomoriState(serverId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const apiKey = await resolveNovelAiApiKey(tomoriState);
    if (!apiKey) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.novelai.usage.no_api_key_title",
        descriptionKey: "commands.novelai.usage.no_api_key_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const subscription = await fetchNovelAISubscription(apiKey);
    const usage = subscription?.usage;
    if (!usage) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.novelai.usage.unavailable_title",
        descriptionKey: "commands.novelai.usage.unavailable_description",
        color: ColorCode.WARN,
      });
      return;
    }

    const meter = renderUsageMeter(usage.percent);
    const status = usage.isNegative
      ? localizer(locale, "commands.novelai.usage.status_unavailable")
      : localizer(locale, "commands.novelai.usage.status_available");
    const embed = new EmbedBuilder()
      .setTitle(localizer(locale, "commands.novelai.usage.title"))
      .setColor(usage.isNegative ? ColorCode.WARN : ColorCode.SUCCESS)
      .setDescription(`\`${meter}\` **${Math.round(usage.percent)}%**`)
      .addFields(
        {
          name: localizer(locale, "commands.novelai.usage.status_label"),
          value: status,
          inline: true,
        },
        {
          name: localizer(locale, "commands.novelai.usage.next_percent_label"),
          value: formatNovelAiUsageDuration(usage.timeUntilNextPercent),
          inline: true,
        },
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await log.error("Error in /novelai usage command", error, {
      errorType: "CommandExecutionError",
      metadata: { command: "novelai usage", guildId: interaction.guild?.id ?? null },
    });
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.novelai.usage.unavailable_title",
      descriptionKey: "commands.novelai.usage.unavailable_description",
      color: ColorCode.ERROR,
    });
  }
}
