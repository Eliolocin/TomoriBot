import { MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode } from "@/utils/misc/logger";
import { personaRepository } from "@/utils/db/repositories";
import {
  CONDITIONING_MODAL_CAPACITY,
  computeConditioningAggregateFingerprint,
} from "@/utils/discord/conditioningPanelCatalog";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import {
  CONDITIONING_PAGE_SELECT_MAX_ENTRIES,
  buildConditioningPageSelectRows,
  buildConditioningRemoveModal,
} from "@/utils/discord/ui/conditioningPanel";
import { showRoutedRawModal } from "@/utils/discord/ui/modals";
import { localizer } from "@/utils/text/localizer";
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
  if (entries.length === 0) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.conditioning.remove.empty_title",
      descriptionKey: "commands.conditioning.remove.empty_description",
      color: ColorCode.INFO,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (entries.length <= CONDITIONING_MODAL_CAPACITY) {
    const fp = computeConditioningAggregateFingerprint(entries, 0);
    const nonce = createNonce();
    const modalData = buildConditioningRemoveModal(locale, 0, fp, nonce, entries);
    await showRoutedRawModal(interaction, modalData);
    return;
  }

  const pageRows = buildConditioningPageSelectRows(locale, entries.length);
  const capped = entries.length > CONDITIONING_PAGE_SELECT_MAX_ENTRIES;
  await interaction.reply({
    content: capped
      ? localizer(locale, "commands.conditioning.remove.page_select_prompt_capped", {
          total: String(entries.length),
          shown: String(CONDITIONING_PAGE_SELECT_MAX_ENTRIES),
        })
      : localizer(locale, "commands.conditioning.remove.page_select_prompt", {
          total: String(entries.length),
        }),
    components: pageRows,
    flags: MessageFlags.Ephemeral,
  });
}
