import { AttachmentBuilder, MessageFlags, type Client, type Guild, type InteractionReplyOptions } from "discord.js";
import type { TomoriState, UserRow } from "@/types/db/schema";
import { getCachedAllPersonas, getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import { userRepository } from "@/utils/db/repositories";
import type { GlobalInteractionRoute, GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { parseSnowflake } from "@/utils/discord/panelRouteCodec";
import {
  parseStatsDashboardRoute,
  STATS_ROUTE_NAMESPACE,
  STATS_ROUTE_VERSION,
  type StatsDashboardRoute,
} from "@/utils/discord/statsDashboardCatalog";
import {
  isLocalPersonaAvatarPath,
  loadStoredPersonaAvatarBuffer,
  resolvePersonaAvatarPublicUrl,
} from "@/utils/storage/avatarStorage";
import {
  buildPersonalTabs,
  buildPersonaTabs,
  buildServerTabs,
  buildStatsDashboardPayload,
  buildSubtitle,
  resolveWindowFrom,
  type StatsDashboardViewContext,
  type StatsTab,
  type Timeframe,
} from "@/utils/stats/statsDashboard";
import { localizer } from "@/utils/text/localizer";

export interface StatsRouteDependencies {
  loadUserByDiscordId(discordId: string): Promise<UserRow | null>;
  getCachedTomoriState(guildId: string): Promise<TomoriState | null>;
  getCachedAllPersonas(guildId: string): Promise<TomoriState[]>;
  buildPersonalTabs(args: Parameters<typeof buildPersonalTabs>[0]): Promise<StatsTab[]>;
  buildPersonaTabs(args: Parameters<typeof buildPersonaTabs>[0]): Promise<StatsTab[]>;
  buildServerTabs(args: Parameters<typeof buildServerTabs>[0]): Promise<StatsTab[]>;
}

const defaultDependencies: StatsRouteDependencies = {
  loadUserByDiscordId: (discordId) => userRepository.loadByDiscordId(discordId),
  getCachedTomoriState,
  getCachedAllPersonas,
  buildPersonalTabs,
  buildPersonaTabs,
  buildServerTabs,
};

function errorPayload(locale: string, descriptionKey: string): InteractionReplyOptions {
  return {
    content: localizer(locale, descriptionKey),
    flags: MessageFlags.Ephemeral,
  };
}

async function privateReply(interaction: GlobalRoutableInteraction, payload: InteractionReplyOptions): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply(payload);
  } else {
    await interaction.followUp(payload);
  }
}

function resolveGuild(client: Client, interaction: GlobalRoutableInteraction): Guild | null {
  if (!interaction.guildId) return null;
  if (interaction.guild) return interaction.guild;
  return client.guilds?.cache?.get(interaction.guildId) ?? null;
}

function isValidServerState(state: TomoriState | null, serverId: number): state is TomoriState {
  return state?.server_id === serverId;
}

function buildCommonContext(
  route: StatsDashboardRoute,
  guildId: string,
  timezoneOffset?: number | null,
): StatsDashboardViewContext {
  const common = {
    locale: route.locale,
    ownerId: route.ownerId,
    serverId: route.serverId,
    guildId,
    timeframe: route.timeframe as Timeframe,
  };
  if (route.view === "personal") return { ...common, view: route.view, scope: route.scope, timezoneOffset };
  if (route.view === "persona") return { ...common, view: route.view, personaId: route.personaId };
  return { ...common, view: route.view };
}

async function resolvePersonaIcon(
  guild: Guild | null,
  persona: TomoriState,
): Promise<{ iconUrl?: string; iconFile?: AttachmentBuilder }> {
  if (!persona.is_alter) {
    return { iconUrl: guild?.members.me?.displayAvatarURL({ extension: "png", size: 256 }) ?? undefined };
  }

  const publicUrl = resolvePersonaAvatarPublicUrl(persona.webhook_avatar_url);
  if (publicUrl) return { iconUrl: publicUrl };
  if (!persona.webhook_avatar_url || !isLocalPersonaAvatarPath(persona.webhook_avatar_url)) return {};

  const buffer = await loadStoredPersonaAvatarBuffer(persona.webhook_avatar_url);
  if (!buffer) return {};
  const name = "stats_persona_icon.png";
  return { iconFile: new AttachmentBuilder(buffer, { name }), iconUrl: `attachment://${name}` };
}

