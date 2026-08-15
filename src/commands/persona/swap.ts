/**
 * Persona Swap Command
 * Swaps the main persona with an alter persona
 */

import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags, EmbedBuilder, AttachmentBuilder } from "discord.js";
import { localizer } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed, promptWithPaginatedModal, safeSelectOptionText } from "../../utils/discord/interactionHelper";
import { invalidateTomoriStateCache } from "../../utils/cache/tomoriStateCache";
import type { UserRow } from "../../types/db/schema";
import type { SelectOption } from "../../types/discord/modal";
import { personaRepository } from "@/utils/db/repositories";
import { convertToPNG } from "../../utils/image/imageProcessor";
import { sanitizeAttachmentFilenamePart } from "@/utils/discord/attachmentFilename";
import {
  deletePersonaAvatarFromStorage,
  loadStoredPersonaAvatarBuffer,
  uploadPersonaAvatarToStorage,
} from "../../utils/storage/avatarStorage";
import { isAvatarUpdateRateLimited } from "../../utils/discord/avatarRateLimit";

async function resolveCurrentBotAvatarUrl(
  client: Client,
  interaction: ChatInputCommandInteraction,
): Promise<string | null> {
  if (!interaction.guild) {
    return client.user?.displayAvatarURL({ size: 1024, extension: "png", forceStatic: true }) ?? null;
  }

  const fetchedBotMember = client.user
    ? await interaction.guild.members.fetch({ user: client.user.id, force: true }).catch((error) => {
        log.warn(
          `Failed to fetch fresh bot member avatar for swap: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        return null;
      })
    : null;

  return (
    fetchedBotMember?.displayAvatarURL({ size: 1024, extension: "png", forceStatic: true }) ??
    interaction.guild.members.me?.displayAvatarURL({ size: 1024, extension: "png", forceStatic: true }) ??
    client.user?.displayAvatarURL({ size: 1024, extension: "png", forceStatic: true }) ??
    null
  );
}

const MODAL_CUSTOM_ID = "persona_swap_modal";
const PERSONA_SELECT_ID = "persona_select";

/**
 * Configure the 'swap' subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("swap").setDescription(localizer("en-US", "commands.persona.swap.description"));

/**
 * Executes the 'swap' command
 * Swaps the main persona with an alter persona
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
): Promise<void> {
  try {
    if (!interaction.guild) {
      await replyInfoEmbed(
        interaction,
        locale,
        {
          titleKey: "general.errors.guild_only_title",
          descriptionKey: "general.errors.guild_only_description",
          color: ColorCode.ERROR,
        },
        MessageFlags.SuppressNotifications,
      );
      return;
    }

    const hasPermission = interaction.memberPermissions?.has("ManageGuild") ?? false;

    if (!hasPermission) {
      await replyInfoEmbed(
        interaction,
        locale,
        {
          titleKey: "commands.persona.swap.no_permission_title",
          descriptionKey: "commands.persona.swap.no_permission_description",
          color: ColorCode.ERROR,
        },
        MessageFlags.SuppressNotifications,
      );
      return;
    }

    const allPersonas = await personaRepository.loadAllForServer(interaction.guild.id);

    const mainPersona = allPersonas.find((p) => !p.is_alter);
    const alterPersonas = allPersonas.filter((p) => p.is_alter);

    if (alterPersonas.length === 0) {
      await replyInfoEmbed(
        interaction,
        locale,
        {
          titleKey: "commands.persona.swap.no_alters_error_title",
          descriptionKey: "commands.persona.swap.no_alters_error_description",
          color: ColorCode.WARN,
        },
        MessageFlags.SuppressNotifications,
      );
      return;
    }

    // Error if main persona doesn't exist (should never happen, but safety check)
    if (!mainPersona) {
      await replyInfoEmbed(
        interaction,
        locale,
        {
          titleKey: "general.errors.tomori_not_setup_title",
          descriptionKey: "general.errors.tomori_not_setup_description",
          color: ColorCode.ERROR,
        },
        MessageFlags.SuppressNotifications,
      );
      return;
    }

    const alterSelectOptions: SelectOption[] = alterPersonas.map((persona, index) => ({
      label: safeSelectOptionText(persona.persona_nickname),
      value: index.toString(), // Use index to avoid truncation issues
    }));

    const modalResult = await promptWithPaginatedModal(interaction, locale, {
      modalCustomId: MODAL_CUSTOM_ID,
      modalTitleKey: "commands.persona.swap.modal_title",
      components: [
        {
          customId: PERSONA_SELECT_ID,
          labelKey: "commands.persona.swap.select_label",
          placeholder: "commands.persona.swap.select_placeholder",
          required: true,
          options: alterSelectOptions,
        },
      ],
    });

    if (modalResult.outcome !== "submit") {
      log.info(`Persona swap modal ${modalResult.outcome} for user ${interaction.user.id}`);
      return;
    }

    // Defer reply before long operations
    // biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees interaction exists
    const modalSubmitInteraction = modalResult.interaction!;
    await modalSubmitInteraction.deferReply();

    const selectedIndex = Number.parseInt(
      // biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
      modalResult.values![PERSONA_SELECT_ID],
      10,
    );
    const selectedAlter = alterPersonas[selectedIndex];
    const previousSelectedAlterAvatarUrl = selectedAlter.webhook_avatar_url;
    const previousMainAvatarUrl = mainPersona.webhook_avatar_url;

    // Capture current bot avatar BEFORE swapping (represents former main persona)
    const liveFormerMainAvatarUrl = await resolveCurrentBotAvatarUrl(_client, interaction);
    const formerMainAvatarReference = liveFormerMainAvatarUrl ?? previousMainAvatarUrl;
    const formerMainAvatarDisplayUrl =
      formerMainAvatarReference && /^https?:\/\//i.test(formerMainAvatarReference) ? formerMainAvatarReference : null;
    let formerMainAvatarBuffer: Buffer | null = null;
    if (formerMainAvatarReference) {
      try {
        formerMainAvatarBuffer = await loadStoredPersonaAvatarBuffer(formerMainAvatarReference);
      } catch (downloadError) {
        log.warn(
          `Failed to prefetch former main avatar for embed (non-fatal): ${downloadError instanceof Error ? downloadError.message : "Unknown error"}`,
        );
      }
    }

    // Swap is_alter flags in database.
    // Trigger words are persona-scoped in persona_configs and do not need migration.
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by prior checks
    const swapSucceeded = await personaRepository.swapPersona(mainPersona.persona_id!, selectedAlter.persona_id!);
    if (!swapSucceeded) {
      throw new Error("Persona swap database update failed.");
    }

    // Try to update nickname and avatar separately (non-fatal if fails)
    let avatarSwapSuccess = false;
    let avatarSwapRateLimited = false;
    let avatarSwapFailed = false;
    let nicknameSwapSuccess = false;
    let nicknameSwapRateLimited = false;
    let nicknameSwapFailed = false;
    let selectedAlterAvatarBuffer: Buffer | null = null;
    let newFormerMainAvatarUrl: string | null = null;
    let newFormerMainS3Url: string | null = null;
    const avatarUrl = selectedAlter.webhook_avatar_url;
    const avatarSwapAttempted = Boolean(avatarUrl);
    const endpoint = `https://discord.com/api/v10/guilds/${interaction.guild.id}/members/@me`;

    try {
      const nicknameResponse = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          nick: selectedAlter.persona_nickname,
        }),
      });

      if (nicknameResponse.ok) {
        nicknameSwapSuccess = true;
      } else {
        const errorText = await nicknameResponse.text();
        if (isAvatarUpdateRateLimited(nicknameResponse.status, errorText)) {
          nicknameSwapRateLimited = true;
        }
        nicknameSwapFailed = true;
        log.warn(
          `Failed to update guild nickname during swap (non-fatal): ${nicknameResponse.status} ${nicknameResponse.statusText} - ${errorText}`,
        );
      }
    } catch (nicknameError) {
      nicknameSwapFailed = true;
      log.warn(
        `Failed to update guild nickname during swap (non-fatal): ${nicknameError instanceof Error ? nicknameError.message : "Unknown error"}`,
      );
    }

    if (avatarUrl) {
      try {
        const storedAvatarBuffer = await loadStoredPersonaAvatarBuffer(avatarUrl);
        if (storedAvatarBuffer) {
          const avatarBuffer = await convertToPNG(storedAvatarBuffer);
          selectedAlterAvatarBuffer = avatarBuffer;

          // Set as guild avatar using Discord API (same as /server avatar)
          const response = await fetch(endpoint, {
            method: "PATCH",
            headers: {
              Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              avatar: `data:image/png;base64,${avatarBuffer.toString("base64")}`,
            }),
          });

          if (response.ok) {
            avatarSwapSuccess = true;
            log.success(
              `Successfully swapped guild avatar to "${selectedAlter.persona_nickname}" for guild ${interaction.guild.id}`,
            );
          } else {
            const errorText = await response.text();
            if (isAvatarUpdateRateLimited(response.status, errorText)) {
              avatarSwapRateLimited = true;
            }
            avatarSwapFailed = true;
            log.warn(
              `Failed to update guild avatar (non-fatal): ${response.status} ${response.statusText} - ${errorText}`,
            );
          }
        } else {
          avatarSwapFailed = true;
          log.warn(`Failed to load alter avatar for swap (non-fatal): ${avatarUrl}`);
        }
      } catch (avatarError) {
        // Non-fatal error - persona swap was successful, avatar swap failed
        avatarSwapFailed = true;
        log.warn(
          `Failed to swap guild avatar during persona swap (non-fatal): ${avatarError instanceof Error ? avatarError.message : "Unknown error"}`,
        );
      }
    }

    invalidateTomoriStateCache(interaction.guild.id);

    const descriptionLines = [
      localizer(locale, "commands.persona.swap.success_description", {
        new_main: selectedAlter.persona_nickname,
        old_main: mainPersona.persona_nickname,
      }),
    ];

    if (nicknameSwapRateLimited || nicknameSwapFailed) {
      descriptionLines.push(localizer(locale, "commands.persona.swap.nickname_update_failed"));
    } else if (nicknameSwapSuccess) {
      descriptionLines.push(localizer(locale, "commands.persona.swap.nickname_update_success"));
    }

    if (avatarSwapRateLimited) {
      descriptionLines.push(localizer(locale, "commands.persona.swap.avatar_update_rate_limited"));
    } else if (avatarSwapSuccess) {
      descriptionLines.push(localizer(locale, "commands.persona.swap.avatar_update_success"));
    } else if (avatarSwapAttempted && avatarSwapFailed) {
      descriptionLines.push(localizer(locale, "commands.persona.swap.avatar_update_failed"));
    }

    const successEmbed = new EmbedBuilder()
      .setTitle(localizer(locale, "commands.persona.swap.success_title"))
      .setDescription(descriptionLines.join("\n\n"))
      .setColor(
        avatarSwapRateLimited ||
          (avatarSwapAttempted && avatarSwapFailed) ||
          nicknameSwapRateLimited ||
          nicknameSwapFailed
          ? ColorCode.WARN
          : ColorCode.SUCCESS,
      );

    let formerMainAvatarAttachment: AttachmentBuilder | null = null;
    if (formerMainAvatarBuffer) {
      const sanitizedNickname = sanitizeAttachmentFilenamePart(mainPersona.persona_nickname, {
        fallback: "persona",
        maxLength: 50,
      });
      const timestamp = Date.now();
      const avatarFilename = `tomori-preset-${sanitizedNickname}-${timestamp}.png`;
      formerMainAvatarAttachment = new AttachmentBuilder(formerMainAvatarBuffer, {
        name: avatarFilename,
      });
      successEmbed.setImage(`attachment://${avatarFilename}`);
    } else if (formerMainAvatarDisplayUrl) {
      successEmbed.setImage(formerMainAvatarDisplayUrl);
    }

    // Add footer warning to keep embed (used for avatar URL storage)
    const embedWarning = localizer(locale, "commands.persona.swap.avatar_embed_warning");
    const storedNotice = avatarSwapSuccess ? localizer(locale, "commands.persona.swap.avatar_stored_notice") : "";
    const footerText = storedNotice ? `${embedWarning} ${storedNotice}` : embedWarning;

    successEmbed.setFooter({ text: footerText });

    const reply = await modalSubmitInteraction.followUp({
      embeds: [successEmbed],
      files: formerMainAvatarAttachment ? [formerMainAvatarAttachment] : undefined,
      flags: MessageFlags.SuppressNotifications,
    });

    if (formerMainAvatarReference) {
      try {
        const sentEmbed = reply.embeds[0];
        const s3StoredUrl =
          formerMainAvatarBuffer && mainPersona.persona_id
            ? await uploadPersonaAvatarToStorage({
                personaId: mainPersona.persona_id,
                serverDiscId: interaction.guild.id,
                label: "former main swap",
                buffer: formerMainAvatarBuffer,
              })
            : null;
        newFormerMainS3Url = s3StoredUrl;
        const storedAvatarUrl = s3StoredUrl ?? sentEmbed?.image?.url ?? previousMainAvatarUrl ?? null;
        newFormerMainAvatarUrl = storedAvatarUrl;

        if (storedAvatarUrl) {
          // biome-ignore lint/style/noNonNullAssertion: guaranteed by prior checks
          await personaRepository.setAvatar(mainPersona.persona_id!, storedAvatarUrl);

          log.success(`Stored former main persona "${mainPersona.persona_nickname}" avatar URL for future use`);
        } else {
          log.warn(`Failed to extract image URL from success embed for former main persona ${mainPersona.persona_id}`);
        }
      } catch (storageError) {
        // Non-fatal error - persona swap was successful, avatar storage failed
        log.warn(
          `Failed to store former main persona avatar (non-fatal): ${storageError instanceof Error ? storageError.message : "Unknown error"}`,
        );
      }
    }

    if (selectedAlterAvatarBuffer && selectedAlter.persona_id) {
      const selectedAlterS3Url = await uploadPersonaAvatarToStorage({
        personaId: selectedAlter.persona_id,
        serverDiscId: interaction.guild.id,
        label: "selected alter swap",
        buffer: selectedAlterAvatarBuffer,
      });

      if (selectedAlterS3Url) {
        await personaRepository.setAvatar(selectedAlter.persona_id, selectedAlterS3Url);
        if (previousSelectedAlterAvatarUrl && previousSelectedAlterAvatarUrl !== selectedAlterS3Url) {
          await deletePersonaAvatarFromStorage(previousSelectedAlterAvatarUrl);
        }
      }
    }

    if (
      previousMainAvatarUrl &&
      newFormerMainAvatarUrl &&
      newFormerMainS3Url &&
      previousMainAvatarUrl !== newFormerMainAvatarUrl
    ) {
      await deletePersonaAvatarFromStorage(previousMainAvatarUrl);
    }

    log.success(
      `Successfully swapped personas: "${selectedAlter.persona_nickname}" is now main, "${mainPersona.persona_nickname}" is now alter for guild ${interaction.guild.id}`,
    );
  } catch (error) {
    log.error("Error executing persona swap command:", error, {
      errorType: "CommandExecutionError",
      metadata: { commandName: "persona swap" },
    });

    if (!interaction.replied && !interaction.deferred) {
      await replyInfoEmbed(
        interaction,
        locale,
        {
          titleKey: "general.errors.unknown_error_title",
          descriptionKey: "general.errors.unknown_error_description",
          color: ColorCode.ERROR,
        },
        MessageFlags.SuppressNotifications,
      );
    } else {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "general.errors.unknown_error_title"))
            .setDescription(localizer(locale, "general.errors.unknown_error_description"))
            .setColor(ColorCode.ERROR),
        ],
      });
    }
  }
}
