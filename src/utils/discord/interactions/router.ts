import { MessageFlags, type Client, type Interaction } from "discord.js";
import { conditioningInteractionRoute } from "@/utils/discord/interactions/conditioningRoutes";
import { configInteractionRoute } from "@/utils/discord/interactions/configRoutes";
import { helpInteractionRoute } from "@/utils/discord/interactions/helpRoutes";
import { memoriesInteractionRoute } from "@/utils/discord/interactions/memoriesRoutes";
import { moderationInteractionRoute } from "@/utils/discord/interactions/moderationRoutes";
import { personalConfigInteractionRoute } from "@/utils/discord/interactions/personalConfigRoutes";
import { personalMemoriesInteractionRoute } from "@/utils/discord/interactions/personalMemoriesRoutes";
import {
  personalProvidersInteractionRoute,
  providersInteractionRoute,
} from "@/utils/discord/interactions/providersRoutes";
import { statusInteractionRoute } from "@/utils/discord/interactions/statusRoutes";
import { statsInteractionRoute } from "@/utils/discord/interactions/statsRoutes";
import { modelOverrideInteractionRoute } from "@/utils/discord/interactions/modelOverrideRoutes";
import { InteractionRouteRegistry, type GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

const registry = new InteractionRouteRegistry([
  conditioningInteractionRoute,
  configInteractionRoute,
  helpInteractionRoute,
  memoriesInteractionRoute,
  modelOverrideInteractionRoute,
  moderationInteractionRoute,
  personalConfigInteractionRoute,
  personalMemoriesInteractionRoute,
  personalProvidersInteractionRoute,
  providersInteractionRoute,
  statusInteractionRoute,
  statsInteractionRoute,
]);

// An unregistered namespace dispatches as unmatched, so rendered controls would otherwise fail silently.
const RETIRED_PANEL_COMMANDS: Readonly<Record<string, string>> = {
  mcps: "/config",
  "st-presets": "/config",
};

export function isGlobalRoutableInteraction(interaction: Interaction): interaction is GlobalRoutableInteraction {
  return interaction.isMessageComponent() || interaction.isModalSubmit();
}

export async function dispatchGlobalInteraction(
  client: Client,
  interaction: GlobalRoutableInteraction,
): Promise<boolean> {
  try {
    const result = await registry.dispatchDetailed(client, interaction);
    if (result === "unmatched") {
      const namespace = interaction.customId.split(":", 1)[0] ?? "";
      const command = RETIRED_PANEL_COMMANDS[namespace];
      if (!command) return false;

      await interaction.reply({
        content: localizer(interaction.locale ?? interaction.guildLocale ?? "en-US", "general.errors.outdated_panel", {
          command,
        }),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (result === "stale-version") {
      const namespace = interaction.customId.split(":", 1)[0] ?? "panel";
      const key =
        namespace === "config"
          ? "commands.config.panel.outdated_panel"
          : namespace === "memories"
            ? "commands.memories.outdated_panel"
            : namespace === "moderation"
              ? "commands.moderation.outdated_panel"
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
              : namespace === "conditioning"
                ? "/conditioning remove"
                : namespace === "model-overrides"
                  ? "/model override remove"
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
