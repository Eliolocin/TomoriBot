import { beforeAll, describe, expect, it } from "bun:test";
import { ApplicationCommandOptionType, type ApplicationCommandData } from "discord.js";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const UNRESOLVED_LOCALE_KEY_PATTERN = /^commands\.[a-zA-Z0-9_.-]+$/;

/**
 * Known unresolved descriptions scheduled for dissolution in the current wave.
 * - "bot": The /bot root is being dissolved across Wave 1; delete this entry when /bot is removed.
 */
const DISSOLUTION_ALLOWLIST = new Set<string>(["bot"]);

type OffendingDescription = {
  path: string;
  description: string;
};

type CommandOption = {
  name?: string;
  description?: string;
  type?: number;
  options?: CommandOption[];
};

function collectUnresolvedDescriptions(
  commands: ApplicationCommandData[],
  allowlist: Set<string> = DISSOLUTION_ALLOWLIST,
): OffendingDescription[] {
  const offending: OffendingDescription[] = [];

  for (const command of commands) {
    const rootPath = command.name;
    if (command.description && UNRESOLVED_LOCALE_KEY_PATTERN.test(command.description) && !allowlist.has(rootPath)) {
      offending.push({ path: rootPath, description: command.description });
    }

    const options = Array.isArray(command.options) ? (command.options as CommandOption[]) : [];
    for (const option of options) {
      if (!option.name) continue;

      if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
        const groupPath = `${rootPath} ${option.name}`;
        if (option.description && UNRESOLVED_LOCALE_KEY_PATTERN.test(option.description) && !allowlist.has(groupPath)) {
          offending.push({ path: groupPath, description: option.description });
        }

        for (const subOption of option.options ?? []) {
          if (!subOption.name) continue;
          if (subOption.type === ApplicationCommandOptionType.Subcommand) {
            const subPath = `${groupPath} ${subOption.name}`;
            if (
              subOption.description &&
              UNRESOLVED_LOCALE_KEY_PATTERN.test(subOption.description) &&
              !allowlist.has(subPath)
            ) {
              offending.push({ path: subPath, description: subOption.description });
            }
          }
        }
      } else if (option.type === ApplicationCommandOptionType.Subcommand) {
        const subPath = `${rootPath} ${option.name}`;
        if (option.description && UNRESOLVED_LOCALE_KEY_PATTERN.test(option.description) && !allowlist.has(subPath)) {
          offending.push({ path: subPath, description: option.description });
        }
      }
    }
  }

  return offending;
}

describe("Command description resolution gate", () => {
  it("registers no unresolved locale keys as command descriptions across roots, groups, and subcommands", async () => {
    const { registrationData } = await loadCommandData();
    const offending = collectUnresolvedDescriptions(registrationData);

    expect(offending).toEqual([]);
  });

  it("fails when an allowlisted path is checked without the allowlist", async () => {
    const { registrationData } = await loadCommandData();
    const offendingWithoutAllowlist = collectUnresolvedDescriptions(registrationData, new Set());

    const offendingPaths = offendingWithoutAllowlist.map((item) => item.path);
    expect(offendingPaths).toContain("bot");
  });
});
