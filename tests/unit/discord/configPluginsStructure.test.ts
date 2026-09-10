import { beforeAll, describe, expect, it } from "bun:test";
import {
  CONFIG_CATEGORY_ORDER,
  CONFIG_PAGES_BY_CATEGORY,
  type ConfigCategory,
} from "@/utils/discord/configPanelCatalog";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { visibleConfigPages } from "@/utils/discord/interactions/configPermissionPolicy";
import { getCapabilitiesManagePermissionDefinitions } from "@/utils/discord/manageConfigMapping";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const EXPECTED_PLUGIN_PAGES = [
  "available-tools",
  "context-additions",
  "mcp-servers",
  "sillytavern-presets",
  "nsfw-jailbreaks",
] as const;

const EXPECTED_CAPABILITY_PAGE_BY_VALUE = {
  selfteaching: "available-tools",
  personalization: "context-additions",
  userinfo: "available-tools",
  emojiusage: "context-additions",
  stickerusage: "available-tools",
  websearch: "available-tools",
  managemessage: "available-tools",
  threadcreation: "available-tools",
  imagegen: "available-tools",
  videogen: "available-tools",
  voicemessage: "available-tools",
  userblocking: "available-tools",
  shorttermmemory: "context-additions",
  timeawareness: "context-additions",
} as const;

describe("W6-18 Config Plugins structure", () => {
  it("pins the category and page taxonomy before the renderer is rewritten", () => {
    expect(CONFIG_CATEGORY_ORDER).toEqual(["persona", "behavior", "plugins", "channels", "models"]);
    const pluginPages = (CONFIG_PAGES_BY_CATEGORY as Record<string, readonly string[]>).plugins;
    expect(pluginPages.slice(0, 2)).toEqual(EXPECTED_PLUGIN_PAGES.slice(0, 2));
    expect(pluginPages).toEqual(EXPECTED_PLUGIN_PAGES.filter((page) => pluginPages.includes(page)));
    expect(CONFIG_PAGES_BY_CATEGORY.channels).toEqual(["destinations", "auto-trigger", "rules", "overrides"]);
    expect(Object.values(CONFIG_PAGES_BY_CATEGORY).flat()).not.toContain("privacy");
  });

  it("pins one explicit page owner for every persisted capability toggle", () => {
    const actual = Object.fromEntries(
      getCapabilitiesManagePermissionDefinitions({ includeElevenLabs: true }).map((definition) => [
        definition.value,
        Reflect.get(definition, "page"),
      ]),
    );

    expect(actual).toEqual(EXPECTED_CAPABILITY_PAGE_BY_VALUE);
  });

  it("keeps every Plugins page visible to the owner of a DM workspace", () => {
    const pluginPages = (CONFIG_PAGES_BY_CATEGORY as Record<string, readonly string[]>).plugins;
    expect(
      visibleConfigPages("plugins" as ConfigCategory, {
        workspaceKind: "dm",
        isManager: true,
      }),
    ).toEqual(pluginPages);
  });

  it("dissolves both absorbed roots once Plugins owns their pages", async () => {
    const { registrationData, executionMap } = await loadCommandData();
    const names = registrationData.map((command) => command.name);

    expect(names).not.toContain("mcps");
    expect(names).not.toContain("st-presets");
    expect(executionMap.has("mcps")).toBe(false);
    expect(executionMap.has("st-presets")).toBe(false);
  });
});
