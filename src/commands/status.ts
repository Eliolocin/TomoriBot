import type { SlashCommandBuilder } from "discord.js";
import { localizer } from "@/utils/text/localizer";

export const configureCommand = (command: SlashCommandBuilder) =>
  command.setName("status").setDescription(localizer("en-US", "commands.status.description"));

export { executeStatusCommand as execute } from "@/utils/metrics/status/command";
