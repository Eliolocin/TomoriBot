import { MessageFlags, type Client, type Interaction } from "discord.js";
import { helpInteractionRoute } from "@/utils/discord/interactions/helpRoutes";
import { mcpsInteractionRoute } from "@/utils/discord/interactions/mcpsRoutes";
import { InteractionRouteRegistry, type GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const registry = new InteractionRouteRegistry([helpInteractionRoute, mcpsInteractionRoute]);

export function isGlobalRoutableInteraction(interaction: Interaction): interaction is GlobalRoutableInteraction {
  return interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit();
}

export async function dispatchGlobalInteraction(
  client: Client,
  interaction: GlobalRoutableInteraction,
): Promise<boolean> {
  try {
    const result = await registry.dispatchDetailed(client, interaction);
    if (result === "unmatched") return false;
    if (result === "stale-version") {
      const namespace = interaction.customId.split(":", 1)[0] ?? "panel";
      await interaction.reply({
        content: localizer(
          interaction.locale ?? interaction.guildLocale ?? "en-US",
          namespace === "mcps" ? "commands.mcps.outdated_panel" : "general.errors.outdated_panel",
          { command: `/${namespace}` },
        ),
        flags: MessageFlags.Ephemeral,
      });
    }
    return true;
  } catch (error) {
    await log.error("Global interaction route failed", error, {
      errorType: "InteractionRouteError",
      metadata: {
        customId: interaction.customId,
        interactionId: interaction.id,
        userDiscordId: interaction.user.id,
      },
    });

    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: localizer(
            interaction.locale ?? interaction.guildLocale ?? "en-US",
            "general.errors.unknown_error_description",
          ),
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.followUp({
          content: localizer(
            interaction.locale ?? interaction.guildLocale ?? "en-US",
            "general.errors.unknown_error_description",
          ),
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyError) {
      log.warn("Global interaction route error reply failed", replyError);
    }
    return true;
  }
}
