/**
 * /expressions edit command
 *
 * Lets a server manager manually correct a single emoji or sticker's expression
 * data. The user provides the raw expression name (e.g. `:happycat:` for an emoji
 * or `Dog Dance` for a sticker). When the name matches a synced expression, a modal
 * opens with two required fields: the emotion it conveys and its usage instructions
 * : pre-filled with the current values. Submitting writes the new values back.
 */

import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags, TextInputStyle } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { ColorCode, log } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { promptWithRawModal } from "@/utils/discord/ui/modals";
import { getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { invalidateEmojiStickerCache } from "@/utils/cache/emojiStickerCache";
import { serverRepository } from "@/utils/db/repositories";
import { getManualEditEmotionKeys, isValidEmotionKey } from "@/types/misc/emotions";
import type { SelectOption } from "@/types/discord/modal";
import type { ErrorContext, ServerEmojiRow, ServerStickerRow, TomoriState, UserRow } from "@/types/db/schema";

// Modal + component custom IDs (the helper appends a per-open nonce internally)
const EDIT_MODAL_CUSTOM_ID = "server_expressions_edit_modal";
const EMOTION_INPUT_ID = "expression_emotion_input";
const INSTRUCTIONS_INPUT_ID = "expression_instructions_input";

// The usage-description length is configurable so operators can tune how much
//    guidance the model receives (no hardcoded operational limits).
const INSTRUCTIONS_MAX_LENGTH = Number.parseInt(process.env.EXPRESSION_DESC_MAX_LENGTH || "500", 10);

// The emotion picker is a string select. Discord caps selects at 25 options, so we
//    offer the curated 25-key subset (getManualEditEmotionKeys) rather than all 28.
//    Building it once at module load avoids recomputing per invocation.
const EMOTION_SELECT_OPTIONS: SelectOption[] = getManualEditEmotionKeys().map((key) => ({
  label: key.charAt(0).toUpperCase() + key.slice(1),
  value: key,
}));

/**
 * Discriminated result of resolving the user's input against synced expressions.
 * Keeps the matched table explicit so the write path targets the correct repository.
 */
type ExpressionMatch = { type: "emoji"; row: ServerEmojiRow } | { type: "sticker"; row: ServerStickerRow };

/**
 * Parse a Discord custom-emoji mention of the form `<:name:id>` or `<a:name:id>`.
 *
 * When a user types `:emojiname:` into a slash-command text option, Discord's client
 * silently auto-resolves it to this rendered mention before the value reaches the bot.
 * Plain `:name:` (no client-side match) and bare names arrive unchanged, so callers
 * still need their own colon-stripping fallback for those cases.
 *
 * @param input - Raw option value (already trimmed)
 * @returns The emoji's bare name and Discord snowflake ID, or null if not a mention
 */
function parseEmojiMention(input: string): { name: string; id: string } | null {
  // <a?:name:id>: the optional leading "a" marks an animated emoji.
  const mentionMatch = input.match(/^<a?:(\w+):(\d+)>$/);
  if (!mentionMatch) {
    return null;
  }
  return { name: mentionMatch[1], id: mentionMatch[2] };
}

/**
 * Configure the subcommand metadata and its single required "expression" option.
 *
 * @param subcommand - The subcommand builder provided by the command loader
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("edit")
    .setDescription(localizer("en-US", "commands.expressions.edit.description"))
    .addStringOption((option) =>
      option
        .setName("expression")
        .setDescription(localizer("en-US", "commands.expressions.edit.expression_description"))
        .setRequired(true),
    );

/**
 * Execute the /expressions edit command.
 *
 * @param locale - Resolved locale for all user-facing text
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  let tomoriState: TomoriState | null = null;

  try {
    if (!interaction.guild) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.guild_only_title",
        descriptionKey: "general.errors.guild_only_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Editing server-wide expression data requires the Manage Server permission.
    const hasManagePermission = interaction.memberPermissions?.has("ManageGuild") ?? false;
    if (!hasManagePermission) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.expressions.edit.no_permission_title",
        descriptionKey: "commands.expressions.edit.no_permission_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Resolve the configured server state (also confirms Tomori is set up here).
    tomoriState = await getCachedTomoriState(interaction.guild.id);
    if (!tomoriState) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Normalize the raw input into the forms we may need to match against:
    //    - `mention`: present when Discord auto-resolved a typed `:name:` into the
    //      rendered `<:name:id>` / `<a:name:id>` form (gives us an exact emoji ID).
    //    - `colonStripped`: bare emoji name with any surrounding colons removed.
    //    - `rawInput`: untouched, for stickers whose names contain spaces/punctuation.
    const rawInput = interaction.options.getString("expression", true).trim();
    const mention = parseEmojiMention(rawInput);
    const colonStripped = (mention?.name ?? rawInput).replace(/^:+|:+$/g, "");

    // Emoji and sticker update events keep these rows current, so a fast DB read
    // is sufficient and preserves the three-second modal acknowledgement window.
    const [emojis, stickers] = await Promise.all([
      serverRepository.loadEmojis(tomoriState.server_id),
      serverRepository.loadStickersByInternalId(tomoriState.server_id),
    ]);

    // Resolve the input to a single expression.
    //    - If Discord handed us an emoji mention, match by its exact Discord ID first
    //      (robust against renames), then fall back to the parsed name.
    //    - Otherwise match emojis by colon-stripped name, then stickers by raw name.
    //    A parsed mention is unambiguously an emoji, so we never check stickers for it.
    let match: ExpressionMatch | null = null;

    const emojiList = emojis ?? [];
    let emojiHit: ServerEmojiRow | undefined;
    if (mention) {
      emojiHit = emojiList.find((e) => e.emoji_disc_id === mention.id);
    }
    if (!emojiHit) {
      emojiHit = emojiList.find((e) => e.emoji_name.toLowerCase() === colonStripped.toLowerCase());
    }

    if (emojiHit) {
      match = { type: "emoji", row: emojiHit };
    } else if (!mention) {
      const stickerHit = stickers.find(
        (s) =>
          s.sticker_name.toLowerCase() === rawInput.toLowerCase() ||
          s.sticker_name.toLowerCase() === colonStripped.toLowerCase(),
      );
      if (stickerHit) {
        match = { type: "sticker", row: stickerHit };
      }
    }

    if (!match) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.expressions.edit.not_found_title",
        descriptionKey: "commands.expressions.edit.not_found_description",
        // Prefer the friendly emoji name over Discord's raw `<:name:id>` blob.
        descriptionVars: { expression: mention ? `:${mention.name}:` : rawInput },
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const displayName = match.type === "emoji" ? `:${match.row.emoji_name}:` : match.row.sticker_name;
    // Both row types expose emotion_key; only the description column name differs.
    const currentEmotion = match.row.emotion_key;
    const currentInstructions = match.type === "emoji" ? match.row.emoji_desc : match.row.sticker_desc;

    // Build the emotion picker's placeholder so it surfaces the current
    //    classification (the select can't pre-highlight a value, and the current key
    //    may be one of the 3 omitted from the 25-option list). Pre-localizing here means
    //    the string is used verbatim by the modal builder.
    const emotionPlaceholder = localizer(locale, "commands.expressions.edit.emotion_input_placeholder", {
      current: isValidEmotionKey(currentEmotion) ? currentEmotion : "unset",
    });

    // Open the edit modal directly on the slash interaction (this is the ack).
    //     The emotion select is OPTIONAL: leaving it untouched keeps the current key,
    //     which lets instructions-only edits preserve even the 3 omitted emotions.
    const modalResult = await promptWithRawModal(interaction, locale, {
      modalCustomId: EDIT_MODAL_CUSTOM_ID,
      modalTitleKey: "commands.expressions.edit.modal_title",
      components: [
        {
          customId: EMOTION_INPUT_ID,
          labelKey: "commands.expressions.edit.emotion_input_label",
          descriptionKey: "commands.expressions.edit.emotion_input_description",
          placeholder: emotionPlaceholder,
          required: false,
          options: EMOTION_SELECT_OPTIONS,
        },
        {
          customId: INSTRUCTIONS_INPUT_ID,
          labelKey: "commands.expressions.edit.instructions_input_label",
          descriptionKey: "commands.expressions.edit.instructions_input_description",
          placeholder: "commands.expressions.edit.instructions_input_placeholder",
          style: TextInputStyle.Paragraph,
          required: true,
          maxLength: INSTRUCTIONS_MAX_LENGTH,
          value: currentInstructions,
        },
      ],
    });

    if (modalResult.outcome !== "submit" || !modalResult.interaction) {
      log.info(`Server expression edit modal ${modalResult.outcome} for user ${userData.user_id}`);
      return;
    }

    const submitted = modalResult.interaction;
    const selectedEmotion = modalResult.values?.[EMOTION_INPUT_ID]?.trim() ?? "";
    const instructions = modalResult.values?.[INSTRUCTIONS_INPUT_ID]?.trim() ?? "";
    const emotionKey = selectedEmotion || currentEmotion;

    // The select only offers valid keys, so emotionKey can only be invalid when the
    //     expression was never classified ("unset") AND the user left the picker blank.
    //     In that case require an explicit choice.
    if (!isValidEmotionKey(emotionKey)) {
      await replyInfoEmbed(submitted, locale, {
        titleKey: "commands.expressions.edit.emotion_required_title",
        descriptionKey: "commands.expressions.edit.emotion_required_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    // Guard against whitespace-only instructions (Discord enforces "required" but
    //     allows whitespace, which we treat as empty).
    if (!instructions) {
      await replyInfoEmbed(submitted, locale, {
        titleKey: "commands.expressions.edit.empty_instructions_title",
        descriptionKey: "commands.expressions.edit.empty_instructions_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const updated =
      match.type === "emoji"
        ? await serverRepository.updateEmojiExpression(
            tomoriState.server_id,
            match.row.emoji_disc_id,
            emotionKey,
            instructions,
          )
        : await serverRepository.updateStickerExpression(
            tomoriState.server_id,
            match.row.sticker_disc_id,
            emotionKey,
            instructions,
          );

    if (!updated) {
      await replyInfoEmbed(submitted, locale, {
        titleKey: "general.errors.update_failed_title",
        descriptionKey: "general.errors.update_failed_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    // Invalidate the emoji/sticker cache only AFTER a confirmed write
    //     (never invalidate before the write succeeds).
    invalidateEmojiStickerCache(tomoriState.server_id);

    log.success(
      `Updated ${match.type} expression "${displayName}" in server ${tomoriState.server_id} by ${userData.user_disc_id}: emotion=${emotionKey}`,
    );

    await replyInfoEmbed(submitted, locale, {
      titleKey: "commands.expressions.edit.success_title",
      descriptionKey: "commands.expressions.edit.success_description",
      descriptionVars: {
        expression: displayName,
        emotion: emotionKey,
        instructions,
      },
      color: ColorCode.SUCCESS,
    });
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id,
      personaId: tomoriState?.persona_id,
      errorType: "CommandExecutionError",
      metadata: {
        command: "server expressions edit",
        guildId: interaction.guild?.id,
        executorDiscordId: interaction.user.id,
      },
    };
    await log.error("Error executing /expressions edit command", error as Error, context);

    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}
