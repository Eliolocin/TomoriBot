import { MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode } from "@/utils/misc/logger";
import { personaRepository } from "@/utils/db/repositories";
import { buildConditioningPanelPayload } from "@/utils/discord/ui/conditioningPanel";
import { deliverGuardedPanel } from "@/utils/discord/interactions/panelController";
import { loadConditioningManageEntriesWithPersonas } from "@/utils/discord/interactions/conditioningRoutes";

export function hasManageGuildPermission(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has("ManageGuild") ?? false;
}

export async function executeConditioningRemovalCommand(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  if (!hasManageGuildPermission(interaction)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.permission_denied_title",
      descriptionKey: "general.errors.permission_denied_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.guildId) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const personas = await personaRepository.loadAllForServer(interaction.guildId);
  if (personas.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const entries = await loadConditioningManageEntriesWithPersonas(personas);
  const payload = buildConditioningPanelPayload({
    locale,
    entries,
    rangeIndex: 0,
  });

  await deliverGuardedPanel(interaction, payload, { locale });
}
