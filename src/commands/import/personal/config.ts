import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { startConfigImport, type ConfigImportDependencies } from "@/commands/import/configImportOperation";
import type { UserRow } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("config")
    .setDescription(localizer("en-US", "commands.import.personal.config.description"))
    .addAttachmentOption((option) =>
      option
        .setName("file")
        .setDescription(localizer("en-US", "commands.import.personal.config.file_description"))
        .setRequired(true),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
  deps: Partial<ConfigImportDependencies> = {},
): Promise<void> {
  await startConfigImport(interaction, locale, "personal_config", deps);
}
