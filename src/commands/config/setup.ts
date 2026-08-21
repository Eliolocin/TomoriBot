import type { SlashCommandSubcommandBuilder } from "discord.js";
import { localizer } from "@/utils/text/localizer";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("setup").setDescription(localizer("en-US", "commands.setup.description"));

export { execute } from "@/commands/setup";
