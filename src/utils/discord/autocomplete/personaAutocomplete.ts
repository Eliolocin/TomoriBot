import type { AutocompleteInteraction, Client } from "discord.js";
import { userRepository } from "@/utils/db/repositories";
import { getCachedWhitelistStatus } from "@/utils/cache/channelWhitelistCache";
import { getCachedPersonalSpotlightStatus } from "@/utils/cache/personalSpotlightCache";
import { filterPersonasForTrigger } from "@/utils/persona/personaAccess";
import { safeSelectOptionText } from "@/utils/discord/ui/interactionCore";
import type { CommandAutocompleteFunction } from "@/utils/discord/commandLoader";

import { getCachedTomoriState, getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";

/**
 * Shaped as `CommandAutocompleteFunction` so a module can export it directly. The client is unused
 * but must stay in the signature: a shorter one still assigns cleanly and would silently receive
 * the client as its first argument.
 */
export const handlePersonaAutocomplete: CommandAutocompleteFunction = async (
  _client: Client,
  interaction: AutocompleteInteraction,
): Promise<void> => {
  try {
    if (!interaction.guild || !interaction.channel) {
      await interaction.respond([]);
      return;
    }

    const tomoriState = await getCachedTomoriState(interaction.guild.id);
    if (!tomoriState) {
      await interaction.respond([]);
      return;
    }

    const allPersonas = await getCachedAllPersonas(interaction.guild.id);
    if (allPersonas.length === 0) {
      await interaction.respond([]);
      return;
    }

    const invokingMember = interaction.guild.members.cache.get(interaction.user.id);
    const memberRoleDiscIds = invokingMember?.roles.cache.map((role) => role.id);

    const guildChannel = interaction.guild.channels.cache.get(interaction.channel.id) ?? interaction.channel;
    const isThread =
      "isThread" in guildChannel && typeof guildChannel.isThread === "function" && guildChannel.isThread();
    const parentChannelId = isThread && "parent" in guildChannel ? guildChannel.parent?.id : undefined;

    const whitelistStatus = await getCachedWhitelistStatus(
      interaction.guild.id,
      interaction.channel.id,
      memberRoleDiscIds,
      parentChannelId,
    );

    const userRow = await userRepository.loadByDiscordId(interaction.user.id);
    const personalSpotlightStatus = userRow?.user_id
      ? await getCachedPersonalSpotlightStatus(
          tomoriState.server_id,
          userRow.user_id,
          parentChannelId ?? interaction.channel.id,
        )
      : null;

    const eligiblePersonas = filterPersonasForTrigger(allPersonas, whitelistStatus, personalSpotlightStatus);

    if (eligiblePersonas.length === 0) {
      await interaction.respond([]);
      return;
    }

    const focusedOption = interaction.options.getFocused();
    const focusedValue = (focusedOption || "").toLowerCase();

    let filtered = eligiblePersonas;
    if (focusedValue) {
      const exact: typeof eligiblePersonas = [];
      const prefix: typeof eligiblePersonas = [];
      const substring: typeof eligiblePersonas = [];

      for (const p of eligiblePersonas) {
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

    await interaction.respond(choices);
  } catch (error) {
    // Autocomplete must always answer, even on failure.
    try {
      await interaction.respond([]);
    } catch {
      // The dispatcher still logs and attempts its own fallback answer.
    }
    throw error;
  }
};
