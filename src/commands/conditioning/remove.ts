import type { SlashCommandSubcommandBuilder } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { executeConditioningRemovalCommand } from "@/utils/conditioning/conditioningCommandHelper";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("remove").setDescription(localizer("en-US", "commands.conditioning.remove.description"));

export const execute = executeConditioningRemovalCommand;
