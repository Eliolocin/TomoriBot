import type { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";
import { MessageFlags } from "discord.js";
import { commandRegistry } from "@/utils/discord/commandRegistry";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { ColorCode } from "@/utils/misc/logger";

type OpenRouterModelMigrationInteraction = ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction;

export async function replyLegacyOpenRouterOtherModelMoved(
  interaction: OpenRouterModelMigrationInteraction,
  locale: string,
  scopeKind: "server" | "personal",
): Promise<void> {
  const providersCommand =
    scopeKind === "server"
      ? commandRegistry.getCommandMention("providers")
      : commandRegistry.getCommandMention("personal", "providers");

  await replyInfoEmbed(interaction, locale, {
    titleKey: "general.openrouter_model_moved_title",
    descriptionKey: "general.openrouter_model_moved_description",
    descriptionVars: {
      add_command: providersCommand,
      remove_command: providersCommand,
    },
    color: ColorCode.ERROR,
    ...(interaction.deferred || interaction.replied ? {} : { flags: MessageFlags.Ephemeral }),
  });
}
