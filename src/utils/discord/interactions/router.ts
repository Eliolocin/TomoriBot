import { MessageFlags, type Client, type Interaction } from "discord.js";
import { helpInteractionRoute } from "@/utils/discord/interactions/helpRoutes";
import { mcpsInteractionRoute } from "@/utils/discord/interactions/mcpsRoutes";
import { moderationInteractionRoute } from "@/utils/discord/interactions/moderationRoutes";
import { personalConfigInteractionRoute } from "@/utils/discord/interactions/personalConfigRoutes";
import { personalMemoriesInteractionRoute } from "@/utils/discord/interactions/personalMemoriesRoutes";
import {
  personalProvidersInteractionRoute,
  providersInteractionRoute,
} from "@/utils/discord/interactions/providersRoutes";
import { stPresetsInteractionRoute } from "@/utils/discord/interactions/stPresetsRoutes";
import { InteractionRouteRegistry, type GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const registry = new InteractionRouteRegistry([
  helpInteractionRoute,
  mcpsInteractionRoute,
  moderationInteractionRoute,
  personalConfigInteractionRoute,
  personalMemoriesInteractionRoute,
  personalProvidersInteractionRoute,
  providersInteractionRoute,
  stPresetsInteractionRoute,
]);

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
      const key =
        namespace === "mcps"
          ? "commands.mcps.outdated_panel"
          : namespace === "moderation"
            ? "commands.moderation.outdated_panel"
            : namespace === "st-presets"
              ? "commands.st-presets.outdated_panel"
              : namespace === "providers" || namespace === "personal-providers"
                ? "commands.providers.outdated_panel"
                : namespace === "personal-memories"
                  ? "commands.personal.memories.outdated_panel"
                  : namespace === "personal-config"
                    ? "commands.personal.config.outdated_panel"
                    : "general.errors.outdated_panel";
      const command =
        namespace === "personal-providers"
          ? "/personal providers"
          : namespace === "personal-memories"
            ? "/personal memories"
            : namespace === "personal-config"
              ? "/personal config"
              : `/${namespace}`;
      await interaction.reply({
        content: localizer(interaction.locale ?? interaction.guildLocale ?? "en-US", key, { command }),
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
