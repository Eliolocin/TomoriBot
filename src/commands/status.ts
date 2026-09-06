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
          { name: localizer("en-US", "commands.status.scope_choice_persona"), value: "persona" },
          { name: localizer("en-US", "commands.status.scope_choice_behavior"), value: "behavior" },
          { name: localizer("en-US", "commands.status.scope_choice_models"), value: "models" },
          { name: localizer("en-US", "commands.status.scope_choice_access"), value: "access" },
          { name: localizer("en-US", "commands.status.scope_choice_personal"), value: "personal" },
        ),
    );

export { executeStatusCommand as execute } from "@/utils/metrics/status/command";
