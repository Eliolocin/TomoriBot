/**
 * /expressions initialize command
 *
 * Uses LLM vision with structured output to automatically analyze and classify
 * all custom emojis and stickers in a Discord server, generating emotion keys
 * and descriptions for use in bot responses.
 *
 * Requires model with both sees_images=true and supports_structoutput=true
 */

import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { personaRepository, serverRepository } from "@/utils/db/repositories";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import type { UserRow, ErrorContext } from "@/types/db/schema";
import { getAllEmotionKeys } from "@/types/misc/emotions";
import { type ExpressionBatchResult, ExpressionBatchResultSchema } from "@/providers/utils/structuredOutput";
import type { StructuredOutputResult } from "@/types/provider/featureInterfaces";
import { decryptApiKey } from "@/utils/security/crypto";
import { lazySyncGuildEmojis } from "@/utils/cache/emojiLazySync";
import { lazySyncGuildStickers } from "@/utils/cache/stickerLazySync";
import { callExpressionInitializationForProvider } from "@/providers/utils/providerFeatureExecutors";
import { providerSupportsFeature } from "@/utils/provider/providerInfoRegistry";
import { applyPersonalProviderSelectionsToTomoriState } from "@/utils/provider/personalProviderRuntime";
import { resolveStructuredOutputCapability } from "@/utils/provider/providerCapabilityResolver";
import { getEffectiveLlmModelName } from "@/utils/provider/modelDisplay";

/**
 * Configure the subcommand
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("initialize")
    .setDescription(localizer("en-US", "commands.expressions.initialize.description"))
    .addBooleanOption((option) =>
      option
        .setName("overwrite")
        .setDescription(localizer("en-US", "commands.expressions.initialize.overwrite_description"))
        .setRequired(false),
    );

/**
 * Convert ColorCode hex string to Discord number format
 * @param hexColor - Hex color string (e.g., "#3498DB")
 */
function hexToNumber(hexColor: string): number {
  return Number.parseInt(hexColor.replace("#", ""), 16);
}

/**
 * Build Discord CDN URL for an emoji
 * Always use .png format (including for animated emojis - gets first frame)
 *
 * @param emojiId - Discord emoji ID (snowflake)
 * @returns Discord CDN URL for the emoji as PNG
 */
function buildEmojiCDNUrl(emojiId: string): string {
  return `https://cdn.discordapp.com/emojis/${emojiId}.png`;
}

/**
 * Build Discord CDN URL for a sticker
 * Always use .png format
 *
 * @param stickerId - Discord sticker ID (snowflake)
 * @returns Discord CDN URL for the sticker as PNG
 */
function buildStickerCDNUrl(stickerId: string): string {
  return `https://cdn.discordapp.com/stickers/${stickerId}.png`;
}

function buildSystemPrompt(): string {
  return `You are an expert visual analyzer specializing in classifying emojis and stickers based on their emotional expression.

Your task is to analyze custom Discord emojis and stickers and classify each one into exactly one of these 28 emotion categories:

${getAllEmotionKeys().join(", ")}

Guidelines:
- Focus on the PRIMARY emotion conveyed by the visual design
- "neutral" is for emotionally ambiguous or abstract designs
- Descriptions should be ONE concise sentence (10-200 characters) describing what you see
- Match emoji/sticker names case-insensitively`;
}

function buildUserPrompt(items: Array<{ name: string; type: "emoji" | "sticker" }>): string {
  const itemList = items.map((item, idx) => `${idx + 1}. ${item.name} (${item.type})`).join("\n");

  return `Analyze the following ${items.length} Discord expressions and classify each one:

${itemList}

For each expression, determine:
1. The primary emotion category (from the 28 emotion list)
2. A concise visual description (one sentence)

Return results in the specified JSON format.`;
}

