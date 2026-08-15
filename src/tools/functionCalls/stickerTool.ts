/**
 * Discord Sticker Selection Tool
 * Allows the AI to select appropriate stickers to accompany responses
 */

import { log } from "../../utils/misc/logger";
import { isStickerSendable } from "../../utils/discord/stickerAvailability";
import { BaseTool, type ToolContext, type ToolResult, type ToolParameterSchema } from "../../types/tool/interfaces";

/**
 * Tool for selecting Discord stickers based on conversational context
 */
export class StickerTool extends BaseTool {
  name = "select_sticker_for_response";
  description =
    "Selects a specific sticker from the available server stickers that is relevant to the current conversational context. Use this to choose a sticker that expresses an emotion or reaction aligning with the sticker's name or description. You will be informed of the selection result and will then generate the final text message for the user.";
  category = "discord" as const;
  requiresFeatureFlag = "sticker_usage";
  requiresPermissions = ["USE_EXTERNAL_STICKERS"];

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      sticker_name: {
        type: "string",
        description:
          "The sticker name to select (case-insensitive). Use the names from the provided list; do not include IDs.",
      },
      sticker_id: {
        type: "string",
        description: "Deprecated: The sticker ID. Use sticker_name instead (kept for compatibility).",
      },
    },
    required: ["sticker_name"],
  };

  /**
   * Normalize sticker names for strict matching:
   * - trims
   * - removes surrounding :name: wrappers
   * - collapses repeated whitespace
   * - lowercases for case-insensitive comparison
   */
  private static normalizeStickerNameForExact(input: string): string {
    return input
      .normalize("NFKC")
      .replace(/^:(.*):$/u, "$1")
      .trim()
      .replace(/\s+/gu, " ")
      .toLowerCase();
  }

  /**
   * Normalize sticker names for relaxed/fuzzy matching:
   * - preserves unicode letters/numbers (important for JP/CJK names)
   * - treats separators and quotes as non-significant
   */
  private static normalizeStickerNameForLoose(input: string): string {
    return StickerTool.normalizeStickerNameForExact(input)
      .replace(/[_-]+/gu, " ")
      .replace(/["'`“”‘’]+/gu, "")
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private static pickNewestSticker<T extends { createdTimestamp?: number | null; id: string }>(
    stickers: T[],
  ): T | null {
    if (stickers.length === 0) return null;
    return stickers.sort((a, b) => {
      const aTime = a.createdTimestamp ?? 0;
      const bTime = b.createdTimestamp ?? 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.id.localeCompare(b.id);
    })[0];
  }

  private static levenshteinDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const prev = new Array<number>(b.length + 1);
    const curr = new Array<number>(b.length + 1);

    for (let j = 0; j <= b.length; j++) prev[j] = j;

    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }

    return prev[b.length];
  }

  private static computeFuzzyScore(query: string, candidate: string): number {
    if (!query || !candidate) return 0;
    if (query === candidate) return 1;

    if (candidate.includes(query) || query.includes(candidate)) {
      const overlapRatio = Math.min(query.length, candidate.length) / Math.max(query.length, candidate.length);
      return 0.9 + overlapRatio * 0.08;
    }

    const distance = StickerTool.levenshteinDistance(query, candidate);
    const maxLen = Math.max(query.length, candidate.length);
    if (maxLen === 0) return 0;

    return 1 - distance / maxLen;
  }

  private static getFuzzyScoreThreshold(queryLength: number): number {
    if (queryLength <= 4) return 0.96;
    if (queryLength <= 7) return 0.88;
    if (queryLength <= 12) return 0.78;
    return 0.72;
  }

  /**
   * Check if sticker tool is available for the given provider.
   * Disabled for NovelAI, so GLM 4.6 can't reliably generate Japanese/CJK sticker
   * names as tool arguments due to token-level instability.
   * @returns True if provider supports sticker selection
   */
  isAvailableFor(provider: string): boolean {
    if (provider === "novelai") return false;
    return true;
  }

  /**
   * Check if sticker functionality is enabled in Tomori config
   * @returns True if sticker usage is enabled
   */
  protected isEnabled(context: ToolContext): boolean {
    return context.tomoriState.config.sticker_usage_enabled;
  }

  /**
   * Execute sticker selection - Real implementation from tomoriChat.ts
   * @param args - Arguments containing sticker_name (preferred) or sticker_id
   */
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const rawStickerName = args.sticker_name;
    const rawStickerId = args.sticker_id;
    const stickerName = typeof rawStickerName === "string" ? rawStickerName.trim() : "";
    const stickerId = typeof rawStickerId === "string" ? rawStickerId.trim() : "";
    const hasStickerName = stickerName.length > 0;
    const hasStickerId = stickerId.length > 0;

    if (!this.isEnabled(context)) {
      return {
        success: false,
        error: "Sticker usage is disabled for this server",
        message: "Sticker functionality is not enabled for this server.",
      };
    }

    if (!("guild" in context.channel)) {
      return {
        success: false,
        error: "Stickers not available in DMs",
        message: "Stickers are not available in Direct Messages.",
      };
    }

    // Empty args recovery: model ran out of tokens before generating sticker_name.
    // Return the available sticker list so the model can retry with a specific name
    // on its next generation pass (fresh token budget).
    if (!hasStickerName && !hasStickerId) {
      const guild = context.channel.guild;
      const availableStickerData = guild.stickers.cache
        .filter((sticker) => isStickerSendable(sticker))
        .map((sticker) => ({
          name: sticker.name,
          description: sticker.description || "No description available",
        }))
        .slice(0, 15);

      const stickerListText =
        availableStickerData.length > 0
          ? `Available stickers: ${availableStickerData.map((s) => `"${s.name}"`).join(", ")}. Call select_sticker_for_response again with one of these exact names as the sticker_name argument.`
          : "No stickers are available in this server.";

      log.warn(
        "Sticker tool called with empty args (likely token budget exhaustion). Returning sticker list for retry.",
      );

      return {
        success: false,
        error: "Missing sticker_name, please retry with a specific name",
        message: stickerListText,
        data: {
          status: "sticker_name_missing_retry",
          reason:
            "No sticker_name was provided. This usually happens when the model runs out of tokens before generating the argument. Please retry with one of the available sticker names.",
          availableStickers: availableStickerData,
        },
      };
    }

    const normalizedStickerName = hasStickerName ? StickerTool.normalizeStickerNameForExact(stickerName) : "";

    try {
      log.info(`Attempting to select sticker: ${normalizedStickerName || stickerId}`);

      const guild = context.channel.guild;
      let ambiguousMatches: Array<{
        id: string;
        name: string;
        description: string;
      }> = [];
      let fuzzySuggestions: Array<{
        id: string;
        name: string;
        description: string;
        score: number;
      }> = [];

      /**
       * Helper function to lookup sticker from cache
       * @returns Sticker if found, null otherwise
       */
      const lookupSticker = () => {
        ambiguousMatches = [];
        fuzzySuggestions = [];

        if (normalizedStickerName) {
          const stickers = guild.stickers.cache
            .filter((sticker) => isStickerSendable(sticker) && !!sticker.name?.trim())
            .map((sticker) => sticker);

          const exactMatches = stickers.filter(
            (sticker) => StickerTool.normalizeStickerNameForExact(sticker.name) === normalizedStickerName,
          );
          const exactMatch = StickerTool.pickNewestSticker(exactMatches);
          if (exactMatch) return exactMatch;

          const looseQuery = StickerTool.normalizeStickerNameForLoose(normalizedStickerName);
          if (!looseQuery) return null;

          const looseMatches = stickers.filter(
            (sticker) => StickerTool.normalizeStickerNameForLoose(sticker.name) === looseQuery,
          );
          const looseMatch = StickerTool.pickNewestSticker(looseMatches);
          if (looseMatch) return looseMatch;

          const scoredCandidates = stickers
            .map((sticker) => {
              const looseName = StickerTool.normalizeStickerNameForLoose(sticker.name);
              const score = StickerTool.computeFuzzyScore(looseQuery, looseName);
              return { sticker, score };
            })
            .filter((entry) => entry.score > 0)
            .sort((a, b) => {
              if (a.score !== b.score) return b.score - a.score;
              const aTime = a.sticker.createdTimestamp ?? 0;
              const bTime = b.sticker.createdTimestamp ?? 0;
              if (aTime !== bTime) return bTime - aTime;
              return a.sticker.id.localeCompare(b.sticker.id);
            });

          fuzzySuggestions = scoredCandidates.slice(0, 5).map((entry) => ({
            id: entry.sticker.id,
            name: entry.sticker.name,
            description: entry.sticker.description || "No description available",
            score: entry.score,
          }));

          const threshold = StickerTool.getFuzzyScoreThreshold(looseQuery.length);
          const best = scoredCandidates[0];
          if (!best || best.score < threshold) {
            return null;
          }

          const second = scoredCandidates[1];
          const isAmbiguous = !!second && second.score >= threshold && best.score - second.score < 0.08;

          if (isAmbiguous) {
            ambiguousMatches = scoredCandidates
              .filter((entry) => entry.score >= threshold)
              .slice(0, 3)
              .map((entry) => ({
                id: entry.sticker.id,
                name: entry.sticker.name,
                description: entry.sticker.description || "No description available",
              }));
            log.warn(
              `Sticker name '${normalizedStickerName}' is ambiguous. Top matches: ${ambiguousMatches.map((s) => s.name).join(", ")}`,
            );
            return null;
          }

          log.info(
            `Fuzzy matched sticker '${best.sticker.name}' for query '${normalizedStickerName}' (score=${best.score.toFixed(3)})`,
          );
          return best.sticker;
        } else {
          // Legacy path: select by sticker ID
          const byId = guild.stickers.cache.get(stickerId) ?? null;
          return byId && isStickerSendable(byId) ? byId : null;
        }
      };

      // First attempt: lookup in current cache
      let selectedSticker = lookupSticker();

      // If not found, fetch fresh from Discord API and retry (handles race conditions)
      if (!selectedSticker) {
        log.info(`Sticker '${normalizedStickerName || stickerId}' not in cache. Fetching fresh from Discord API...`);

        try {
          // Refresh cache from Discord API
          await guild.stickers.fetch();
          log.info("Sticker cache refreshed from Discord API");

          // Retry lookup with refreshed cache
          selectedSticker = lookupSticker();

          if (selectedSticker) {
            log.success(`Sticker '${selectedSticker.name}' (${selectedSticker.id}) found after cache refresh`);
          }
        } catch (fetchError) {
          log.warn(`Failed to refresh sticker cache from Discord API: ${(fetchError as Error).message}`);
        }
      } else {
        log.success(`Sticker '${selectedSticker.name}' (${selectedSticker.id}) found in local cache`);
      }

      // Success case - sticker found
      if (selectedSticker) {
        return {
          success: true,
          message: "Sticker selected successfully",
          data: {
            status: "sticker_selected_successfully",
            sticker_id: selectedSticker.id,
            sticker_name: selectedSticker.name,
            sticker_description: selectedSticker.description || "No description available",
            sticker: selectedSticker,
          },
        };
      }

      // Sticker not found even after refresh - inform LLM
      log.warn(
        `Sticker '${normalizedStickerName || stickerId}' not found even after cache refresh. Sticker does not exist.`,
      );

      // Get available stickers for error message, so include names inline so the model
      // can retry with an exact name on its next generation pass.
      const availableStickers = guild.stickers.cache;
      const availableStickerData = availableStickers
        .filter((sticker) => isStickerSendable(sticker))
        .map((sticker) => ({
          name: sticker.name,
          description: sticker.description || "No description available",
        }))
        .slice(0, 15);

      const stickerListHint =
        availableStickerData.length > 0
          ? ` Available stickers: ${availableStickerData.map((s) => `"${s.name}"`).join(", ")}. Call select_sticker_for_response again with one of these exact names, or do not use a sticker.`
          : "";

      if (ambiguousMatches.length > 1) {
        const ambiguousMessage = `Multiple stickers closely matched "${normalizedStickerName}". Please choose one exact sticker name.${stickerListHint}`;
        return {
          success: false,
          error: "Sticker name is ambiguous",
          message: ambiguousMessage,
          data: {
            status: "sticker_name_ambiguous",
            sticker_name_attempted: normalizedStickerName || undefined,
            reason: ambiguousMessage,
            possibleMatches: ambiguousMatches,
            availableStickers: availableStickerData,
          },
        };
      }

      const notFoundMessage = normalizedStickerName
        ? `Sticker "${normalizedStickerName}" was not found.${stickerListHint}`
        : `Sticker ID "${stickerId}" was not found.${stickerListHint}`;

      return {
        success: false,
        error: "Sticker not found",
        message: notFoundMessage,
        data: {
          status: "sticker_not_found",
          sticker_name_attempted: normalizedStickerName || undefined,
          sticker_id_attempted: !normalizedStickerName ? stickerId : undefined,
          reason: notFoundMessage,
          closeMatches: fuzzySuggestions
            .filter((match) => match.score >= 0.6)
            .slice(0, 3)
            .map((match) => ({
              id: match.id,
              name: match.name,
              description: match.description,
              score: Number(match.score.toFixed(3)),
            })),
          availableStickers: availableStickerData,
        },
      };
    } catch (error) {
      log.error(`Sticker selection failed for: ${normalizedStickerName || stickerId}`, error as Error);

      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred during sticker selection",
        message: "Failed to select the requested sticker. Please try with a different sticker.",
        data: {
          status: "sticker_selection_failed_error",
          reason: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  static getAvailableStickers(context: ToolContext): Array<{
    id: string;
    name: string;
    description: string;
  }> {
    try {
      if (!("guild" in context.channel)) {
        return [];
      }

      const guild = context.channel.guild;
      const availableStickers = guild.stickers.cache;

      return availableStickers
        .filter((sticker) => isStickerSendable(sticker))
        .map((sticker) => ({
          id: sticker.id,
          name: sticker.name,
          description: sticker.description || "No description available",
        }))
        .slice(0, 20); // Limit to prevent context bloat
    } catch (error) {
      log.warn(`Failed to get available stickers for context: ${(error as Error).message}`);
      return [];
    }
  }
}
