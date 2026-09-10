/**
 * Proves the /bot dissolution still holds after scene visualization is consolidated into
 * /generate image: /tool visualize is gone, /generate image and /generate scene remain reachable,
 * the /bot root stays dissolved, and the relocated locale namespaces still resolve.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const RELOCATED_DESCRIPTION_KEYS = ["commands.tool.visualize.description", "commands.generate.scene.description"];

describe("Dissolved /bot subcommand registration", () => {
  it("removes /tool visualize while retaining /generate image", async () => {
    const { executionMap } = await loadCommandData();
    const toolCommands = executionMap.get("tool");
    const generateCommands = executionMap.get("generate");

    expect(toolCommands).toBeDefined();
    expect(toolCommands?.has("visualize")).toBe(false);
    expect(generateCommands).toBeDefined();
    expect(generateCommands?.has("image")).toBe(true);
  }, 30000);

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

  it("resolves both relocated description keys in both locales without returning the key path", () => {
    for (const key of RELOCATED_DESCRIPTION_KEYS) {
      for (const locale of ["en-US", "ja"]) {
        const resolved = localizer(locale, key);

        expect(resolved).not.toBe(key);
        expect(resolved.startsWith("commands.")).toBe(false);
        expect(resolved.length).toBeGreaterThan(0);
      }
    }
  });

  it("registers generate descriptions as real text and leaves visualize unregistered", async () => {
    const { registrationData } = await loadCommandData();

    const registeredDescription = (rootName: string, subcommandName: string): string | undefined => {
      const root = registrationData.find((command) => command.name === rootName);
      const subcommand = root?.options?.find(
        (option: import("discord.js").APIApplicationCommandOption) => option.name === subcommandName,
      );
      return (subcommand as { description?: string } | undefined)?.description;
    };

    expect(registeredDescription("tool", "visualize")).toBeUndefined();

    for (const description of [
      registeredDescription("generate", "image"),
      registeredDescription("generate", "scene"),
    ]) {
      expect(description).toBeDefined();
      expect(description?.startsWith("commands.")).toBe(false);
    }
  }, 30000);
});
