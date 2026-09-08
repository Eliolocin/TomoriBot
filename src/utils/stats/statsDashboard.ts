/**
 * Shared building blocks for the `/stats` commands (Phase 2 presentation layer).
 * Lives under utils/ (not commands/) because it is a helper module, not a loadable
 * command file: the command loader only scans commands/ for configureSubcommand/execute.
 *
 * - Timeframe → window resolution (daily-bucket floor).
 * - Per-view tab builders (personal / persona / server) that turn StatRepository
 *   reads into localized dashboard "tabs".
 * - A public, invoker-controlled tabbed dashboard renderer built on Components V2:
 *   each tab is a single container (H3 title, separator-divided stat sections, and
 *   the tab buttons living INSIDE the card). A row of named tab buttons swaps which
 *   tab container is shown (a tabbed view, not item pagination).
 *
 * Timeframe gating: metrics whose underlying data is inherently
 * all-time (rewards/punishments and memories) are only surfaced when timeframe =
 * all_time, and span metrics (streaks, peak hour/day) are hidden under the single-day
 * "today" view where they are meaningless. The builders decide this directly so
 * gated reads are never even fired. Generation totals are daily telemetry and work
 * for every timeframe.
 *
 * Token/cost figures prefer provider-reported usage and fall back to character estimates
 * when usage is unavailable (see tokenEstimate / postTurnEffects). They remain estimates
 * because catalog prices can be incomplete or provider-dependent.
 */
