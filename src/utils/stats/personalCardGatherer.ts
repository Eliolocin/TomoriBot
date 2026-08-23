/**
 * personalCardGatherer.ts: data-gathering layer for the Personal "Wrapped"
 * infographic card.
 *
 * This is the ONLY file in the infographic stack that touches the DB.
 * `gatherPersonalCardData` calls the StatsRepository read methods and returns a
 * `PersonalCardData` struct that `renderPersonalCard` consumes as a pure function.
 *
 * Rules applied here (not in the renderer):
 * - AVATARS: user and favorite-persona references are resolved via
 *   `loadStoredPersonaAvatarDataUri` (handles both local dev paths and remote
 *   HTTP(S) URLs) and base64-encoded for the card's embedded `<img>` data URI.
 *   Fetch failure is graceful, so returns null so the renderer shows a placeholder.
 * - PALETTE: the first favorite persona avatar is sampled into an accessible,
 *   light-mode card palette. A neutral fallback keeps cards readable if it is
 *   unavailable or cannot be decoded.
 */
import { statRepository } from "@/utils/db/repositories";
import { getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import { log } from "@/utils/misc/logger";
import { loadStoredPersonaAvatarDataUri } from "@/utils/storage/avatarStorage";
import { type Timeframe, resolveWindowFrom } from "@/utils/stats/statsDashboard";
import { extractCardPalette, loadTomoriconDataUri } from "@/utils/stats/cardColor";
import { loadStatsPersonaAvatarDataUri, loadStatsPresetAvatarLookup } from "@/utils/stats/personaAvatar";
import type { PersonalCardData, PersonalFavoritePersona } from "@/utils/stats/statsInfographic";

/**
 * Samples the leading persona avatar into a high-contrast light-mode palette.
 *
 * @deprecated Backward-compatible alias for {@link extractCardPalette}; the
 * palette logic now lives in `cardColor.ts` and is shared with the Server card.
 */
export const extractPersonalCardPalette = extractCardPalette;

/** Arguments for `gatherPersonalCardData`. */
export interface GatherPersonalCardArgs {
  /** Internal `users` FK (not the Discord snowflake). */
  userId: number;
  /** Internal `servers` FK: passed for "this server" scope; omit for global. */
  serverId?: number;
  /** Discord guild snowflake ID, used to resolve persona names/avatars from cache. */
  guildDiscId: string;
  /** Display name shown on the card. */
  username: string;
  /** Discord CDN URL for the invoking user's avatar. */
  userAvatarUrl?: string | null;
  /** BCP-47 locale passed through to `PersonalCardData`. */
  locale: string;
  /** Selected time window, so drives gating and window floor. */
  timeframe: Timeframe;
}

export async function gatherPersonalCardData(args: GatherPersonalCardArgs): Promise<PersonalCardData> {
  // Card generation is a low-frequency snapshot, so include current-process
  // telemetry that may still be buffered from a just-completed interaction.
  await statRepository.flush();
  const { userId, serverId, guildDiscId, username, userAvatarUrl, locale, timeframe } = args;
  const windowFrom = resolveWindowFrom(timeframe);
  const windowArg = windowFrom ? { from: windowFrom } : {};

  const [totalTriggers, tokenTotals, estimatedCost, personaTokenCosts, modelBreakdown] = await Promise.all([
    statRepository.getMetricTotal({ metric: "message_sent", userId, serverId, ...windowArg }),
    statRepository.getTokenTotals({ userId, serverId, ...windowArg }),
    statRepository.getEstimatedCost({ userId, serverId, ...windowArg }),
    statRepository.getPersonaTokenCostBreakdown({ userId, serverId, ...windowArg }),
    statRepository.getModelBreakdown({ userId, serverId, ...windowArg }),
  ]);

  let favoritePersonas: PersonalFavoritePersona[] = [];
  try {
    const [personas, presetAvatars] = await Promise.all([
      getCachedAllPersonas(guildDiscId),
      loadStatsPresetAvatarLookup(),
    ]);
    // Ranked by total tokens (desc) so the list order matches the card's
    // Tokens/Spent columns. `getPersonaTokenCostBreakdown` already orders the
    // whole population by tokens, so the top five are the genuine token leaders.
    favoritePersonas = await Promise.all(
      personaTokenCosts.slice(0, 5).map(async (entry) => {
        const persona = personas.find((candidate) => candidate.persona_lineage_id === entry.lineageId);
        const avatarDataUri = persona ? await loadStatsPersonaAvatarDataUri(persona, presetAvatars) : null;
        return {
          name: persona?.persona_nickname ?? `Persona #${entry.lineageId}`,
          avatarDataUri,
          totalTokens: entry.inputTokens + entry.outputTokens,
          estimatedCost: entry.cost,
        };
      }),
    );
  } catch (error) {
    log.warn("personalCardGatherer: persona resolution failed", error as Error);
  }

  let userAvatarDataUri: string | null = null;
  if (userAvatarUrl) {
    try {
      userAvatarDataUri = await loadStoredPersonaAvatarDataUri(userAvatarUrl);
    } catch (error) {
      log.warn("personalCardGatherer: user avatar resolution failed", error as Error);
    }
  }

  const leadingAvatarDataUri = favoritePersonas[0]?.avatarDataUri ?? null;
  const palette = await extractCardPalette(leadingAvatarDataUri);

  return {
    locale,
    timeframe,
    username,
    userAvatarDataUri,
    tomoriconDataUri: await loadTomoriconDataUri(palette.ink),
    palette,
    totalTokens: tokenTotals.inputTokens + tokenTotals.outputTokens,
    totalTriggers,
    estimatedCost,
    favoritePersonas,
    favoriteModelName: modelBreakdown[0] ? modelBreakdown[0].model : null,
  };
}
