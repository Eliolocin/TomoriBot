import {
  AttachmentBuilder,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { getCachedAllPersonas, getCachedTomoriState } from "@/utils/cache/tomoriStateCache";
import type { CommandAutocompleteFunction } from "@/utils/discord/commandLoader";
import { replyInfoEmbed, safeSelectOptionText } from "@/utils/discord/ui/interactionCore";
import {
  isLocalPersonaAvatarPath,
  loadStoredPersonaAvatarBuffer,
  resolvePersonaAvatarPublicUrl,
} from "@/utils/storage/avatarStorage";
import { localizer } from "@/utils/text/localizer";
import { log, ColorCode } from "@/utils/misc/logger";
import * as statsDashboard from "@/utils/stats/statsDashboard";

/**
 * Validates and parses an untrusted persona option value.
 * Strictly accepts only positive safe decimal integer IDs (rejects whitespace,
 * signs, decimals, junk, zero, and unsafe integers).
 */
export function parsePersonaOptionId(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== value) {
    return null;
  }
  return id;
}

/**
 * Finds a persona in the server's persona list by an untrusted option value.
 * Returns null if the option value is missing/malformed or does not exist on the server.
 */
export function resolveSelectedPersona<T extends { persona_id?: number }>(
  personas: readonly T[],
  rawPersonaOption: unknown,
): T | null {
  const personaId = parsePersonaOptionId(rawPersonaOption);
  if (personaId === null) {
    return null;
  }
  return personas.find((p) => p.persona_id === personaId) ?? null;
}

/**
 * Configures the /stats persona subcommand: select a persona via autocomplete, then view
 * that persona's usage stats on this server for the chosen timeframe.
 */
export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("persona")
    .setDescription(localizer("en-US", "commands.stats.persona.description"))
    .addStringOption((option) =>
      option
        .setName("persona")
        .setDescription(localizer("en-US", "commands.stats.persona.persona_description"))
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName("timeframe")
        .setDescription(localizer("en-US", "commands.stats.persona.timeframe_description"))
        .setRequired(false)
        .addChoices(
          ...statsDashboard.TIMEFRAME_VALUES.map((value) => ({
            name: localizer("en-US", `commands.choices.${value}`),
            value,
          })),
        ),
    );

/**
 * Autocomplete handler for the persona option on /stats persona.
 * Returns all personas for this guild, ranked by exact match, prefix, and substring.
 */
export const autocomplete: CommandAutocompleteFunction = async (
  _client: Client,
  interaction: AutocompleteInteraction,
): Promise<void> => {
  let responded = false;
  try {
    if (!interaction.guild) {
      responded = true;
      await interaction.respond([]);
      return;
    }

    const allPersonas = await getCachedAllPersonas(interaction.guild.id);
    if (allPersonas.length === 0) {
      responded = true;
      await interaction.respond([]);
      return;
    }

    const focusedOption = interaction.options.getFocused();
    const focusedValue = (focusedOption || "").toLowerCase();

    let filtered = allPersonas;
    if (focusedValue) {
      const exact: typeof allPersonas = [];
      const prefix: typeof allPersonas = [];
      const substring: typeof allPersonas = [];

      for (const p of allPersonas) {
        const nickname = (p.persona_nickname ?? "").toLowerCase();
        if (nickname === focusedValue) {
          exact.push(p);
        } else if (nickname.startsWith(focusedValue)) {
          prefix.push(p);
        } else if (nickname.includes(focusedValue)) {
          substring.push(p);
        }
      }

      filtered = [...exact, ...prefix, ...substring];
    }

    const limited = filtered.slice(0, 25);

    const choices = limited.map((p) => ({
      name: safeSelectOptionText(p.persona_nickname ?? "Unknown Persona", 100),
      value: String(p.persona_id),
    }));

    responded = true;
    await interaction.respond(choices);
  } catch {
    if (!responded) {
      try {
        await interaction.respond([]);
      } catch {
        // Autocomplete must fail silently if respond throws
      }
    }
  }
};

/**
 * Executes the /stats persona command: validates the selected persona, loads telemetry,
 * and renders the public stats dashboard.
 */
export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  userData: UserRow,
  locale: string,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.guild_only_title",
      descriptionKey: "general.errors.guild_only_description",
      color: ColorCode.ERROR,
    });
    return;
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const tomoriState = await getCachedTomoriState(guild.id);
    const serverId = tomoriState?.server_id;
    if (!serverId) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.tomori_not_setup_title",
        descriptionKey: "general.errors.tomori_not_setup_description",
        color: ColorCode.ERROR,
      });
      return;
    }

    const personas = await getCachedAllPersonas(guild.id);
    if (personas.length === 0) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.stats.persona.no_personas_title",
        descriptionKey: "commands.stats.persona.no_personas_description",
        color: ColorCode.WARN,
      });
      return;
    }

    const rawPersona = interaction.options.getString("persona");
    const selected = resolveSelectedPersona(personas, rawPersona);
    if (!selected) {
      await replyInfoEmbed(interaction, locale, {
        titleKey: "commands.stats.persona.not_found_title",
        descriptionKey: "commands.stats.persona.not_found_description",
        color: ColorCode.WARN,
      });
      return;
    }

    const timeframe = (interaction.options.getString("timeframe") ??
      statsDashboard.DEFAULT_TIMEFRAME) as statsDashboard.Timeframe;
    const from = statsDashboard.resolveWindowFrom(timeframe);

    const lineageId = selected.persona_lineage_id ?? 0;
    const subtitle = statsDashboard.buildSubtitle(locale, timeframe);
    const tabs = await statsDashboard.buildPersonaTabs({
      locale,
      serverId,
      guildId: guild.id,
      lineageId,
      personaName: selected.persona_nickname,
      timeframe,
      from,
      subtitle: `${selected.persona_nickname} • ${subtitle}`,
    });

    let personaIconUrl: string | undefined;
    let personaIconFile: AttachmentBuilder | undefined;
    if (selected.is_alter) {
      const publicUrl = resolvePersonaAvatarPublicUrl(selected.webhook_avatar_url);
      if (publicUrl) {
        personaIconUrl = publicUrl;
      } else if (selected.webhook_avatar_url && isLocalPersonaAvatarPath(selected.webhook_avatar_url)) {
        const buffer = await loadStoredPersonaAvatarBuffer(selected.webhook_avatar_url);
        if (buffer) {
          const name = "stats_persona_icon.png";
          personaIconFile = new AttachmentBuilder(buffer, { name });
          personaIconUrl = `attachment://${name}`;
        }
      }
    } else {
      personaIconUrl = guild.members.me?.displayAvatarURL({ extension: "png", size: 256 }) ?? undefined;
    }

    await interaction.deleteReply().catch(() => {});
    await statsDashboard.renderStatsDashboardWithReply(
      (payload) => interaction.followUp(payload),
      interaction.id,
      interaction.user.id,
      locale,
      tabs,
      personaIconUrl,
      personaIconFile,
    );
  } catch (error) {
    await log.error(`Error executing /stats persona for user ${userData.user_disc_id}`, error as Error, {
      userId: userData.user_id,
      errorType: "CommandExecutionError",
      metadata: { command: "stats persona" },
    });
  }
}
