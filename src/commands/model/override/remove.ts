/**
 * /model override remove
 * Removes channel and persona model overrides from the server.
 * Presents one combined bulk-management modal with all current overrides
 * pre-checked. Unchecked entries are removed on submit.
 */

import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { showRoutedRawModal } from "@/utils/discord/ui/modals";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { createNonce } from "@/utils/discord/panelRouteTokens";
import {
  MODEL_OVERRIDE_MODAL_CAPACITY,
  computeModelOverrideBatchFingerprint,
  type ChannelOverrideEntry,
  type ModelOverrideEntry,
  type PersonaOverrideEntry,
} from "@/utils/discord/modelOverrideCatalog";
import {
  MODEL_OVERRIDE_PAGE_SELECT_MAX_ENTRIES,
  buildModelOverridePageSelectRows,
  buildModelOverrideRemoveModal,
} from "@/utils/discord/ui/modelOverridePanel";
import { loadModelOverrideEntries } from "@/utils/discord/interactions/modelOverrideRoutes";

import type { UserRow, ErrorContext } from "@/types/db/schema";

export type { ChannelOverrideEntry, PersonaOverrideEntry, ModelOverrideEntry };

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("remove").setDescription(localizer("en-US", "commands.model.override.remove.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.guild) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has("ManageGuild")) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.permission_denied_title",
      descriptionKey: "general.errors.permission_denied_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const tomoriState = await getCachedTomoriState(interaction.guild.id);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const { entries } = await loadModelOverrideEntries(tomoriState.server_id, interaction.guild.id);

    if (entries.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.model.override.remove.none_title",
        descriptionKey: "commands.model.override.remove.none_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (entries.length <= MODEL_OVERRIDE_MODAL_CAPACITY) {
      const fp = computeModelOverrideBatchFingerprint(entries, 0);
      const nonce = createNonce();
      const modalData = buildModelOverrideRemoveModal(locale, 0, fp, nonce, entries, interaction.guild);
      await showRoutedRawModal(interaction, modalData);
      return;
    }

    const pageRows = buildModelOverridePageSelectRows(locale, entries.length);
    const capped = entries.length > MODEL_OVERRIDE_PAGE_SELECT_MAX_ENTRIES;
    await interaction.reply({
      content: capped
        ? localizer(locale, "commands.model.override.remove.page_select_prompt_capped", {
            total: String(entries.length),
            shown: String(MODEL_OVERRIDE_PAGE_SELECT_MAX_ENTRIES),
          })
        : localizer(locale, "commands.model.override.remove.page_select_prompt", {
            total: String(entries.length),
          }),
      components: pageRows,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      errorType: "CommandExecutionError",
      metadata: { command: "model override remove" },
    };
    await log.error("Error in /model override remove", error as Error, context);

    if (!interaction.replied && !interaction.deferred) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.unknown_error_title",
        descriptionKey: "general.errors.unknown_error_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.followUp({
        content: localizer(locale, "general.errors.unknown_error_description"),
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}
