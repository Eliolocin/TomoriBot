import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { runConfigExport, type ConfigExportDependencies } from "@/commands/export/configExportOperation";
import type { UserRow } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand.setName("config").setDescription(localizer("en-US", "commands.export.personal.config.description"));

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
  deps: Partial<ConfigExportDependencies> = {},
): Promise<void> {
  await runConfigExport(interaction, locale, "personal", deps);
}
