import {
  type ChatInputCommandInteraction,
  type Client,
  MessageFlags,
  type SlashCommandBooleanOption,
  type SlashCommandBuilder,
  type SlashCommandStringOption,
} from "discord.js";
import type { ErrorContext, UserRow } from "@/types/db/schema";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { serverRepository } from "@/utils/db/repositories";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

export const guildOnly = true;
export const managerOnly = true;

/**
 * Declared per option rather than per builder because `SlashCommandBuilder` and
 * `SlashCommandSubcommandBuilder` do not share an addOption signature that survives a union.
 */
const buildConfirmationOption = (option: SlashCommandStringOption): SlashCommandStringOption =>
  option
    .setName("confirmation")
    .setDescription(localizer("en-US", "commands.nuke.confirmation_description"))
    .setRequired(true)
    .addChoices(
      {
        name: localizer("en-US", "commands.nuke.confirmation_choice_yes"),
        value: "yes",
      },
      {
        name: localizer("en-US", "commands.nuke.confirmation_choice_no"),
        value: "no",
      },
    );

const buildPreservePersonasOption = (option: SlashCommandBooleanOption): SlashCommandBooleanOption =>
  option
    .setName("preserve_personas")
    .setDescription(localizer("en-US", "commands.nuke.preserve_personas_description"))
    .setRequired(false);

/**
 * Configures the `/nuke` command.
 * Completely wipes a server's settings and data, optionally preserving personas.
 *
 * Options:
 *  - `confirmation` (required, yes/no): mirrors the `/server config import` safety gate.
 *  - `preserve_personas` (optional, default false): keep personas + their subtree.
 */
export const configureCommand = (command: SlashCommandBuilder) =>
  command
    .setName("nuke")
    .setDescription(localizer("en-US", "commands.nuke.description"))
    .addStringOption(buildConfirmationOption)
    .addBooleanOption(buildPreservePersonasOption);

/**
 * Executes the destructive nuke flow.
 *
 * 1. ManageGuild permission gate
 * 2. Confirmation gate (reject if "no")
 * 3. Look up internal server_id
 * 4. Fetch + best-effort delete managed Discord webhooks on Discord's side
 * 5. Call serverRepository.nukeServer() with the chosen mode
 * 6. Invalidate tomoriStateCache for the guild
 * 7. Reply with success embed prompting `/config setup` (or noting personas were kept)
 */
export async function execute(
  client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  const guildDiscId = interaction.guild?.id ?? interaction.user.id;

  try {
    // Permission check: ManageGuild required for destructive server ops
    if (interaction.guild) {
      const hasPermission = interaction.memberPermissions?.has("ManageGuild") ?? false;
      if (!hasPermission) {
        await replyInfoEmbed(interaction, locale, {
          titleKey: "commands.data.delete.no_permission_title",
          descriptionKey: "commands.data.delete.no_permission_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    const confirmation = interaction.options.getString("confirmation", true);
    if (confirmation !== "yes") {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.nuke.cancelled_title",
        descriptionKey: "commands.nuke.cancelled_description",
        color: ColorCode.INFO,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const preservePersonas = interaction.options.getBoolean("preserve_personas") ?? false;

    // Resolve internal server ID; missing row means "nothing to nuke"
    const serverId = await serverRepository.loadServerIdByDiscId(guildDiscId);
    if (!serverId) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.delete.no_server_data_title",
        descriptionKey: "commands.data.delete.no_server_data_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Defer once we commit to the destructive path because work may take a few seconds
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Best-effort Discord-side webhook cleanup BEFORE wiping DB rows.
    //    We pull decrypted tokens first because the rows are about to be deleted.
    let webhooksDeleted = 0;
    let webhooksFailed = 0;
    const managedWebhooks = await serverRepository.listManagedWebhooksDecrypted(guildDiscId);
    for (const { webhookDiscId, token } of managedWebhooks) {
      try {
        const webhook = await client.fetchWebhook(webhookDiscId, token);
        await webhook.delete("TomoriBot /nuke");
        webhooksDeleted++;
      } catch (error) {
        // Don't fail nuke if Discord cleanup fails, so log and move on
        webhooksFailed++;
        log.warn(`[Nuke] Failed to delete Discord webhook ${webhookDiscId} for guild ${guildDiscId}`, error);
      }
    }

    // DB wipe: atomic on the preserve-mode branch, single cascade on full nuke
    const nuked = await serverRepository.nukeServer(serverId, guildDiscId, {
      preservePersonas,
    });

    if (!nuked) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.delete.no_server_data_title",
        descriptionKey: "commands.data.delete.no_server_data_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Invalidate cache AFTER successful write
    invalidateTomoriStateCache(guildDiscId);

    await replyInfoEmbed(interaction, locale, {
      titleKey: preservePersonas ? "commands.nuke.success_preserved_title" : "commands.nuke.success_full_title",
      descriptionKey: preservePersonas
        ? "commands.nuke.success_preserved_description"
        : "commands.nuke.success_full_description",
      descriptionVars: {
        webhooks_deleted: webhooksDeleted,
        webhooks_failed: webhooksFailed,
      },
      color: ColorCode.SUCCESS,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "nuke",
        guildDiscId,
        options: interaction.options?.data,
      },
    };
    await log.error("Error in /nuke command", error as Error, context);

    // Error reply: use editReply if we already deferred, else replyInfoEmbed
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: localizer(locale, "general.errors.unknown_error_description"),
      });
      return;
    }

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
