/**
 * Proves the /bot dissolution landed: /generate scene is reachable at its new path, the root is gone,
 * and the relocated locale namespace resolves.
 *
 * The description assertions are the ones that matter: a namespace relocation that missed a tree
 * would register the literal key string as the Discord description, which check-locales cannot see
 * because the loader assembles subcommand description keys from tree position rather than referencing
 * them directly.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const RELOCATED_DESCRIPTION_KEYS = ["commands.generate.scene.description"];

describe("Dissolved /bot subcommand registration", () => {
  it("registers /generate scene as a subcommand under /generate", async () => {
    const { executionMap } = await loadCommandData();
    const generateCommands = executionMap.get("generate");

    expect(generateCommands).toBeDefined();
    expect(generateCommands?.has("scene")).toBe(true);
    expect(generateCommands?.has("image")).toBe(true);
    expect(generateCommands?.has("video")).toBe(true);
  }, 30000);

  it("removes the /bot root from both the registration payload and the execution map", async () => {
    const { registrationData, executionMap } = await loadCommandData();

    expect(registrationData.find((command) => command.name === "bot")).toBeUndefined();
    expect(executionMap.get("bot")).toBeUndefined();
  }, 30000);

  it("resolves the relocated description key in both locales without returning the key path", () => {
    for (const key of RELOCATED_DESCRIPTION_KEYS) {
      for (const locale of ["en-US", "ja"]) {
        const resolved = localizer(locale, key);

        expect(resolved).not.toBe(key);
        expect(resolved.startsWith("commands.")).toBe(false);
        expect(resolved.length).toBeGreaterThan(0);
      }
    }
  });

  it("registers the relocated description as real text rather than a locale key", async () => {
    const { registrationData } = await loadCommandData();

    const registeredDescription = (rootName: string, subcommandName: string): string | undefined => {
      const root = registrationData.find((command) => command.name === rootName);
      const subcommand = root?.options?.find(
        (option: import("discord.js").APIApplicationCommandOption) => option.name === subcommandName,
      );
      return (subcommand as { description?: string } | undefined)?.description;
    };

    const description = registeredDescription("generate", "scene");
    expect(description).toBeDefined();
    expect(description?.startsWith("commands.")).toBe(false);
  }, 30000);
});
