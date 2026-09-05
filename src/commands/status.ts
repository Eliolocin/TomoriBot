import type { SlashCommandBuilder } from "discord.js";
import { localizer } from "@/utils/text/localizer";

export const configureCommand = (command: SlashCommandBuilder) =>
  command
    .setName("status")
    .setDescription(localizer("en-US", "commands.status.description"))
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.status.scope_description"))
        .setRequired(true)
        .addChoices(
          { name: localizer("en-US", "commands.status.scope_choice_server_model"), value: "server_model" },
          { name: localizer("en-US", "commands.status.scope_choice_server_config"), value: "server_config" },
          { name: localizer("en-US", "commands.status.scope_choice_server_channels"), value: "server_channels" },
          { name: localizer("en-US", "commands.status.scope_choice_personal"), value: "personal" },
          { name: localizer("en-US", "commands.status.scope_choice_persona"), value: "persona" },
        ),
    );

export { executeStatusCommand as execute } from "@/utils/metrics/status/command";
