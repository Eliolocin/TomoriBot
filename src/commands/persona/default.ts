import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { configRepository, personaRepository, personaSpriteRepository } from "@/utils/db/repositories";
import { invalidatePersonaSpriteCache } from "@/utils/cache/personaSpriteCache";
import { getCachedTomoriState, invalidateTomoriStateCache } from "../../utils/cache/tomoriStateCache";
import { localizer, getBaseTriggerWords, getDefaultBotName } from "../../utils/text/localizer";
import { log, ColorCode } from "../../utils/misc/logger";
import { replyInfoEmbed, promptWithRawModal, safeSelectOptionText } from "../../utils/discord/interactionHelper";
import { type UserRow, type ErrorContext, tomoriSchema, type TomoriPresetRow } from "../../types/db/schema";
import type { SelectOption } from "../../types/discord/modal";
import { sanitizeAttachmentFilenamePart } from "@/utils/discord/attachmentFilename";
import { getCachedPresetAvatar, getPresetAvatarBuffer } from "../../utils/image/avatarHelper";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { deletePersonaAvatarFromStorage, deletePersonaSpriteFromStorage } from "../../utils/storage/avatarStorage";
import { dedupeTriggerWords, normalizeTriggerWord, selectUnclaimedTriggerWords } from "@/utils/text/triggerWords";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505"
  );
}

const MODAL_CUSTOM_ID = "preset_default_modal";
const PRESET_SELECT_ID = "preset_select";
export const PRESET_LINEAGE_BY_AVATAR: Record<string, number> = {
  "default.png": 4, // Default / Boyish
  "bratty.png": 716,
  "gloomy.png": 1770,
  "shy.png": 3585,
  "blind.png": 50, // Nerine (Discontinued Model)
};

type PersonaDefaultTargetType = "default" | "alter";

function normalizeForComparison(value: string): string {
  return normalizeTriggerWord(value);
}

function dedupeCaseInsensitive(values: string[]): string[] {
  return dedupeTriggerWords(values, { lowercase: false });
}

export function resolvePresetTriggerWords(preset: TomoriPresetRow, locale: string): string[] {
  const presetTriggerWords = dedupeCaseInsensitive(preset.preset_trigger_words ?? []);
  if (presetTriggerWords.length > 0) {
    return presetTriggerWords;
  }

  return dedupeCaseInsensitive(getBaseTriggerWords(locale));
}