async function rebuildDashboard(
  client: Client,
  interaction: GlobalRoutableInteraction,
  route: StatsDashboardRoute,
  dependencies: StatsRouteDependencies,
): Promise<void> {
  const guild = resolveGuild(client, interaction);
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.followUp(errorPayload(route.locale, "general.errors.guild_only_description"));
    return;
  }

  const state = await dependencies.getCachedTomoriState(guildId);
  if (!isValidServerState(state, route.serverId)) {
    await interaction.followUp(errorPayload(route.locale, "general.errors.tomori_not_setup_description"));
    return;
  }

  const from = resolveWindowFrom(route.timeframe as Timeframe);
  let tabs: StatsTab[];
  let context: StatsDashboardViewContext;
  let iconUrl: string | undefined;
  let iconFile: AttachmentBuilder | undefined;

  if (route.view === "personal") {
    const userData = await dependencies.loadUserByDiscordId(interaction.user.id);
    if (!userData?.user_id) {
      await interaction.followUp(errorPayload(route.locale, "general.errors.tomori_not_setup_description"));
      return;
    }
    const scopeServerId = route.scope === "this_server" ? route.serverId : undefined;
    const timeframeLabel = localizer(route.locale, `commands.choices.${route.timeframe}`);
    const scopeLabel = localizer(
      route.locale,
      route.scope === "this_server" ? "commands.choices.this_server" : "commands.choices.global",
    );
    const displayName = interaction.user.displayName ?? interaction.user.username;
    context = buildCommonContext(route, guildId, userData.timezone_offset ?? null);
    tabs = await dependencies.buildPersonalTabs({
      locale: route.locale,
      userId: userData.user_id,
      userDiscId: userData.user_disc_id,
      serverId: route.serverId,
      guildId,
      timeframe: route.timeframe as Timeframe,
      from,
      scopeServerId,
      subtitle: `${displayName} • **${timeframeLabel}** (${scopeLabel})`,
      timezoneOffset: userData.timezone_offset ?? null,
    });
    iconUrl = interaction.user.displayAvatarURL({ extension: "png", size: 256 });
  } else if (route.view === "persona") {
    const personas = await dependencies.getCachedAllPersonas(guildId);
    const selected = personas.find((persona) => persona.persona_id === route.personaId);
    if (!selected || typeof selected.persona_lineage_id !== "number" || !selected.persona_nickname) {
      await interaction.followUp(errorPayload(route.locale, "commands.stats.persona.not_found_description"));
      return;
    }
    const subtitle = buildSubtitle(route.locale, route.timeframe as Timeframe);
    context = buildCommonContext(route, guildId);
    tabs = await dependencies.buildPersonaTabs({
      locale: route.locale,
      serverId: route.serverId,
      guildId,
      lineageId: selected.persona_lineage_id,
      personaName: selected.persona_nickname,
      timeframe: route.timeframe as Timeframe,
      from,
      subtitle: `${selected.persona_nickname} • ${subtitle}`,
    });
    ({ iconUrl, iconFile } = await resolvePersonaIcon(guild, selected));
  } else {
    context = buildCommonContext(route, guildId);
    tabs = await dependencies.buildServerTabs({
      locale: route.locale,
      serverId: route.serverId,
      guildId,
      timeframe: route.timeframe as Timeframe,
      from,
      subtitle: `${guild?.name ?? guildId} • ${buildSubtitle(route.locale, route.timeframe as Timeframe)}`,
    });
    iconUrl = guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
  }

  const activeIndex = tabs.findIndex((tab) => tab.id === route.tab);
  if (activeIndex < 0) {
    await interaction.followUp(errorPayload(route.locale, "general.errors.invalid_option_description"));
    return;
  }

  await interaction.editReply(buildStatsDashboardPayload(context, tabs, activeIndex, true, iconUrl, iconFile));
}

export function createStatsInteractionRoute(overrides: Partial<StatsRouteDependencies> = {}): GlobalInteractionRoute {
  const dependencies = { ...defaultDependencies, ...overrides };
  return {
    namespace: STATS_ROUTE_NAMESPACE,
    version: STATS_ROUTE_VERSION,
    async execute(client, interaction, parsed): Promise<void> {
      const route = parseStatsDashboardRoute(parsed);
      if (!interaction.isButton()) {
        await privateReply(
          interaction,
          errorPayload(route?.locale ?? interaction.locale ?? "en-US", "general.errors.invalid_option_description"),
        );
        return;
      }
      if (!route) {
        const rawOwnerId = parseSnowflake(parsed.segments[3]);
        const locale = parsed.segments[1] ?? interaction.locale ?? "en-US";
        if (rawOwnerId !== interaction.user.id) {
          await privateReply(interaction, errorPayload(locale, "general.errors.invalid_option_description"));
          return;
        }
        await interaction.deferUpdate();
        await interaction.followUp(errorPayload(locale, "general.errors.invalid_option_description"));
        return;
      }
      if (interaction.user.id !== route.ownerId) {
        await privateReply(interaction, errorPayload(route.locale, "general.errors.invalid_option_description"));
        return;
      }

      await interaction.deferUpdate();
      await rebuildDashboard(client, interaction, route, dependencies);
    },
  };
}

export const statsInteractionRoute = createStatsInteractionRoute();