import {
  type AttachmentBuilder,
  ButtonStyle,
  ComponentType,
  type MessageFlags,
  type ActionRowData,
  type ButtonComponentData,
  type ChatInputCommandInteraction,
  type TopLevelComponentData,
} from "discord.js";
import { statRepository } from "@/utils/db/repositories";
import type {
  ConditioningPersonaEntry,
  EmotionEntry,
  GenerationTotals,
  ModelCostEntry,
  PersonaAffinityEntry,
  TopUserEntry,
} from "@/utils/db/repositories/StatRepository";
import { getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import { buildDashboardPagePayload, type DashboardPage } from "@/utils/metrics/status/statusPageRenderer";
import { buildStatsDashboardButtonId } from "@/utils/discord/statsDashboardCatalog";

/** Selectable time windows. `all_time` omits the bucket floor entirely. */
export type Timeframe = "today" | "week" | "month" | "year" | "all_time";

/** The choice values offered by the `timeframe` slash option, in display order. */
export const TIMEFRAME_VALUES: Timeframe[] = ["today", "week", "month", "year", "all_time"];

/** Default timeframe when the (optional) slash option is omitted: all-time. */
export const DEFAULT_TIMEFRAME: Timeframe = "all_time";

/** Scope choice for the personal view: current server vs. across all servers. */
export type StatsScope = "this_server" | "global";

/**
 * Resolves a timeframe to a `bucket >= from` floor (YYYY-MM-DD, UTC), or undefined
 * for all-time. "today" is the current UTC day only: the daily bucket grain cannot
 * express a rolling 24h, so the option is labelled "Today" rather than "24 hours".
 */
export function resolveWindowFrom(timeframe: Timeframe): string | undefined {
  if (timeframe === "all_time") return undefined;
  const now = new Date();
  const floor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  switch (timeframe) {
    case "today":
      break;
    case "week":
      floor.setUTCDate(floor.getUTCDate() - 6); // last 7 days incl. today
      break;
    case "month":
      floor.setUTCDate(floor.getUTCDate() - 29); // last 30 days incl. today
      break;
    case "year":
      floor.setUTCFullYear(floor.getUTCFullYear() - 1);
      break;
  }
  return floor.toISOString().split("T")[0];
}

/** Locale-grouped integer (e.g. 12,345). */
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** USD cost with 4 decimals (estimates are small). */
function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/**
 * Renders a ranked "1. label: `count` unit" list, or the localized empty placeholder.
 * `unit` is an already-localized suffix (e.g. "messages sent") appended after the count.
 */
function rankedList(locale: string, entries: Array<{ label: string; count: number }>, unit?: string): string {
  if (entries.length === 0) return localizer(locale, "commands.stats.empty");
  return entries.map((e, i) => `**${i + 1}.** ${e.label}: \`${fmtInt(e.count)}\`${unit ? ` ${unit}` : ""}`).join("\n");
}

/**
 * Renders the richer per-model rows: "1. `model`: 31,386 in / 155 out / $0.0000".
 * Falls back to the localized empty placeholder when there is no token data.
 */
function modelCostList(locale: string, entries: ModelCostEntry[]): string {
  if (entries.length === 0) return localizer(locale, "commands.stats.empty");
  const inShort = localizer(locale, "commands.stats.units.tokens_in_short");
  const outShort = localizer(locale, "commands.stats.units.tokens_out_short");
  return entries
    .map(
      (e, i) =>
        `**${i + 1}.** \`${e.model}\`: ${fmtInt(e.inputTokens)} ${inShort} / ${fmtInt(e.outputTokens)} ${outShort} / ${fmtUsd(e.cost)}`,
    )
    .join("\n");
}

/** Title-cases a raw emotion key for display (matches the /expressions UI). */
function titleCaseEmotion(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Renders a ranked emotion list with title-cased category labels. */
function emotionList(locale: string, entries: EmotionEntry[]): string {
  return rankedList(
    locale,
    entries.map((e) => ({ label: titleCaseEmotion(e.emotion), count: e.count })),
  );
}

/** Index of the highest-count key in a numeric record, or null when empty. */
function peakKey(record: Record<number, number>): number | null {
  let best: number | null = null;
  let bestCount = -1;
  for (const [key, count] of Object.entries(record)) {
    if (count > bestCount) {
      bestCount = count;
      best = Number(key);
    }
  }
  return best;
}

/** Resolves a persona lineage id to its nickname from the server's personas. */
function lineageLabel(locale: string, names: Map<number, string>, lineageId: number): string {
  return names.get(lineageId) ?? localizer(locale, "commands.stats.unknown_persona", { id: lineageId });
}

/**
 * Builds a lineage→nickname map from the guild's cached personas. `loadAllForServer`
 * returns the main persona first, so we keep the FIRST nickname seen per lineage:
 * when a renamed/forked persona shares a lineage with a former main (copy-on-write),
 * the current main's name wins instead of a stale alter's (e.g. "Ellen", not "Lucoa").
 */
async function resolvePersonaNames(guildId: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const personas = await getCachedAllPersonas(guildId);
    for (const persona of personas) {
      if (typeof persona.persona_lineage_id === "number" && !map.has(persona.persona_lineage_id)) {
        map.set(persona.persona_lineage_id, persona.persona_nickname);
      }
    }
  } catch (error) {
    log.warn(`resolvePersonaNames: failed for guild ${guildId}`, error as Error);
  }
  return map;
}

/** Formats the peak hour-of-day, shifting by a personal UTC offset when provided. */
function formatPeakHour(locale: string, hour: number | null, offsetHours?: number | null): string {
  if (hour === null) return localizer(locale, "commands.stats.empty");
  const shifted = offsetHours ? (((hour + offsetHours) % 24) + 24) % 24 : hour;
  const suffix = offsetHours ? localizer(locale, "commands.stats.local_suffix") : "UTC";
  return `${String(shifted).padStart(2, "0")}:00 ${suffix}`;
}

/** Formats the peak weekday from the histogram using localized short day names. */
function formatPeakWeekday(locale: string, byWeekday: Record<number, number>): string {
  const peak = peakKey(byWeekday);
  if (peak === null) return localizer(locale, "commands.stats.empty");
  const names = localizer(locale, "commands.stats.weekday_names").split(",");
  return names[peak] ?? String(peak);
}

/**
 * One dashboard field. Inline scalars are merged into a compact block; non-inline
 * fields (ranked lists) get their own labelled section; separators flush the scalar
 * buffer and insert a visual divider between field groups.
 */
type StatField = { kind: "stat"; nameKey: string; value: string; inline: boolean } | { kind: "separator" };

/** A single-line scalar stat field (localized name + computed value). */
function statField(nameKey: string, value: string, inline = true): StatField {
  return { kind: "stat", nameKey, value: value || "(None)", inline };
}

/** A visual section divider: flushes the scalar buffer and inserts a separator. */
function sepField(): StatField {
  return { kind: "separator" };
}

/** The resolved content of one tab (title + subtitle + ordered fields + footer). */
interface StatsTabPage {
  titleKey: string;
  subtitle: string;
  footerKey?: string;
  fields: StatField[];
}

/** One dashboard tab: a button (label) plus the page it reveals. */
export interface StatsTab {
  /** Stable id used in the button custom_id and to locate the tab on click. */
  id: string;
  /** Locale key for the button label. */
  labelKey: string;
  /** The page shown when this tab is active. */
  page: StatsTabPage;
}

const FOOTER_KEY = "commands.stats.footer";
const DASHBOARD_COLOR = ColorCode.INFO;

/** Common page scaffolding (title + subtitle + footer) for a tab. */
function page(titleKey: string, subtitle: string, fields: StatField[]): StatsTabPage {
  return { titleKey, subtitle, footerKey: FOOTER_KEY, fields };
}

/**
 * Builds the rows of named tab buttons (≤5 per row); the active tab is disabled.
 */
function buildTabButtonRows(
  context: StatsDashboardViewContext,
  tabs: StatsTab[],
  activeIndex: number,
  locale: string,
): ActionRowData<ButtonComponentData>[] {
  const rows: ActionRowData<ButtonComponentData>[] = [];
  for (let i = 0; i < tabs.length; i += 5) {
    rows.push({
      type: ComponentType.ActionRow,
      components: tabs.slice(i, i + 5).map((tab, j) => {
        const index = i + j;
        return {
          type: ComponentType.Button,
          style: index === activeIndex ? ButtonStyle.Primary : ButtonStyle.Secondary,
          customId: buildStatsDashboardButtonId(context, tab.id),
          label: localizer(locale, tab.labelKey),
          disabled: index === activeIndex,
        } satisfies ButtonComponentData;
      }),
    });
  }
  return rows;
}

/** Adapts statistics fields to the shared dashboard layout without losing visual separators. */
function toDashboardPage(tabPage: StatsTabPage, iconUrl?: string): DashboardPage {
  return {
    titleKey: tabPage.titleKey,
    description: tabPage.subtitle,
    footerKey: tabPage.footerKey,
    color: DASHBOARD_COLOR,
    thumbnailUrl: iconUrl,
    fields: tabPage.fields.map((field) =>
      field.kind === "separator"
        ? { separator: true }
        : { nameKey: field.nameKey, value: field.value, inline: field.inline },
    ),
  };
}

/**
 * Builds the editReply/update payload for the active tab. `iconFile` is re-attached
 * on every paint so an `attachment://` icon ref keeps resolving across tab switches.
 */
export function buildStatsDashboardPayload(
  context: StatsDashboardViewContext,
  tabs: StatsTab[],
  activeIndex: number,
  withButtons: boolean,
  iconUrl?: string,
  iconFile?: AttachmentBuilder,
): {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
  files?: AttachmentBuilder[];
};
/**
 * Compatibility overload for callers that only exercise the shared layout helper.
 * Production renderers always provide a typed view context.
 */
export function buildStatsDashboardPayload(
  legacyContext: string,
  tabs: StatsTab[],
  activeIndex: number,
  locale: string,
  withButtons: boolean,
  iconUrl?: string,
  iconFile?: AttachmentBuilder,
): {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
  files?: AttachmentBuilder[];
};
export function buildStatsDashboardPayload(
  contextOrLegacy: StatsDashboardViewContext | string,
  tabs: StatsTab[],
  activeIndex: number,
  withButtonsOrLocale: boolean | string,
  iconUrlOrWithButtons?: string | boolean,
  iconFileOrUrl?: string | AttachmentBuilder,
  legacyIconFile?: AttachmentBuilder,
): {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
  files?: AttachmentBuilder[];
} {
  const context: StatsDashboardViewContext =
    typeof contextOrLegacy === "string"
      ? {
          view: "personal",
          locale: withButtonsOrLocale as string,
          ownerId: "00000000000000000",
          serverId: 1,
          guildId: "00000000000000000",
          timeframe: "all_time",
          scope: "global",
        }
      : contextOrLegacy;
  const withButtons =
    typeof contextOrLegacy === "string" ? iconUrlOrWithButtons === true : withButtonsOrLocale === true;
  const iconUrl =
    typeof contextOrLegacy === "string"
      ? typeof iconFileOrUrl === "string"
        ? iconFileOrUrl
        : undefined
      : typeof iconUrlOrWithButtons === "string"
        ? iconUrlOrWithButtons
        : undefined;
  const iconFile =
    typeof contextOrLegacy === "string"
      ? legacyIconFile
      : iconFileOrUrl && typeof iconFileOrUrl !== "string"
        ? iconFileOrUrl
        : undefined;
  const buttonRows = buildTabButtonRows(context, tabs, activeIndex, context.locale);
  return {
    ...buildDashboardPagePayload({
      locale: context.locale,
      page: toDashboardPage(tabs[activeIndex].page, iconUrl),
      buttonRows: withButtons ? buttonRows : [],
    }),
    ...(iconFile ? { files: [iconFile] } : {}),
  };
}

/**
 * Renders a public tabbed dashboard. The dashboard buttons are durable global routes,
 * so each repaint is handled by the interaction router rather than a message collector.
 *
 * @param interaction - The acknowledged (publicly deferred) slash interaction.
 * @param context     - Immutable view inputs encoded into every tab button.
 * @param tabs        - The tabs to render (first is shown initially).
 * @param iconUrl     - Optional avatar/icon URL pinned to the card's top-right corner
 *                      (user avatar for /personal, persona avatar for /persona, server
 *                      icon for /server). Either a public http(s) URL or an
 *                      `attachment://<name>` ref backed by `iconFile`.
 * @param iconFile    - Optional attachment backing an `attachment://` iconUrl (a local
 *                      persona avatar loaded from disk when no public URL exists, e.g.
 *                      non-production). Re-attached on every repaint so the ref resolves.
 */
export async function renderStatsDashboard(
  interaction: ChatInputCommandInteraction,
  context: StatsDashboardViewContext,
  tabs: StatsTab[],
  iconUrl?: string,
  iconFile?: AttachmentBuilder,
): Promise<void> {
  if (tabs.length === 0) return;
  await interaction.editReply(buildStatsDashboardPayload(context, tabs, 0, true, iconUrl, iconFile));
}

/**
 * Renders the same public dashboard through a caller-owned one-shot public reply.
 * Persona uses this after its private validation acknowledgement is deleted.
 */
export async function renderStatsDashboardWithReply(
  reply: (payload: ReturnType<typeof buildStatsDashboardPayload>) => Promise<unknown>,
  context: StatsDashboardViewContext,
  tabs: StatsTab[],
  iconUrl?: string,
  iconFile?: AttachmentBuilder,
): Promise<void> {
  if (tabs.length === 0) return;
  await reply(buildStatsDashboardPayload(context, tabs, 0, true, iconUrl, iconFile));
}

interface StatsDashboardViewContextBase {
  locale: string;
  ownerId: string;
  serverId: number;
  guildId: string;
  timeframe: Timeframe;
}

export type StatsDashboardViewContext =
  | (StatsDashboardViewContextBase & { view: "personal"; scope: StatsScope; timezoneOffset?: number | null })
  | (StatsDashboardViewContextBase & { view: "persona"; personaId: number })
  | (StatsDashboardViewContextBase & { view: "server" });

/**
 * Builds the personal (`/stats personal`) dashboard tabs for one user.
 * `scopeServerId` is the internal server id when scope=this_server, else undefined
 * (global, aggregated across every server the user shares with the bot).
 */
export async function buildPersonalTabs(args: {
  locale: string;
  userId: number;
  userDiscId: string;
  serverId: number;
  guildId: string;
  timeframe: Timeframe;
  from?: string;
  scopeServerId?: number;
  subtitle: string;
  timezoneOffset?: number | null;
}): Promise<StatsTab[]> {
  // Dashboards are low-frequency reads. Drain telemetry first so the rendered
  // snapshot includes any successfully buffered work from the current process.
  await statRepository.flush();
  const { locale, userId, from, scopeServerId, subtitle, timeframe } = args;
  const isAllTime = timeframe === "all_time";
  const isToday = timeframe === "today";
  const names = await resolvePersonaNames(args.guildId);
  const scope = { userId, serverId: scopeServerId, from };

  const [
    messages,
    commands,
    favorite,
    affinity,
    models,
    modelCost,
    tokens,
    cost,
    tools,
    topCommands,
    emoji,
    stickers,
    sprites,
    emotions,
  ] = await Promise.all([
    statRepository.getMetricTotal({ metric: "message_sent", ...scope }),
    statRepository.getMetricTotal({ metric: "command_used", ...scope }),
    statRepository.getFavoritePersona({ userId, serverId: scopeServerId, from }),
    statRepository.getPersonaAffinity({ userId, serverId: scopeServerId, from }),
    statRepository.getModelBreakdown({ userId, serverId: scopeServerId, from }),
    statRepository.getModelCostBreakdown({ userId, serverId: scopeServerId, from, limit: 5 }),
    statRepository.getTokenTotals(scope),
    statRepository.getEstimatedCost({ userId, serverId: scopeServerId, from }),
    statRepository.getMetricKeyBreakdown({ metric: "tool_used", ...scope, limit: 5 }),
    statRepository.getMetricKeyBreakdown({ metric: "command_used", ...scope, limit: 5 }),
    statRepository.getMetricKeyBreakdown({ metric: "emoji_used", ...scope, limit: 5 }),
    statRepository.getMetricKeyBreakdown({ metric: "sticker_used", ...scope, limit: 5 }),
    statRepository.getMetricKeyBreakdown({ metric: "sprite_shown", ...scope, limit: 5 }),
    statRepository.getEmotionBreakdown({ userId, serverId: scopeServerId, from, limit: 5 }),
  ]);

  const streak = isToday ? null : await statRepository.getStreak({ userId, serverId: scopeServerId });
  const histogram = isToday
    ? null
    : await statRepository.getActivityHistogram({ userId, serverId: scopeServerId, from });

  let memoriesSaved = 0;
  let memoryByPersona: PersonaAffinityEntry[] = [];
  let conditioningByPersona: ConditioningPersonaEntry[] = [];
  let conditioning = { rewards: 0, punishments: 0 };
  let generations: GenerationTotals = { textGenerations: 0, imageGenerations: 0, videoGenerations: 0 };
  if (isAllTime) {
    [memoriesSaved, memoryByPersona, conditioningByPersona, conditioning] = await Promise.all([
      statRepository.getPersonalMemoryCount({ userId }),
      statRepository.getPersonalMemoryByPersona({ userId, limit: 5 }),
      statRepository.getConditioningPersonaBreakdown({ userId, serverId: scopeServerId }),
      statRepository.getConditioningTotals({ userId, serverId: scopeServerId }),
    ]);
  }
  // Generation telemetry carries the same server/user dimensions as other stats,
  // so both this-server and global personal scopes are meaningful and windowable.
  generations = await statRepository.getGenerationTotals({
    serverId: scopeServerId,
    userId,
    from: args.from,
  });

  const unitMemories = localizer(locale, "commands.stats.units.memories_saved");
  const unitReplies = localizer(locale, "commands.stats.units.replies_received");

  const favoritePersonaName =
    favorite === null ? localizer(locale, "commands.stats.empty") : lineageLabel(locale, names, favorite.lineageId);
  const favoritePersonaText =
    favorite === null
      ? localizer(locale, "commands.stats.empty")
      : `${lineageLabel(locale, names, favorite.lineageId)} (${favorite.loyaltyPct.toFixed(0)}%)`;

  const mostRewarded = [...conditioningByPersona]
    .filter((c) => c.rewards > 0)
    .sort((a, b) => b.rewards - a.rewards)
    .slice(0, 5)
    .map((c) => ({ label: lineageLabel(locale, names, c.lineageId), count: c.rewards }));
  const mostPunished = [...conditioningByPersona]
    .filter((c) => c.punishments > 0)
    .sort((a, b) => b.punishments - a.punishments)
    .slice(0, 5)
    .map((c) => ({ label: lineageLabel(locale, names, c.lineageId), count: c.punishments }));

  const favoriteModel = modelCost[0] ? modelCost[0].model : localizer(locale, "commands.stats.empty");

  const overviewFields: StatField[] = [
    statField("commands.stats.fields.messages_personal", fmtInt(messages)),
    statField("commands.stats.fields.favorite_persona_short", favoritePersonaName),
    statField("commands.stats.fields.favorite_model", favoriteModel),
    sepField(),
    statField("commands.stats.fields.tokens_in", fmtInt(tokens.inputTokens)),
    statField("commands.stats.fields.tokens_out", fmtInt(tokens.outputTokens)),
    statField("commands.stats.fields.est_cost", fmtUsd(cost)),
  ];
  if (!isToday) {
    const hasActivity = streak !== null || histogram !== null;
    if (hasActivity) {
      overviewFields.push(sepField());
      if (streak) {
        overviewFields.push(
          statField(
            "commands.stats.fields.current_streak",
            localizer(locale, "commands.stats.days", { count: streak.currentStreak }),
          ),
          statField(
            "commands.stats.fields.longest_streak",
            localizer(locale, "commands.stats.days", { count: streak.longestStreak }),
          ),
        );
      }
      if (histogram) {
        overviewFields.push(
          statField(
            "commands.stats.fields.peak_hour",
            formatPeakHour(locale, peakKey(histogram.byHour), args.timezoneOffset),
          ),
          statField("commands.stats.fields.peak_weekday", formatPeakWeekday(locale, histogram.byWeekday)),
        );
      }
    }
  }
  if (isAllTime) {
    overviewFields.push(
      sepField(),
      statField("commands.stats.fields.personal_memories", fmtInt(memoriesSaved)),
      statField("commands.stats.fields.rewards", fmtInt(conditioning.rewards)),
      statField("commands.stats.fields.punishments", fmtInt(conditioning.punishments)),
    );
  }
  overviewFields.push(
    sepField(),
    statField("commands.stats.fields.images", fmtInt(generations.imageGenerations)),
    statField("commands.stats.fields.videos", fmtInt(generations.videoGenerations)),
  );
  overviewFields.push(statField("commands.stats.fields.commands", fmtInt(commands)));

  const personaFields: StatField[] = [
    statField("commands.stats.fields.favorite_persona", favoritePersonaText, false),
    statField(
      "commands.stats.fields.messages_by_persona",
      rankedList(
        locale,
        affinity.slice(0, 5).map((a) => ({ label: lineageLabel(locale, names, a.lineageId), count: a.count })),
        unitReplies,
      ),
      false,
    ),
  ];
  if (isAllTime) {
    personaFields.push(
      statField(
        "commands.stats.fields.memories_by_persona",
        rankedList(
          locale,
          memoryByPersona.map((m) => ({ label: lineageLabel(locale, names, m.lineageId), count: m.count })),
          unitMemories,
        ),
        false,
      ),
      statField("commands.stats.fields.most_rewarded_personas", rankedList(locale, mostRewarded), false),
      statField("commands.stats.fields.most_punished_personas", rankedList(locale, mostPunished), false),
    );
  }

  return [
    {
      id: "overview",
      labelKey: "commands.stats.tabs.overview_label",
      page: page("commands.stats.tabs.overview_title", subtitle, overviewFields),
    },
    {
      id: "personas",
      labelKey: "commands.stats.tabs.personas_label",
      page: page("commands.stats.tabs.personas_title", subtitle, personaFields),
    },
    {
      id: "models",
      labelKey: "commands.stats.tabs.models_label",
      page: page("commands.stats.tabs.models_title", subtitle, [
        statField("commands.stats.fields.top_models", modelCostList(locale, modelCost), false),
        statField("commands.stats.fields.model_diversity", fmtInt(models.length)),
        statField("commands.stats.fields.tokens_in", fmtInt(tokens.inputTokens)),
        statField("commands.stats.fields.tokens_out", fmtInt(tokens.outputTokens)),
        statField("commands.stats.fields.est_cost", fmtUsd(cost)),
      ]),
    },
    {
      id: "tools",
      labelKey: "commands.stats.tabs.tools_label",
      page: page("commands.stats.tabs.tools_title", subtitle, [
        statField(
          "commands.stats.fields.top_tools",
          rankedList(
            locale,
            tools.map((t) => ({ label: `\`${t.key}\``, count: t.count })),
          ),
          false,
        ),
        statField(
          "commands.stats.fields.top_commands",
          rankedList(
            locale,
            topCommands.map((c) => ({ label: `\`${c.key}\``, count: c.count })),
          ),
          false,
        ),
      ]),
    },
    {
      id: "expression",
      labelKey: "commands.stats.tabs.expression_label",
      page: page("commands.stats.tabs.expression_title", subtitle, [
        statField("commands.stats.fields.top_emotions_caused", emotionList(locale, emotions), false),
        statField(
          "commands.stats.fields.top_emoji_received",
          rankedList(
            locale,
            emoji.map((e) => ({ label: `:${e.key}:`, count: e.count })),
          ),
          false,
        ),
        statField(
          "commands.stats.fields.top_stickers_received",
          rankedList(
            locale,
            stickers.map((s) => ({ label: `\`${s.key}\``, count: s.count })),
          ),
          false,
        ),
        statField(
          "commands.stats.fields.top_sprites_received",
          rankedList(
            locale,
            sprites.map((s) => ({ label: `\`${s.key}\``, count: s.count })),
          ),
          false,
        ),
      ]),
    },
  ];
}

/**
 * Builds the persona (`/stats persona`) dashboard tabs for one lineage on this server.
 */
export async function buildPersonaTabs(args: {
  locale: string;
  serverId: number;
  guildId: string;
  lineageId: number;
  personaName: string;
  timeframe: Timeframe;
  from?: string;
  subtitle: string;
}): Promise<StatsTab[]> {
  await statRepository.flush();
  const { locale, serverId, lineageId, from, subtitle, timeframe } = args;
  const isAllTime = timeframe === "all_time";
  const scope = { serverId, lineageId, from };

  const [messages, topUsers, modelCost, tokens, cost, emoji, stickers, sprites, emotions] = await Promise.all([
    statRepository.getMetricTotal({ metric: "message_sent", ...scope }),
    statRepository.getTopUsers({ serverId, lineageId, from, limit: 5 }),
    statRepository.getModelCostBreakdown({ serverId, lineageId, from, limit: 5 }),
    statRepository.getTokenTotals(scope),
    statRepository.getEstimatedCost({ serverId, lineageId, from }),
    statRepository.getMetricKeyBreakdown({ metric: "emoji_used", ...scope, limit: 5 }),
    statRepository.getMetricKeyBreakdown({ metric: "sticker_used", ...scope, limit: 5 }),
    statRepository.getMetricKeyBreakdown({ metric: "sprite_shown", ...scope, limit: 5 }),
    statRepository.getEmotionBreakdown({ serverId, lineageId, from, limit: 5 }),
  ]);

  let conditioning = { rewards: 0, punishments: 0 };
  let personalMemoryCount = 0;
  let serverMemoryCount = 0;
  let rewardedBy: TopUserEntry[] = [];
  let punishedBy: TopUserEntry[] = [];
  let remembered: TopUserEntry[] = [];
  if (isAllTime) {
    [conditioning, personalMemoryCount, serverMemoryCount, rewardedBy, punishedBy, remembered] = await Promise.all([
      statRepository.getConditioningTotals({ serverId, lineageId }),
      // People this persona has personal memories about (global per lineage: personal
      // memories carry no server_id).
      statRepository.getPersonaMemoryCount({ lineageId }),
      statRepository.getServerMemoryCount({ serverId, lineageId }),
      statRepository.getConditioningTopUsers({ serverId, lineageId, type: "reward", limit: 5 }),
      statRepository.getConditioningTopUsers({ serverId, lineageId, type: "punish", limit: 5 }),
      statRepository.getTopUsersByMemory({ serverId, lineageId, limit: 5 }),
    ]);
  }

  const unitMessages = localizer(locale, "commands.stats.units.messages_sent");
  const unitMemories = localizer(locale, "commands.stats.units.memories_saved");
  const unitRewards = localizer(locale, "commands.stats.units.rewards");
  const unitPunishments = localizer(locale, "commands.stats.units.punishments");

  // ── Overview (mirrors the personal/server core: messages, cost, memories,
  //    rewards/punishments; raw token volume lives in the Models tab). ──
  const overviewFields: StatField[] = [
    statField("commands.stats.fields.messages_persona", fmtInt(messages)),
    sepField(),
    statField("commands.stats.fields.tokens_in", fmtInt(tokens.inputTokens)),
    statField("commands.stats.fields.tokens_out", fmtInt(tokens.outputTokens)),
    statField("commands.stats.fields.est_cost", fmtUsd(cost)),
  ];
  if (isAllTime) {
    overviewFields.push(
      sepField(),
      statField("commands.stats.fields.personal_memories_created", fmtInt(personalMemoryCount)),
      statField("commands.stats.fields.server_memories_created", fmtInt(serverMemoryCount)),
      statField("commands.stats.fields.rewards_received", fmtInt(conditioning.rewards)),
      statField("commands.stats.fields.punishments_received", fmtInt(conditioning.punishments)),
    );
  }

  const peopleFields: StatField[] = [
    statField(
      "commands.stats.fields.most_talked_to_people",
      rankedList(
        locale,
        topUsers.map((u) => ({ label: `<@${u.userDiscId}>`, count: u.count })),
        unitMessages,
      ),
      false,
    ),
  ];
  if (isAllTime) {
    peopleFields.push(
      statField(
        "commands.stats.fields.most_remembered_people",
        rankedList(
          locale,
          remembered.map((u) => ({ label: `<@${u.userDiscId}>`, count: u.count })),
          unitMemories,
        ),
        false,
      ),
      statField(
        "commands.stats.fields.most_rewarded_by",
        rankedList(
          locale,
          rewardedBy.map((u) => ({ label: `<@${u.userDiscId}>`, count: u.count })),
          unitRewards,
        ),
        false,
      ),
      statField(
        "commands.stats.fields.most_punished_by",
        rankedList(
          locale,
          punishedBy.map((u) => ({ label: `<@${u.userDiscId}>`, count: u.count })),
          unitPunishments,
        ),
        false,
      ),
    );
  }

  return [
    {
      id: "overview",
      labelKey: "commands.stats.tabs.overview_label",
      page: page("commands.stats.tabs.overview_title", subtitle, overviewFields),
    },
    {
      id: "people",
      labelKey: "commands.stats.tabs.people_label",
      page: page("commands.stats.tabs.people_title", subtitle, peopleFields),
    },
    {
      id: "models",
      labelKey: "commands.stats.tabs.models_label",
      page: page("commands.stats.tabs.models_title", subtitle, [
        statField("commands.stats.fields.top_models", modelCostList(locale, modelCost), false),
        statField("commands.stats.fields.tokens_in", fmtInt(tokens.inputTokens)),
        statField("commands.stats.fields.tokens_out", fmtInt(tokens.outputTokens)),
        statField("commands.stats.fields.est_cost", fmtUsd(cost)),
      ]),
    },
    {
      id: "expression",
      labelKey: "commands.stats.tabs.expression_label",
      page: page("commands.stats.tabs.expression_title", subtitle, [
        statField("commands.stats.fields.top_emotions", emotionList(locale, emotions), false),
        statField(
          "commands.stats.fields.top_emoji",
          rankedList(
            locale,
            emoji.map((e) => ({ label: `:${e.key}:`, count: e.count })),
          ),
          false,
        ),
        statField(
          "commands.stats.fields.top_stickers",
          rankedList(
            locale,
            stickers.map((s) => ({ label: `\`${s.key}\``, count: s.count })),
          ),
          false,
        ),
        statField(
          "commands.stats.fields.top_sprites",
          rankedList(
            locale,
            sprites.map((s) => ({ label: `\`${s.key}\``, count: s.count })),
          ),
          false,
        ),
      ]),
    },
  ];
}

/**
 * Builds the server (`/stats server`) dashboard tabs.
 */
export async function buildServerTabs(args: {
  locale: string;
  serverId: number;
  guildId: string;
  timeframe: Timeframe;
  from?: string;
  subtitle: string;
}): Promise<StatsTab[]> {
  await statRepository.flush();
  const { locale, serverId, from, subtitle, timeframe } = args;
  const isAllTime = timeframe === "all_time";
  const names = await resolvePersonaNames(args.guildId);
  const scope = { serverId, from };

  const [
    messages,
    commands,
    leaderboard,
    modelCost,
    tokens,
    cost,
    tools,
    topCommands,
    emoji,
    stickers,
    sprites,
    popularPersonas,
    emotions,
    generations,
  ] = await Promise.all([
    statRepository.getMetricTotal({ metric: "message_sent", ...scope }),
    statRepository.getMetricTotal({ metric: "command_used", ...scope }),
    statRepository.getTopUsers({ serverId, from, limit: 5 }),
    statRepository.getModelCostBreakdown({ serverId, from, limit: 5 }),
    statRepository.getTokenTotals(scope),
    statRepository.getEstimatedCost({ serverId, from }),
    statRepository.getMetricKeyBreakdown({ metric: "tool_used", ...scope, limit: 5 }),
    statRepository.getMetricKeyBreakdown({ metric: "command_used", ...scope, limit: 5 }),
    statRepository.getMetricKeyBreakdown({ metric: "emoji_used", ...scope, limit: 5 }),
    statRepository.getMetricKeyBreakdown({ metric: "sticker_used", ...scope, limit: 5 }),
    statRepository.getMetricKeyBreakdown({ metric: "sprite_shown", ...scope, limit: 5 }),
    statRepository.getServerPersonaMessages({ serverId, from, limit: 5 }),
    statRepository.getEmotionBreakdown({ serverId, from, limit: 5 }),
    statRepository.getGenerationTotals({ serverId, from }),
  ]);

  let conditioning = { rewards: 0, punishments: 0 };
  let memorableMembers: TopUserEntry[] = [];
  let serverMemoryCount = 0;
  let memberMemoryCount = 0;
  if (isAllTime) {
    [conditioning, memorableMembers, serverMemoryCount, memberMemoryCount] = await Promise.all([
      statRepository.getConditioningTotals({ serverId }),
      statRepository.getTopUsersByMemory({ serverId, limit: 5 }),
      // Server-scoped shared facts (exact) vs. members' personal memories (approximate,
      // cross-server); kept as separate rows since they are different kinds of memory.
      statRepository.getServerMemoryCount({ serverId }),
      statRepository.getMemberMemoryCount({ serverId }),
    ]);
  }

  const unitToMe = localizer(locale, "commands.stats.units.messages_to_me");
  const unitReceived = localizer(locale, "commands.stats.units.messages_received");
  const unitMemories = localizer(locale, "commands.stats.units.memories_saved");

  const mostPopularPersonaName = popularPersonas[0]
    ? lineageLabel(locale, names, popularPersonas[0].lineageId)
    : localizer(locale, "commands.stats.empty");
  const mostPopularModel = modelCost[0] ? modelCost[0].model : localizer(locale, "commands.stats.empty");

  // ── Overview (shared core; Images/Videos are deliberately omitted on the
  // persona view to keep this card focused on conversational affinity). ──
  // Group 1: trigger count + top persona + top model.
  const overviewFields: StatField[] = [
    statField("commands.stats.fields.messages", fmtInt(messages)),
    statField("commands.stats.fields.most_popular_persona", mostPopularPersonaName),
    statField("commands.stats.fields.most_popular_model", mostPopularModel),
    sepField(),
    statField("commands.stats.fields.tokens_in", fmtInt(tokens.inputTokens)),
    statField("commands.stats.fields.tokens_out", fmtInt(tokens.outputTokens)),
    statField("commands.stats.fields.est_cost", fmtUsd(cost)),
  ];
  if (isAllTime) {
    overviewFields.push(
      sepField(),
      statField("commands.stats.fields.server_memories", fmtInt(serverMemoryCount)),
      statField("commands.stats.fields.member_memories", fmtInt(memberMemoryCount)),
      statField("commands.stats.fields.rewards", fmtInt(conditioning.rewards)),
      statField("commands.stats.fields.punishments", fmtInt(conditioning.punishments)),
    );
  }
  overviewFields.push(
    sepField(),
    statField("commands.stats.fields.images", fmtInt(generations.imageGenerations)),
    statField("commands.stats.fields.videos", fmtInt(generations.videoGenerations)),
    statField("commands.stats.fields.commands", fmtInt(commands)),
  );

  const leaderboardFields: StatField[] = [
    statField(
      "commands.stats.fields.most_talkative_members",
      rankedList(
        locale,
        leaderboard.map((u) => ({ label: `<@${u.userDiscId}>`, count: u.count })),
        unitToMe,
      ),
      false,
    ),
    statField(
      "commands.stats.fields.most_popular_personas",
      rankedList(
        locale,
        popularPersonas.map((p) => ({ label: lineageLabel(locale, names, p.lineageId), count: p.count })),
        unitReceived,
      ),
      false,
    ),
  ];
  if (isAllTime) {
    leaderboardFields.push(
      statField(
        "commands.stats.fields.most_memorable_members",
        rankedList(
          locale,
          memorableMembers.map((u) => ({ label: `<@${u.userDiscId}>`, count: u.count })),
          unitMemories,
        ),
        false,
      ),
    );
  }

  return [
    {
      id: "overview",
      labelKey: "commands.stats.tabs.overview_label",
      page: page("commands.stats.tabs.overview_title", subtitle, overviewFields),
    },
    {
      id: "leaderboard",
      labelKey: "commands.stats.tabs.leaderboard_label",
      page: page("commands.stats.tabs.leaderboard_title", subtitle, leaderboardFields),
    },
    {
      id: "models",
      labelKey: "commands.stats.tabs.models_label",
      page: page("commands.stats.tabs.models_title", subtitle, [
        statField("commands.stats.fields.top_models", modelCostList(locale, modelCost), false),
        statField("commands.stats.fields.tokens_in", fmtInt(tokens.inputTokens)),
        statField("commands.stats.fields.tokens_out", fmtInt(tokens.outputTokens)),
        statField("commands.stats.fields.est_cost", fmtUsd(cost)),
      ]),
    },
    {
      id: "tools",
      labelKey: "commands.stats.tabs.tools_label",
      page: page("commands.stats.tabs.tools_title", subtitle, [
        statField(
          "commands.stats.fields.top_tools",
          rankedList(
            locale,
            tools.map((t) => ({ label: `\`${t.key}\``, count: t.count })),
          ),
          false,
        ),
        statField(
          "commands.stats.fields.top_commands",
          rankedList(
            locale,
            topCommands.map((c) => ({ label: `\`${c.key}\``, count: c.count })),
          ),
          false,
        ),
      ]),
    },
    {
      id: "expression",
      labelKey: "commands.stats.tabs.expression_label",
      page: page("commands.stats.tabs.expression_title", subtitle, [
        statField("commands.stats.fields.top_emotions", emotionList(locale, emotions), false),
        statField(
          "commands.stats.fields.top_emoji",
          rankedList(
            locale,
            emoji.map((e) => ({ label: `:${e.key}:`, count: e.count })),
          ),
          false,
        ),
        statField(
          "commands.stats.fields.top_stickers",
          rankedList(
            locale,
            stickers.map((s) => ({ label: `\`${s.key}\``, count: s.count })),
          ),
          false,
        ),
        statField(
          "commands.stats.fields.top_sprites",
          rankedList(
            locale,
            sprites.map((s) => ({ label: `\`${s.key}\``, count: s.count })),
          ),
          false,
        ),
      ]),
    },
  ];
}

/** Builds the localized "{timeframe} • {scope}" subtitle shown under each tab title. */
export function buildSubtitle(locale: string, timeframe: Timeframe, scopeLabelKey?: string): string {
  const timeframeLabel = localizer(locale, `commands.choices.${timeframe}`);
  if (!scopeLabelKey) return `**${timeframeLabel}**`;
  return `**${timeframeLabel}** • ${localizer(locale, scopeLabelKey)}`;
}
