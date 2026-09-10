import type { ChatInputCommandInteraction, Client, SlashCommandSubcommandBuilder } from "discord.js";
import { startMemoryImport, type MemoryImportDependencies } from "@/commands/import/memoriesImportOperation";
import type { UserRow } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("memories")
    .setDescription(localizer("en-US", "commands.import.memories.description"))
    .addAttachmentOption((option) =>
      option
        .setName("file")
        .setDescription(localizer("en-US", "commands.import.memories.file_description"))
        .setRequired(true),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
  deps: Partial<MemoryImportDependencies> = {},
): Promise<void> {
  await startMemoryImport(interaction, locale, "workspace_memories", deps);
}
