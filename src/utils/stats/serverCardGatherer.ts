/**
 * Gatherer for the Server Leaderboard infographic. It owns database reads,
 * Discord display-name resolution, image-data conversion, and per-avatar accent
 * sampling; the renderer is a pure function of the resulting ServerCardData.
 *
 * Layout mirrors the Personal Wrapped "golden standard": a light-mode card whose
 * palette is derived from the server icon, a vertical bar chart of the top
 * personas by tokens, then horizontal bars for the most active members and the
 * top models, and finally the server-wide token/spend totals.
 */
import type { Guild } from "discord.js";
import { getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import { statRepository } from "@/utils/db/repositories";
import type { TopUserEntry } from "@/utils/db/repositories/StatRepository";
import { log } from "@/utils/misc/logger";
import { loadStoredPersonaAvatarDataUri } from "@/utils/storage/avatarStorage";
import { type Timeframe, resolveWindowFrom } from "@/utils/stats/statsDashboard";
import { extractAvatarAccentColor, extractCardPalette, loadTomoriconDataUri } from "@/utils/stats/cardColor";
import { loadStatsPersonaAvatarDataUri, loadStatsPresetAvatarLookup } from "@/utils/stats/personaAvatar";
import type {
  PersonIcon,
  ServerCardData,
  ServerMemberBar,
  ServerModelBar,
  ServerPersonaBar,
} from "@/utils/stats/statsInfographic";

export interface GatherServerCardArgs {
  serverId: number;
  guildDiscId: string;
  serverName: string;
  locale: string;
  timeframe: Timeframe;
  guild: Guild;
}

async function resolveHumanMembers(
  guild: Guild,
  entries: TopUserEntry[],
  limit: number,
): Promise<Array<{ entry: TopUserEntry; icon: PersonIcon }>> {
  const resolved = await Promise.all(
    entries.map(async (entry) => {
      try {
        const member = await guild.members.fetch(entry.userDiscId);
        if (member.user.bot) return null;
        const avatarDataUri = await loadStoredPersonaAvatarDataUri(
          member.displayAvatarURL({ extension: "png", forceStatic: true, size: 128 }),
        );
        return { entry, icon: { name: member.displayName, avatarDataUri } };
      } catch {
        try {
          const user = await guild.client.users.fetch(entry.userDiscId);
          if (user.bot) return null;
          return { entry, icon: { name: `@${user.username}`, avatarDataUri: null } };
        } catch {
          return null;
        }
      }
    }),
  );

  const humans = [];
  for (const r of resolved) {
    if (r !== null) {
      humans.push(r);
      if (humans.length >= limit) break;
    }
  }
  return humans;
}

export async function gatherServerCardData(args: GatherServerCardArgs): Promise<ServerCardData> {
  await statRepository.flush();
  const { serverId, guildDiscId, serverName, locale, timeframe, guild } = args;
  const windowFrom = resolveWindowFrom(timeframe);
  const windowArg = windowFrom ? { from: windowFrom } : {};

  // One grouped query per ranked block: no per-row token/cost lookups.
  const [rawTopMembers, personaTokenCosts, modelCosts, tokenTotals, totalTriggers, estimatedCost] = await Promise.all([
    statRepository.getTopUsers({ serverId, limit: 25, ...windowArg }),
    statRepository.getPersonaTokenCostBreakdown({ serverId, limit: 5, ...windowArg }),
    statRepository.getModelCostBreakdown({ serverId, limit: 3, ...windowArg }),
    statRepository.getTokenTotals({ serverId, ...windowArg }),
    statRepository.getMetricTotal({ metric: "message_sent", serverId, ...windowArg }),
    statRepository.getEstimatedCost({ serverId, ...windowArg }),
  ]);

  // Server icon → light-mode card palette (analogous to Personal's #1 avatar).
  let serverIconDataUri: string | null = null;
  const serverIconUrl = guild.iconURL({ extension: "png", forceStatic: true, size: 128 });
  if (serverIconUrl) {
    try {
      serverIconDataUri = await loadStoredPersonaAvatarDataUri(serverIconUrl);
    } catch (error) {
      log.warn("serverCardGatherer: server icon resolution failed", error as Error);
    }
  }
  const palette = await extractCardPalette(serverIconDataUri);
  const tomoriconDataUri = await loadTomoriconDataUri(palette.ink);

  // Top personas (horizontal bars): names + avatars from cache, bar tint from avatar.
  let topPersonas: ServerPersonaBar[] = [];
  let totalPersonas = 0;
  try {
    const [personas, presetAvatars] = await Promise.all([
      getCachedAllPersonas(guildDiscId),
      loadStatsPresetAvatarLookup(),
    ]);
    totalPersonas = personas.length;
    topPersonas = await Promise.all(
      personaTokenCosts.map(async (entry, index) => {
        const persona = personas.find((candidate) => candidate.persona_lineage_id === entry.lineageId);
        const avatarDataUri = persona ? await loadStatsPersonaAvatarDataUri(persona, presetAvatars) : null;
        const accent = await extractAvatarAccentColor(avatarDataUri, palette.accent);
        return {
          name: persona?.persona_nickname ?? `Persona #${entry.lineageId}`,
          avatarDataUri,
          rank: index + 1,
          totalTokens: entry.inputTokens + entry.outputTokens,
          estimatedCost: entry.cost,
          accent,
        };
      }),
    );
  } catch (error) {
    log.warn("serverCardGatherer: persona resolution failed", error as Error);
  }

  const humanMembers = await resolveHumanMembers(guild, rawTopMembers, 3);
  const topMembers: ServerMemberBar[] = await Promise.all(
    humanMembers.map(async ({ entry, icon }, index) => ({
      ...icon,
      rank: index + 1,
      triggers: entry.count,
      accent: await extractAvatarAccentColor(icon.avatarDataUri, palette.accentSecondary),
    })),
  );

  const topModels: ServerModelBar[] = modelCosts.map((entry) => ({
    name: entry.model,
    totalTokens: entry.inputTokens + entry.outputTokens,
    estimatedCost: entry.cost,
  }));

  return {
    locale,
    timeframe,
    serverName,
    serverIconDataUri,
    tomoriconDataUri,
    palette,
    topPersonas,
    topMembers,
    topModels,
    totalTokens: tokenTotals.inputTokens + tokenTotals.outputTokens,
    estimatedCost,
    totalTriggers,
    totalPersonas,
    serverUserCount: guild.memberCount,
  };
}