/**
 * Execute the /expressions initialize command
 *
 */
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
      color: hexToNumber(ColorCode.ERROR),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.permission_denied_title",
      descriptionKey: "general.errors.permission_denied_description",
      color: hexToNumber(ColorCode.ERROR),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const baseTomoriState = await personaRepository.loadState(interaction.guild.id);
  if (!baseTomoriState) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.tomori_not_setup_title",
      descriptionKey: "general.errors.tomori_not_setup_description",
      color: hexToNumber(ColorCode.ERROR),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer reply early (this operation may take time)
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Overlay the invoking user's personal (BYOK) provider so the expression
  //     generation runs on their personal model/key when configured. Done after
  //     deferReply since it performs DB reads (keeps the 3s ack window safe).
  const { tomoriState } = await applyPersonalProviderSelectionsToTomoriState(baseTomoriState, userData.user_id ?? null);

  const overwrite = interaction.options.getBoolean("overwrite") ?? false;

  try {
    // Force sync emojis and stickers from Discord to ensure DB is populated
    // This handles scenarios where:
    // - Bot was just added to server (empty DB)
    // - Bot was kicked and re-added with new emojis/stickers
    // - Existing servers before expression refresh feature was implemented
    log.info(`[Initialize Expressions] Force syncing emojis/stickers for guild ${interaction.guild.name}`);

    await lazySyncGuildEmojis(interaction.guild, tomoriState.server_id, true);
    await lazySyncGuildStickers(interaction.guild, tomoriState.server_id, true);

    log.info(`[Initialize Expressions] Sync complete for guild ${interaction.guild.name}`);

    // Resolve effective LLM for expression initialization
    // Primary model is preferred; vision model used as fallback when primary lacks vision
    const llm = tomoriState.llm;
    let effectiveLlm = llm;

    if (!llm.sees_images || !llm.supports_structoutput) {
      const visionLlm = tomoriState.vision_llm;

      if (visionLlm?.sees_images && visionLlm.supports_structoutput) {
        log.info(
          `[Initialize Expressions] Primary model lacks capabilities (sees_images=${llm.sees_images}, supports_structoutput=${llm.supports_structoutput}), falling back to vision model ${visionLlm.llm_codename}`,
        );
        effectiveLlm = visionLlm;
      } else {
        const effectiveModelName = getEffectiveLlmModelName(llm, tomoriState.config.custom_model_name);

        if (!visionLlm) {
          const missingCapability = !llm.sees_images ? "IMAGE VISION" : "STRUCTURED OUTPUT";
          await interaction.editReply({
            embeds: [
              {
                title: localizer(locale, "commands.expressions.initialize.model_incompatible_title"),
                description: localizer(locale, "commands.expressions.initialize.model_incompatible_description", {
                  model_name: effectiveModelName,
                  missing_capability: missingCapability,
                }),
                color: hexToNumber(ColorCode.ERROR),
              },
            ],
          });
        } else {
          await interaction.editReply({
            embeds: [
              {
                title: localizer(locale, "commands.expressions.initialize.vision_fallback_title"),
                description: localizer(locale, "commands.expressions.initialize.vision_fallback_description", {
                  chat_model: effectiveModelName,
                  vision_model: visionLlm.llm_codename,
                }),
                color: hexToNumber(ColorCode.ERROR),
              },
            ],
          });
        }
        return;
      }
    }

    const effectiveModelName = getEffectiveLlmModelName(effectiveLlm, tomoriState.config.custom_model_name);

    if (!providerSupportsFeature(effectiveLlm.llm_provider, "expressionInitialization")) {
      await interaction.editReply({
        embeds: [
          {
            title: localizer(locale, "general.errors.provider_not_supported_title"),
            description: localizer(locale, "general.errors.provider_not_supported_description"),
            color: hexToNumber(ColorCode.ERROR),
          },
        ],
      });
      return;
    }

    // Handle overwrite before querying for uninitialized
    if (overwrite) {
      log.info(`[Initialize Expressions] Overwriting existing expressions for guild ${interaction.guild.name}`);
      await Promise.all([
        serverRepository.clearEmojiExpressions(tomoriState.server_id),
        serverRepository.clearStickerExpressions(tomoriState.server_id),
      ]);
    }

    // Resolve the provider and its per-batch image cap once. These are constant
    //    across every loop iteration, so there is no need to recompute them per batch.
    const provider = effectiveLlm.llm_provider.toLowerCase();
    const structuredOutputCapability = await resolveStructuredOutputCapability(provider);
    const expressionBatchSize = structuredOutputCapability?.getExpressionInitializationBatchSize?.() ?? null;

    // Verify an API key exists, then decrypt it once for reuse across all batches
    if (!tomoriState.config.api_key) {
      await interaction.editReply({
        embeds: [
          {
            title: localizer(locale, "general.errors.api_key_missing_title"),
            description: localizer(locale, "general.errors.api_key_missing_description"),
            color: hexToNumber(ColorCode.ERROR),
          },
        ],
      });
      return;
    }

    const keyVersion = tomoriState.config.key_version || 1;
    const decryptedApiKey = await decryptApiKey(tomoriState.config.api_key, keyVersion);

    // Snapshot the starting backlog so the final report can compare against it
    const [initialEmojis, initialStickers] = await Promise.all([
      serverRepository.loadUninitializedEmojis(tomoriState.server_id),
      serverRepository.loadUninitializedStickers(tomoriState.server_id),
    ]);
    const grandTotalUninitialized = initialEmojis.length + initialStickers.length;

    if (grandTotalUninitialized === 0) {
      await interaction.editReply({
        embeds: [
          {
            title: localizer(locale, "commands.expressions.initialize.already_initialized_title"),
            description: localizer(locale, "commands.expressions.initialize.already_initialized_description"),
            color: hexToNumber(ColorCode.INFO),
          },
        ],
      });
      return;
    }

    // Self-looping batch processor.
    //    Previously the command processed a single provider-sized batch and asked
    //    the user to re-run for the rest. It now drains the entire backlog on its
    //    own, one batch per iteration.
    //
    //    Loop-safety guard: the backlog size is compared between iterations. When a
    //    batch makes no progress (the remaining count is unchanged), it is counted
    //    as a retry of the same "stuck" chunk. After `maxChunkRetries` consecutive
    //    no-progress iterations the loop aborts, so a model that consistently errors
    //    or fails to match items can never loop forever.
    const maxChunkRetries = Number.parseInt(process.env.EXPRESSION_INIT_MAX_CHUNK_RETRIES || "3", 10);
    const batchDelayMs = Number.parseInt(process.env.EXPRESSION_INIT_BATCH_DELAY_MS || "1000", 10);

    const systemPrompt = buildSystemPrompt();
    const temperature = 1.0;

    let totalEmojiProcessed = 0;
    let totalStickerProcessed = 0;
    let batchNumber = 0;
    let chunkRetries = 0; // consecutive no-progress iterations on the current chunk
    let previousRemaining = -1; // backlog size observed at the start of the previous iteration

    while (true) {
      // Re-query the backlog each iteration so prior batches' DB writes shrink it
      const [pendingEmojis, pendingStickers] = await Promise.all([
        serverRepository.loadUninitializedEmojis(tomoriState.server_id),
        serverRepository.loadUninitializedStickers(tomoriState.server_id),
      ]);
      const remaining = pendingEmojis.length + pendingStickers.length;

      if (remaining === 0) {
        break;
      }

      // Loop-safety: detect a chunk that is not shrinking and cap its retries
      if (remaining === previousRemaining) {
        chunkRetries++;
        log.warn(
          `[Initialize Expressions] No progress on chunk (${remaining} remaining), retry ${chunkRetries}/${maxChunkRetries}`,
        );
        if (chunkRetries >= maxChunkRetries) {
          log.warn(
            `[Initialize Expressions] Aborting after ${maxChunkRetries} consecutive no-progress attempts; ${remaining} expressions left unprocessed`,
          );
          break;
        }
      } else {
        chunkRetries = 0;
      }
      previousRemaining = remaining;
      batchNumber++;

      const images: Array<{ url: string; name: string }> = [];
      const items: Array<{ name: string; type: "emoji" | "sticker" }> = [];

      for (const emoji of pendingEmojis) {
        images.push({
          url: buildEmojiCDNUrl(emoji.emoji_disc_id),
          name: emoji.emoji_name,
        });
        items.push({ name: emoji.emoji_name, type: "emoji" });
      }

      for (const sticker of pendingStickers) {
        images.push({
          url: buildStickerCDNUrl(sticker.sticker_disc_id),
          name: sticker.sticker_name,
        });
        items.push({ name: sticker.sticker_name, type: "sticker" });
      }

      // Apply provider batch size limit (different token/cost constraints per provider)
      if (expressionBatchSize && images.length > expressionBatchSize) {
        images.splice(expressionBatchSize);
        items.splice(expressionBatchSize);
        log.info(
          `[Initialize Expressions] Batch ${batchNumber}: limited to ${expressionBatchSize} of ${remaining} remaining items for ${provider} provider`,
        );
      }

      await interaction.editReply({
        embeds: [
          {
            description: localizer(locale, "commands.expressions.initialize.progress_analyzing_batch", {
              batch_number: batchNumber,
              batch_size: images.length,
              remaining,
              processed: totalEmojiProcessed + totalStickerProcessed,
              grand_total: grandTotalUninitialized,
            }),
            color: hexToNumber(ColorCode.INFO),
          },
        ],
      });

      const userPrompt = buildUserPrompt(items);

      log.info(
        `LLM structured output request (batch ${batchNumber}): ${JSON.stringify(
          {
            model: effectiveModelName,
            temperature,
            systemPrompt,
            userPrompt,
            images,
          },
          null,
          2,
        )}`,
      );

      const result: StructuredOutputResult<ExpressionBatchResult> = await callExpressionInitializationForProvider({
        providerName: provider,
        apiKey: decryptedApiKey,
        model: effectiveModelName,
        endpointUrl: tomoriState.config.custom_endpoint_url ?? undefined,
        systemPrompt,
        userPrompt,
        images,
        temperature,
      });

      log.info(`LLM structured output response (batch ${batchNumber}): ${JSON.stringify(result, null, 2)}`);

      // On a provider error, log and let the loop retry this chunk (capped by maxChunkRetries)
      if (!result.success) {
        log.error("LLM structured output failed", new Error(result.error), {
          errorType: "LLMStructuredOutputError",
          metadata: {
            model: effectiveModelName,
            batchNumber,
            imageCount: images.length,
          },
        });
        continue;
      }

      const validationResult = ExpressionBatchResultSchema.safeParse(result.data);

      if (!validationResult.success) {
        log.error("LLM returned invalid structured output", validationResult.error, {
          errorType: "ValidationError",
          metadata: {
            model: effectiveLlm.llm_codename,
            batchNumber,
            rawData: result.data,
          },
        });
        continue;
      }

      const { emojiCount, stickerCount } = await serverRepository.initializeExpressions(
        tomoriState.server_id,
        validationResult.data.expressions,
      );
      totalEmojiProcessed += emojiCount;
      totalStickerProcessed += stickerCount;

      // Brief pause between batches to stay within provider rate limits, skipped
      //     when this batch drained the remaining backlog (no further iteration needed)
      if (batchDelayMs > 0 && remaining - (emojiCount + stickerCount) > 0) {
        await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
      }
    }

    const totalProcessed = totalEmojiProcessed + totalStickerProcessed;

    if (totalProcessed === 0) {
      await interaction.editReply({
        embeds: [
          {
            title: localizer(locale, "commands.expressions.initialize.no_matches_title"),
            description: localizer(locale, "commands.expressions.initialize.no_matches_description"),
            color: hexToNumber(ColorCode.WARN),
          },
        ],
      });
    } else if (totalProcessed < grandTotalUninitialized) {
      const failed = grandTotalUninitialized - totalProcessed;
      await interaction.editReply({
        embeds: [
          {
            title: localizer(locale, "commands.expressions.initialize.partial_success_title"),
            description: localizer(locale, "commands.expressions.initialize.partial_success_description", {
              successful: totalProcessed,
              total: grandTotalUninitialized,
              failed,
            }),
            color: hexToNumber(ColorCode.WARN),
          },
        ],
      });
    } else {
      await interaction.editReply({
        embeds: [
          {
            title: localizer(locale, "commands.expressions.initialize.success_title"),
            description: localizer(locale, "commands.expressions.initialize.success_description", {
              emoji_count: totalEmojiProcessed,
              sticker_count: totalStickerProcessed,
              total: totalProcessed,
            }),
            color: hexToNumber(ColorCode.SUCCESS),
          },
        ],
      });
    }
  } catch (error) {
    const context: ErrorContext = {
      userId: userData.user_id,
      serverId: tomoriState?.server_id ?? null,
      personaId: tomoriState?.persona_id ?? null,
      errorType: "CommandExecutionError",
      metadata: {
        command: "server expressions initialize",
        guildId: interaction.guild.id,
      },
    };

    await log.error("Error executing /expressions initialize command", error as Error, context);

    await interaction.editReply({
      embeds: [
        {
          title: localizer(locale, "general.errors.unknown_error_title"),
          description: localizer(locale, "general.errors.unknown_error_description"),
          color: hexToNumber(ColorCode.ERROR),
        },
      ],
    });
  }
}
