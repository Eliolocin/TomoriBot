import { MessageFlags, type Client, type Interaction } from "discord.js";
import { helpInteractionRoute } from "@/utils/discord/interactions/helpRoutes";
import { InteractionRouteRegistry, type GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const registry = new InteractionRouteRegistry([helpInteractionRoute]);

export function isGlobalRoutableInteraction(interaction: Interaction): interaction is GlobalRoutableInteraction {
  return interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit();
}

export async function dispatchGlobalInteraction(
  client: Client,
  interaction: GlobalRoutableInteraction,
): Promise<boolean> {
  try {
    return await registry.dispatch(client, interaction);
  } catch (error) {
    await log.error("Global interaction route failed", error, {
      errorType: "InteractionRouteError",
      metadata: {
        customId: interaction.customId,
        interactionId: interaction.id,
        userDiscordId: interaction.user.id,
      },
    });

    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: localizer(
            interaction.locale ?? interaction.guildLocale ?? "en-US",
            "general.errors.unknown_error_description",
          ),
          flags: MessageFlags.Ephemeral,
        });
      } catch (replyError) {
        log.warn("Global interaction route error reply failed", replyError);
      }
    }
    return true;
  }
}