function capitalizeTriggerFallbackName(candidate: string): string {
  const trimmed = candidate.trim();
  if (!/^[a-z][a-z0-9.'_\- ]*$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1).toLowerCase()}`;
}

export function resolveAvailablePersonaName(
  defaultName: string,
  triggerWords: string[],
  takenNames: string[],
): string | null {
  const taken = new Set(takenNames.map((name) => normalizeForComparison(name)));
  const candidates = [defaultName, ...triggerWords];

  for (const [index, candidate] of candidates.entries()) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const resolvedCandidate = index === 0 ? trimmed : capitalizeTriggerFallbackName(trimmed);
    if (!taken.has(normalizeForComparison(resolvedCandidate))) {
      return resolvedCandidate;
    }
  }

  return null;
}

function normalizePresetLineageId(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

export function resolvePresetLineageId(preset: TomoriPresetRow): number | null {
  const explicitLineageId = normalizePresetLineageId(preset.preset_lineage_id);
  if (explicitLineageId !== null) {
    return explicitLineageId;
  }

  const avatarPath = (preset.preset_avatar_path ?? "").trim().toLowerCase();
  if (avatarPath.length > 0) {
    const fileName = avatarPath.split(/[\\/]/).pop() ?? "";
    if (fileName in PRESET_LINEAGE_BY_AVATAR) {
      return PRESET_LINEAGE_BY_AVATAR[fileName];
    }
  }

  // Locale-safe fallback for environments where avatar paths were customized.
  const normalizedName = preset.persona_preset_name.toLowerCase();
  if (normalizedName.includes("bratty")) return 716;
  if (normalizedName.includes("gloomy")) return 1770;
  if (normalizedName.includes("shy")) return 3585;
  if (normalizedName.includes("professional")) return 50;
  if (normalizedName.includes("default") || normalizedName.includes("boyish")) return 4;
  return null;
}

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("default")
    .setDescription(localizer("en-US", "commands.persona.default.description"))
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription(localizer("en-US", "commands.persona.default.type_description"))
        .setRequired(true)
        .addChoices(
          {
            name: localizer("en-US", "commands.persona.default.type_choice_default"),
            value: "default",
          },
          {
            name: localizer("en-US", "commands.persona.default.type_choice_alter"),
            value: "alter",
          },
        ),
    );

/**
 * Applies a preset personality configuration to Tomori.
 * - type=default: updates the main persona.
 * - type=alter: creates an alter persona from the selected preset.
 *
 * Preset trigger words come from persona_presets.preset_trigger_words,
 * with locale base-trigger fallback for backward compatibility.
 * Persona naming prefers the locale default bot name, then falls back to
 * preset trigger words in order if the preferred name is already taken.
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  if (!interaction.channel) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.channel_only_title",
      descriptionKey: "general.errors.channel_only_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const targetType = interaction.options.getString("type", true) as PersonaDefaultTargetType;

  if (targetType === "alter" && !interaction.guild) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "commands.persona.import.alter_dm_not_allowed_title",
      descriptionKey: "commands.persona.import.alter_dm_not_allowed_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check permissions (ManageGuild required in guilds)
  if (interaction.guild) {
    const hasPermission = interaction.memberPermissions?.has("ManageGuild") ?? false;

    if (!hasPermission) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.persona.default.no_permission_title",
        descriptionKey: "commands.persona.default.no_permission_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  try {
    const serverDiscId = interaction.guild?.id ?? interaction.user.id;
    const tomoriState = await getCachedTomoriState(serverDiscId);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const presets = await configRepository.loadPresetRowsByLocale(locale);

    if (!presets || presets.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.persona.default.no_presets_title",
        descriptionKey: "commands.persona.default.no_presets_description",
        color: ColorCode.WARN,
      });
      return;
    }

    const presetSelectOptions: SelectOption[] = presets.map((preset: TomoriPresetRow) => ({
      label: safeSelectOptionText(preset.persona_preset_name),
      value: safeSelectOptionText(preset.persona_preset_name),
      description: safeSelectOptionText(preset.persona_preset_desc),
    }));

    const modalResult = await promptWithRawModal(
      interaction,
      locale,
      {
        modalCustomId: MODAL_CUSTOM_ID,
        modalTitleKey: "commands.persona.default.modal_title",
        components: [
          {
            customId: PRESET_SELECT_ID,
            labelKey: "commands.persona.default.select_label",
            descriptionKey: "commands.persona.default.select_description",
            placeholder: "commands.persona.default.select_placeholder",
            required: true,
            options: presetSelectOptions,
          },
        ],
      },
      MessageFlags.Ephemeral,
    );

    if (modalResult.outcome !== "submit") {
      log.info(`Preset selection modal ${modalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    // biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
    const modalSubmitInteraction = modalResult.interaction!;
    // biome-ignore lint/style/noNonNullAssertion: Modal submission outcome "submit" guarantees these values exist
    const selectedPresetName = modalResult.values![PRESET_SELECT_ID];

    // Find the selected preset - let helper functions manage interaction state
    const selectedPreset = presets.find((preset: TomoriPresetRow) => preset.persona_preset_name === selectedPresetName);

    if (!selectedPreset) {
      await modalSubmitInteraction.editReply({
        content: localizer(locale, "commands.persona.default.preset_not_found"),
      });
      return;
    }

    const presetPersonaPrompt = selectedPreset.persona_preset_desc || null;

    const presetTriggerWords = resolvePresetTriggerWords(selectedPreset, locale);
    const defaultBotName = getDefaultBotName(locale);
    const resolvedLineageId = resolvePresetLineageId(selectedPreset);
    const shouldUseResolvedLineageId = resolvedLineageId !== null;

    const allPersonas = await personaRepository.loadAllForServer(serverDiscId);
    const allPersonaNames = allPersonas.map((persona) => persona.persona_nickname);
    const mainPersona = allPersonas.find((persona) => !persona.is_alter) ?? tomoriState;

    if (targetType === "default") {
      const targetPersonaId = mainPersona.persona_id ?? tomoriState.persona_id;
      if (!targetPersonaId) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.update_failed_title",
          descriptionKey: "general.errors.update_failed_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      const takenNamesExcludingTarget = allPersonas
        .filter((persona) => persona.persona_id !== targetPersonaId)
        .map((persona) => persona.persona_nickname);
      const resolvedPersonaName = resolveAvailablePersonaName(
        defaultBotName,
        presetTriggerWords,
        takenNamesExcludingTarget,
      );

      if (!resolvedPersonaName) {
        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "commands.persona.name_conflict_title",
          descriptionKey: "commands.persona.name_conflict_description",
          descriptionVars: { name: defaultBotName },
          color: ColorCode.ERROR,
        });
        return;
      }

      // Capture the persona's current sprite images BEFORE re-pointing, so we
      //      can clean up server-owned ones afterward (resetting to the preset set).
      //      For a still-pointer persona these are shared preset URLs (the delete
      //      guard skips them); for a materialized persona they are its own rows.
      const spritesBeforeReset = await personaSpriteRepository.listForPersona(targetPersonaId);

      // applyPresetPointerToPersona clears webhook_avatar_url, so retain the current
      // server-owned image for deletion afterward. The guard skips shared presets/ images.
      const previousMainAvatarUrl = mainPersona.webhook_avatar_url ?? null;

      // Turn the main persona into a live preset pointer (this also drops the
      //      persona's own sprite rows, so it resolves preset sprites live again).
      const updatedTomoriResult = await personaRepository.applyPresetPointerToPersona({
        personaId: targetPersonaId,
        nickname: resolvedPersonaName,
        preset: selectedPreset,
        personaLineageId: shouldUseResolvedLineageId ? resolvedLineageId : undefined,
        triggerWords: presetTriggerWords,
        personaPrompt: presetPersonaPrompt,
      });

      if (!updatedTomoriResult) {
        const context: ErrorContext = {
          userId: userData.user_id,
          serverId: tomoriState.server_id,
          personaId: targetPersonaId,
          errorType: "DatabaseValidationError",
          metadata: {
            command: "persona default",
            targetType,
            preset: selectedPreset.persona_preset_name,
            presetId: selectedPreset.persona_preset_id,
          },
        };
        await log.error(
          "Failed to update tomori after applying preset",
          new Error("PersonaRepository.applyPresetPointerToPersona returned null"),
          context,
        );

        await replyInfoEmbed(modalSubmitInteraction, locale, {
          titleKey: "general.errors.update_failed_title",
          descriptionKey: "general.errors.update_failed_description",
          color: ColorCode.ERROR,
        });
        return;
      }

      invalidateTomoriStateCache(serverDiscId);

      // Finish the sprite reset: delete server-owned sprite images now that
      //      the rows are gone (the guard skips shared preset images), and drop the
      //      stale sprite cache so the next read resolves the new preset's sprites.
      await Promise.all(spritesBeforeReset.map((sprite) => deletePersonaSpriteFromStorage(sprite.avatar_url)));
      invalidatePersonaSpriteCache(targetPersonaId);

      // The old server-owned main avatar is unreferenced after the repoint clears
      // webhook_avatar_url. The guard skips shared presets/.
      if (previousMainAvatarUrl) {
        await deletePersonaAvatarFromStorage(previousMainAvatarUrl);
      }

      const isDM = !interaction.guild;
      let avatarUpdateFailed = false;
      let nicknameUpdateFailed = false;
      let presetAvatarBuffer: Buffer | null = null;

      if (!isDM) {
        try {
          if (interaction.guild?.members.me) {
            const nicknameToSet = resolvedPersonaName === defaultBotName ? null : resolvedPersonaName;
            try {
              await interaction.guild.members.me.setNickname(nicknameToSet);
              log.info(
                `Updated guild nickname for ${interaction.guild.id} after applying preset (default target)` +
                  ` to ${nicknameToSet ?? "(global default)"}`,
              );
            } catch (error) {
              nicknameUpdateFailed = true;
              log.warn(`Failed to update guild nickname after applying preset (non-fatal): ${error}`);
            }
          }

          if (interaction.guild) {
            const cachedAvatar = getCachedPresetAvatar(selectedPreset.persona_preset_id);
            if (!cachedAvatar) {
              presetAvatarBuffer = await getPresetAvatarBuffer(selectedPreset);
            }

            const avatarValue =
              cachedAvatar ??
              (presetAvatarBuffer ? `data:image/png;base64,${presetAvatarBuffer.toString("base64")}` : null);
            const endpoint = `https://discord.com/api/v10/guilds/${interaction.guild.id}/members/@me`;
            const response = await fetch(endpoint, {
              method: "PATCH",
              headers: {
                Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ avatar: avatarValue }),
            });

            if (response.ok) {
              const actionDescription = avatarValue
                ? `Set preset avatar for "${selectedPreset.persona_preset_name}"`
                : "Reset guild avatar to bot default";
              log.info(`${actionDescription} for guild ${interaction.guild.id} after applying preset`);
              // Stamp the applied avatar hash so the background fan-out reconciler
              // skips this server until the catalog art changes again (avoids a
              // redundant guild-avatar re-PATCH on the next boot).
              await personaRepository.markServerMainAvatarSynced(interaction.guild.id);
            } else {
              avatarUpdateFailed = true;
              log.warn(`Failed to update guild avatar: ${response.status} ${response.statusText}`);
            }
          }
        } catch (avatarError) {
          avatarUpdateFailed = true;
          log.warn(`Failed to update avatar or nickname after applying preset: ${avatarError}`);
        }
      }

      const triggerSummary = presetTriggerWords.length > 0 ? presetTriggerWords.join(", ") : "N/A";
      const detailedSuccessDescription = localizer(locale, "commands.persona.default.success_details_description", {
        preset_name: selectedPreset.persona_preset_name,
        nickname: resolvedPersonaName,
        attribute_count: selectedPreset.preset_attribute_list.length,
        dialogue_count: selectedPreset.preset_sample_dialogues_in.length,
        trigger_word_count: presetTriggerWords.length,
        triggers: triggerSummary,
      });

      const descriptionLines = [detailedSuccessDescription];
      if (nicknameUpdateFailed) {
        descriptionLines.push(localizer(locale, "commands.persona.import.nickname_update_failed"));
      }
      if (avatarUpdateFailed) {
        descriptionLines.push(localizer(locale, "commands.persona.import.avatar_update_failed"));
      }

      const successEmbed = new EmbedBuilder()
        .setTitle(localizer(locale, "commands.persona.default.success_title"))
        .setDescription(descriptionLines.join("\n\n"))
        .setColor(isDM || avatarUpdateFailed || nicknameUpdateFailed ? ColorCode.WARN : ColorCode.SUCCESS);

      const footerParts: string[] = [];
      if (isDM) {
        footerParts.push(localizer(locale, "commands.persona.default.avatar_update_skipped_dm"));
      } else if (avatarUpdateFailed) {
        footerParts.push(localizer(locale, "commands.persona.default.avatar_update_failed"));
      }
      footerParts.push(localizer(locale, "commands.persona.import.refresh_reminder"));
      successEmbed.setFooter({ text: footerParts.join(" • ") });

      presetAvatarBuffer = presetAvatarBuffer ?? (await getPresetAvatarBuffer(selectedPreset));
      let avatarAttachment: AttachmentBuilder | null = null;
      if (presetAvatarBuffer) {
        const sanitizedNickname = sanitizeAttachmentFilenamePart(resolvedPersonaName, {
          fallback: "persona",
          maxLength: 50,
        });
        const timestamp = Date.now();
        const avatarFilename = `tomori-preset-${sanitizedNickname}-${timestamp}.png`;
        avatarAttachment = new AttachmentBuilder(presetAvatarBuffer, {
          name: avatarFilename,
        });
        successEmbed.setImage(`attachment://${avatarFilename}`);
      }

      if (!interaction.channel || !("send" in interaction.channel)) {
        log.error("No channel available for persona default success message");
        await modalSubmitInteraction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle(localizer(locale, "general.errors.unknown_error_title"))
              .setDescription(localizer(locale, "general.errors.unknown_error_description"))
              .setColor(ColorCode.ERROR),
          ],
        });
        return;
      }

      await interaction.channel.send({
        embeds: [successEmbed],
        files: avatarAttachment ? [avatarAttachment] : [],
      });

      log.success(
        `Applied preset "${selectedPreset.persona_preset_name}" to main persona for server ${tomoriState.server_id} by user ${userData.user_disc_id}`,
      );

      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.persona.default.success_title"))
            .setDescription(
              localizer(locale, "commands.persona.default.success_confirmation", {
                nickname: resolvedPersonaName,
              }),
            )
            .setColor(avatarUpdateFailed || nicknameUpdateFailed ? ColorCode.WARN : ColorCode.SUCCESS),
        ],
      });
      return;
    }

    const personaLimits = getMemoryLimits();
    if (allPersonas.length >= personaLimits.maxPersonasPerServer) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.persona.import.alter_limit_title",
        descriptionKey: "commands.persona.import.alter_limit_description",
        descriptionVars: {
          current: allPersonas.length,
          max: personaLimits.maxPersonasPerServer,
        },
        color: ColorCode.ERROR,
      });
      return;
    }

    const resolvedAlterName = resolveAvailablePersonaName(defaultBotName, presetTriggerWords, allPersonaNames);
    if (!resolvedAlterName) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "commands.persona.name_conflict_title",
        descriptionKey: "commands.persona.name_conflict_description",
        descriptionVars: { name: defaultBotName },
        color: ColorCode.ERROR,
      });
      return;
    }

    // Drop trigger words already owned by an existing persona (e.g. the shared
    // "tomori"/base words owned by the main persona) so this alter stays
    // unambiguous. Mirrors the live single-owner dedup the loader applies, where
    // a newly created alter is the lowest-priority claimant.
    const claimedTriggerWords = [
      ...getBaseTriggerWords(locale),
      ...allPersonas.flatMap((persona) => persona.trigger_words ?? []),
    ];
    const uniqueAlterTriggers = selectUnclaimedTriggerWords(presetTriggerWords, claimedTriggerWords, {
      lowercase: false,
    });
    const hasNoTriggers = uniqueAlterTriggers.length === 0;

    const insertedAlterRow = await personaRepository.createPresetPointerAlterPersona({
      serverId: tomoriState.server_id,
      nickname: resolvedAlterName,
      preset: selectedPreset,
      personaLineageId: shouldUseResolvedLineageId ? resolvedLineageId : null,
      triggerWords: uniqueAlterTriggers,
      personaPrompt: presetPersonaPrompt,
    });

    const insertedValidation = tomoriSchema.safeParse(insertedAlterRow);
    if (!insertedValidation.success) {
      const context: ErrorContext = {
        userId: userData.user_id,
        serverId: tomoriState.server_id,
        errorType: "DatabaseValidationError",
        metadata: {
          command: "persona default",
          targetType,
          preset: selectedPreset.persona_preset_name,
          presetId: selectedPreset.persona_preset_id,
          validationErrors: insertedValidation.error.flatten(),
        },
      };
      await log.error(
        "Failed to validate inserted alter persona after applying preset",
        new Error("Inserted alter row failed validation"),
        context,
      );

      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const newAlterId = insertedValidation.data.persona_id;
    if (!newAlterId) {
      await replyInfoEmbed(modalSubmitInteraction, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const descriptionParts = [
      localizer(locale, "commands.persona.import.alter_success_description", {
        nickname: resolvedAlterName,
        trigger_count: uniqueAlterTriggers.length,
        triggers: uniqueAlterTriggers.length > 0 ? uniqueAlterTriggers.join(", ") : "N/A",
      }),
    ];
    if (hasNoTriggers) {
      descriptionParts.push(`\n\n${localizer(locale, "commands.persona.import.alter_no_triggers_warning")}`);
    }

    const successEmbed = new EmbedBuilder()
      .setTitle(localizer(locale, "commands.persona.import.alter_success_title"))
      .setDescription(descriptionParts.join(""))
      .setColor(hasNoTriggers ? ColorCode.WARN : ColorCode.SUCCESS)
      .setFooter({
        text: localizer(locale, "commands.persona.import.alter_avatar_warning"),
      });

    const presetAvatarBuffer = await getPresetAvatarBuffer(selectedPreset);
    let avatarAttachment: AttachmentBuilder | null = null;
    if (presetAvatarBuffer) {
      const sanitizedNickname = sanitizeAttachmentFilenamePart(resolvedAlterName, {
        fallback: "persona",
        maxLength: 50,
      });
      const timestamp = Date.now();
      const avatarFilename = `tomori-preset-${sanitizedNickname}-${timestamp}.png`;
      avatarAttachment = new AttachmentBuilder(presetAvatarBuffer, {
        name: avatarFilename,
      });
      successEmbed.setImage(`attachment://${avatarFilename}`);
    }

    const successChannel = modalSubmitInteraction.channel ?? interaction.channel;
    if (!successChannel || !("send" in successChannel)) {
      log.error("No channel available for persona default alter success message");
      await modalSubmitInteraction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "general.errors.unknown_error_title"))
            .setDescription(localizer(locale, "general.errors.unknown_error_description"))
            .setColor(ColorCode.ERROR),
        ],
      });
      return;
    }

    await successChannel.send({
      embeds: [successEmbed],
      files: avatarAttachment ? [avatarAttachment] : [],
    });

    // No per-server avatar upload: a preset-pointer alter leaves webhook_avatar_url
    // NULL and live-resolves the shared preset avatar (preset_avatar_shared_url)
    // at state-load time. This both dedups storage (N servers share one image) and
    // makes catalog avatar edits fan out to this alter on the next reseed, exactly
    // like its sprites/triggers/prompt. The avatar is materialized by reference
    // only if the user later forks the persona with a content edit.

    // Match /persona import cache invalidation timing.
    invalidateTomoriStateCache(serverDiscId);

    log.success(
      `Applied preset "${selectedPreset.persona_preset_name}" to alter persona "${resolvedAlterName}" with ${uniqueAlterTriggers.length} unique triggers for server ${tomoriState.server_id} by user ${userData.user_disc_id}`,
    );

    await modalSubmitInteraction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(localizer(locale, "commands.persona.import.alter_success_title"))
          .setDescription(
            localizer(locale, "commands.persona.import.alter_success_confirmation", {
              nickname: resolvedAlterName,
              trigger_count: uniqueAlterTriggers.length,
            }),
          )
          .setColor(hasNoTriggers ? ColorCode.WARN : ColorCode.SUCCESS),
      ],
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.persona.name_conflict_title",
        descriptionKey: "commands.persona.name_conflict_description",
        descriptionVars: { name: getDefaultBotName(locale) },
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let serverIdForError: number | null = null;
    let personaIdForError: number | null = null;
    if (interaction.guild?.id) {
      const state = await getCachedTomoriState(interaction.guild.id);
      serverIdForError = state?.server_id ?? null;
      personaIdForError = state?.persona_id ?? null;
    }

    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: serverIdForError,
      personaId: personaIdForError,
      errorType: "CommandExecutionError",
      metadata: {
        command: "persona default",
        targetType,
        guildId: interaction.guild?.id ?? interaction.user.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error(`Error executing /persona default for user ${userData.user_disc_id}`, error as Error, context);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: localizer(locale, "general.errors.unknown_error_description"),
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
