import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  SlashCommandSubcommandBuilder,
} from "discord.js";
import {
  type MemoryExportDependencies,
  WORKSPACE_MEMORY_EXPORT_SELECTIONS,
  respondWithMemoryExportPersonas,
  runMemoryExport,
} from "@/commands/export/memoriesExportOperation";
import type { UserRow } from "@/types/db/schema";
import { localizer } from "@/utils/text/localizer";

export const configureSubcommand = (subcommand: SlashCommandSubcommandBuilder) =>
  subcommand
    .setName("memories")
    .setDescription(localizer("en-US", "commands.export.memories.description"))
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription(localizer("en-US", "commands.export.memories.scope_description"))
        .setRequired(true)
        .addChoices(
          ...WORKSPACE_MEMORY_EXPORT_SELECTIONS.map((value) => ({
            name: localizer("en-US", `commands.export.memories.scope_choice_${value}`),
            value,
          })),
        ),
    )
    .addStringOption((option) =>
      option
        .setName("persona")
        .setDescription(localizer("en-US", "commands.export.memories.persona_description"))
        .setRequired(false)
        .setAutocomplete(true),
    );

export async function execute(
  _client: Client,
  interaction: ChatInputCommandInteraction,
  _userData: UserRow,
  locale: string,
  deps: Partial<MemoryExportDependencies> = {},
): Promise<void> {
  await runMemoryExport(
    interaction,
    locale,
    "workspace",
    interaction.options.getString("scope"),
    interaction.options.getString("persona"),
    deps,
  );
}

export const autocomplete = async (_client: Client, interaction: AutocompleteInteraction): Promise<void> =>
  respondWithMemoryExportPersonas(interaction);
