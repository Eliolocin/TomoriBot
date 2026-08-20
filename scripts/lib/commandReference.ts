import { join } from "node:path";
import { ApplicationCommandOptionType, type ApplicationCommandData } from "discord.js";
import { loadCommandData } from "../../src/utils/discord/commandLoader";
import { initializeLocalizer } from "../../src/utils/text/localizer";

export const COMMAND_REFERENCE_PATH = join(process.cwd(), "docs", "en", "features", "command-reference.md");

type CommandOption = {
  name?: string;
  description?: string;
  type?: number;
  options?: CommandOption[];
};

type NamedCommandOption = CommandOption & { name: string };

type RunnableCommand = {
  path: string;
  description: string;
};

type CommandGroup = {
  name: string;
  description: string;
  commands: RunnableCommand[];
};

function asCommandOptions(command: ApplicationCommandData): CommandOption[] {
  return Array.isArray(command.options) ? (command.options as CommandOption[]) : [];
}

function isNamedCommandOption(option: CommandOption): option is NamedCommandOption {
  return typeof option.name === "string";
}

function escapeTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br />").trim();
}

function humanizeCommandName(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatGroupDescription(group: CommandGroup): string {
  if (group.description) {
    return group.description;
  }

  return `${humanizeCommandName(group.name)} commands.`;
}

function formatCommandPath(path: string): string {
  return `\`/${path}\``;
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function getSubcommandOptions(command: ApplicationCommandData): NamedCommandOption[] {
  return asCommandOptions(command).filter(
    (option): option is NamedCommandOption =>
      isNamedCommandOption(option) &&
      (option.type === ApplicationCommandOptionType.Subcommand ||
        option.type === ApplicationCommandOptionType.SubcommandGroup),
  );
}

function flattenRunnableCommands(command: ApplicationCommandData): RunnableCommand[] {
  const subcommandOptions = getSubcommandOptions(command);

  if (subcommandOptions.length === 0) {
    return [
      {
        path: command.name,
        description: command.description ?? "",
      },
    ];
  }

  const rows: RunnableCommand[] = [];

  for (const option of sortByName(subcommandOptions)) {
    if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
      const groupSubcommands = (option.options ?? []).filter(
        (subcommand): subcommand is NamedCommandOption =>
          isNamedCommandOption(subcommand) && subcommand.type === ApplicationCommandOptionType.Subcommand,
      );

      for (const subcommand of sortByName(groupSubcommands)) {
        rows.push({
          path: `${command.name} ${option.name} ${subcommand.name}`,
          description: subcommand.description ?? "",
        });
      }
      continue;
    }

    rows.push({
      path: `${command.name} ${option.name}`,
      description: option.description ?? "",
    });
  }

  return rows;
}

function buildGroups(commands: ApplicationCommandData[]): CommandGroup[] {
  return sortByName(
    commands.map((command) => ({
      name: command.name,
      description: command.description ?? "",
      commands: flattenRunnableCommands(command),
    })),
  );
}

function renderGroup(group: CommandGroup): string {
  const lines = [
    `## ${formatCommandPath(group.name)}`,
    "",
    formatGroupDescription(group),
    "",
    "| Command | Summary |",
    "|---|---|",
  ];

  for (const command of group.commands) {
    lines.push(`| ${formatCommandPath(command.path)} | ${escapeTableCell(command.description || "No description provided.")} |`);
  }

  return lines.join("\n");
}

/**
 * Every slash path a user can legitimately be told to type, including the intermediate
 * root and group prefixes that prose often names on their own ("configure it under `/config`").
 *
 * Shares `buildGroups` with the reference generator so the two can never disagree about
 * what is registered.
 */
export async function collectValidCommandPaths(): Promise<Set<string>> {
  await initializeLocalizer();
  const { registrationData } = await loadCommandData();
  const paths = new Set<string>();

  for (const group of buildGroups(registrationData)) {
    paths.add(group.name);
    for (const command of group.commands) {
      const segments = command.path.split(" ");
      for (let length = 1; length <= segments.length; length++) {
        paths.add(segments.slice(0, length).join(" "));
      }
    }
  }

  return paths;
}

export async function generateCommandReferenceMarkdown(): Promise<string> {
  await initializeLocalizer();
  const { registrationData } = await loadCommandData();
  const groups = buildGroups(registrationData);
  const runnableCommandCount = groups.reduce((total, group) => total + group.commands.length, 0);

  return `---
title: "Command Reference"
sidebar:
  order: 6
---

<!--
  GENERATED FILE: do not edit by hand.
  Run \`bun run generate-command-reference\` from the repository root.
-->

Every slash command currently registered by TomoriBot, generated from the same command builders and English locale descriptions used for Discord registration.

Top-level command groups: **${groups.length}**. Runnable slash commands: **${runnableCommandCount}**.

${groups.map(renderGroup).join("\n\n")}
`;
}

export async function writeCommandReference(): Promise<void> {
  const markdown = await generateCommandReferenceMarkdown();
  await Bun.write(COMMAND_REFERENCE_PATH, markdown);
}
