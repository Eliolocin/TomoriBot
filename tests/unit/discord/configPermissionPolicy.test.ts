/**
 * Permanent permission coverage for the `/config` panel.
 *
 * The bare root registers without a blanket Manage Guild default, so filtering and reauthorization
 * are the only thing standing between an ordinary member and a manager-owned write. This suite
 * drives the real exported policy rather than a mock that would restate the expected answer, and it
 * survives the registration cutover untouched: the loader-topology test cannot prove a permission
 * change it rewrites itself.
 */
import { describe, expect, it } from "bun:test";
import { PermissionsBitField } from "discord.js";
import {
  CONFIG_CATEGORY_ORDER,
  CONFIG_PAGES_BY_CATEGORY,
  CONFIG_ROUTE_CODECS,
  type ConfigCategory,
  type ConfigPage,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import {
  isConfigRouteAuthorized,
  MODELS_PAGE_BY_ROUTE,
  resolveConfigActor,
  resolveConfigCategoryState,
  resolveConfigLanding,
  resolveConfigPageState,
  resolvePersonaAdvancedActionState,
  resolvePersonaOverridesActionState,
  resolvePersonaGeneralActionState,
  resolvePersonaMemoriesActionState,
  resolvePersonaSpritesActionState,
  PERSONA_VOICE_PAGE_BY_ROUTE,
  resolveBehaviorGeneralActionState,
  resolveBehaviorTriggerActionState,
  resolvePermissionsCapabilitiesActionState,
  resolvePermissionsPrivacyActionState,
  resolveChannelsDestinationsActionState,
  resolveChannelsAutoTriggerActionState,
  resolveChannelsRulesActionState,
  resolveChannelsOverridesActionState,
  BEHAVIOR_GENERAL_ACTION_BY_ROUTE,
  BEHAVIOR_TRIGGER_ACTION_BY_ROUTE,
  BEHAVIOR_EXPERIMENTAL_ACTION_BY_ROUTE,
  BEHAVIOR_NOTICES_ACTION_BY_ROUTE,
  BEHAVIOR_MEMORY_ACTION_BY_ROUTE,
  PERMISSIONS_CAPABILITIES_ACTION_BY_ROUTE,
  PERMISSIONS_PRIVACY_ACTION_BY_ROUTE,
  CHANNELS_DESTINATIONS_ACTION_BY_ROUTE,
  CHANNELS_AUTO_TRIGGER_ACTION_BY_ROUTE,
  CHANNELS_RULES_ACTION_BY_ROUTE,
  CHANNELS_OVERRIDES_ACTION_BY_ROUTE,
  visibleConfigCategories,
  visibleConfigPages,
  type ConfigActor,
  type ConfigPersonaGeneralAction,
  type ConfigPersonaOverridesAction,
  type ConfigChannelsDestinationsAction,
  type ConfigChannelsAutoTriggerAction,
  type ConfigChannelsRulesAction,
  type ConfigChannelsOverridesAction,
} from "@/utils/discord/interactions/configPermissionPolicy";

const GUILD_MANAGER: ConfigActor = { workspaceKind: "guild", isManager: true };
const GUILD_MEMBER: ConfigActor = { workspaceKind: "guild", isManager: false };
const DM_OWNER: ConfigActor = { workspaceKind: "dm", isManager: true };

describe("resolveConfigActor", () => {
  it("treats a guild member holding Manage Guild as a manager", () => {
    expect(
      resolveConfigActor({
        guildId: "guild-1",
        memberPermissions: { has: (flag) => flag === PermissionsBitField.Flags.ManageGuild },
      }),
    ).toEqual(GUILD_MANAGER);
  });

  it("treats a guild member without Manage Guild as an ordinary member", () => {
    expect(resolveConfigActor({ guildId: "guild-1", memberPermissions: { has: () => false } })).toEqual(GUILD_MEMBER);
  });

  it("treats a missing member permission set as an ordinary member", () => {
    expect(resolveConfigActor({ guildId: "guild-1", memberPermissions: null })).toEqual(GUILD_MEMBER);
  });

  it("treats an actor outside a guild as the DM workspace owner", () => {
    expect(resolveConfigActor({ guildId: null, memberPermissions: null })).toEqual(DM_OWNER);
  });
});

describe("config category filtering", () => {
  it("opens every category for a guild manager", () => {
    for (const category of CONFIG_CATEGORY_ORDER) {
      expect(resolveConfigCategoryState(category, GUILD_MANAGER)).toBe("enabled");
    }
    expect(visibleConfigCategories(GUILD_MANAGER).every((entry) => !entry.disabled)).toBe(true);
  });

  it("leaves Persona visible but manager-owned categories inert for a guild member", () => {
    expect(resolveConfigCategoryState("persona", GUILD_MEMBER)).toBe("enabled");
    expect(resolveConfigCategoryState("behavior", GUILD_MEMBER)).toBe("disabled");
    expect(resolveConfigCategoryState("channels", GUILD_MEMBER)).toBe("disabled");
    expect(resolveConfigCategoryState("permissions", GUILD_MEMBER)).toBe("disabled");
    expect(resolveConfigCategoryState("models", GUILD_MEMBER)).toBe("disabled");
  });

  it("omits Channels entirely in a DM workspace", () => {
    expect(resolveConfigCategoryState("channels", DM_OWNER)).toBe("omitted");
    expect(visibleConfigCategories(DM_OWNER).map((entry) => entry.category)).not.toContain("channels");
    expect(visibleConfigCategories(DM_OWNER)).toHaveLength(CONFIG_CATEGORY_ORDER.length - 1);
  });
});

describe("config page filtering", () => {
  it("opens every page of every category for a guild manager", () => {
    for (const category of CONFIG_CATEGORY_ORDER) {
      for (const page of CONFIG_PAGES_BY_CATEGORY[category]) {
        expect(resolveConfigPageState(category, page, GUILD_MANAGER)).toBe("enabled");
      }
    }
  });

  it("omits the guild-only pages a DM workspace cannot act on", () => {
    expect(resolveConfigPageState("behavior", "trigger", DM_OWNER)).toBe("omitted");
    expect(resolveConfigPageState("behavior", "memory", DM_OWNER)).toBe("omitted");
    expect(resolveConfigPageState("permissions", "privacy", DM_OWNER)).toBe("omitted");
    expect(resolveConfigPageState("models", "image", DM_OWNER)).toBe("omitted");
    expect(visibleConfigPages("permissions", DM_OWNER)).toEqual(["capabilities"]);
    expect(visibleConfigPages("models", DM_OWNER)).toEqual(["switch", "parameters", "fallbacks", "voices"]);
  });

  it("omits Persona Appearance, Advanced, Overrides, and Voice from a guild member and leaves its siblings readable", () => {
    expect(resolveConfigPageState("persona", "appearance", GUILD_MEMBER)).toBe("omitted");
    expect(resolveConfigPageState("persona", "advanced", GUILD_MEMBER)).toBe("omitted");
    expect(resolveConfigPageState("persona", "overrides", GUILD_MEMBER)).toBe("omitted");
    expect(resolveConfigPageState("persona", "voice", GUILD_MEMBER)).toBe("omitted");
    expect(resolveConfigPageState("persona", "voice", GUILD_MANAGER)).toBe("enabled");
    expect(resolveConfigPageState("persona", "general", GUILD_MEMBER)).toBe("enabled");
    expect(resolveConfigPageState("persona", "memories", GUILD_MEMBER)).toBe("read-only");
    expect(resolveConfigPageState("persona", "sprites", GUILD_MEMBER)).toBe("read-only");
    expect(resolveConfigPageState("persona", "naming", GUILD_MEMBER)).toBe("read-only");
    expect(visibleConfigPages("persona", GUILD_MEMBER)).toEqual([
      "general",
      "triggers",
      "memories",
      "naming",
      "sprites",
    ]);
    expect(visibleConfigPages("persona", GUILD_MANAGER)).toContain("voice");
  });

  it("omits the manager-owned Behavior category for a guild member", () => {
    for (const page of ["general", "trigger", "experimental", "notices", "memory"] as const) {
      expect(resolveConfigPageState("behavior", page, GUILD_MEMBER)).toBe("omitted");
    }
  });

  it("returns no pages at all for a category the actor cannot open", () => {
    expect(visibleConfigPages("channels", GUILD_MEMBER)).toEqual([]);
    expect(visibleConfigPages("channels", DM_OWNER)).toEqual([]);
  });
});

describe("config landing location", () => {
  it("opens every actor on Persona > General", () => {
    for (const actor of [GUILD_MANAGER, GUILD_MEMBER, DM_OWNER]) {
      expect(resolveConfigLanding(actor)).toEqual({ category: "persona", page: "general" });
    }
  });
});

describe("Persona General action policy", () => {
  const allActions: ConfigPersonaGeneralAction[] = [
    "avatar",
    "rename",
    "naming",
    "trigger-add",
    "trigger-remove",
    "promote",
  ];

  it("allows every identity action for a guild manager", () => {
    for (const action of allActions) {
      expect(resolvePersonaGeneralActionState(action, GUILD_MANAGER)).toBe("enabled");
    }
  });

  it("disables trigger and identity actions for an ordinary guild member", () => {
    for (const action of ["avatar", "rename", "naming", "trigger-add", "trigger-remove", "promote"] as const) {
      expect(resolvePersonaGeneralActionState(action, GUILD_MEMBER)).toBe("disabled");
    }
  });

  it("omits the guild-only actions in a DM workspace", () => {
    // `/persona avatar`, both trigger leaves, and `/persona swap` reject a DM outright.
    for (const action of ["avatar", "trigger-add", "trigger-remove", "promote"] as const) {
      expect(resolvePersonaGeneralActionState(action, DM_OWNER)).toBe("omitted");
    }
    expect(resolvePersonaGeneralActionState("rename", DM_OWNER)).toBe("enabled");
    expect(resolvePersonaGeneralActionState("naming", DM_OWNER)).toBe("enabled");
  });
});

describe("Persona Memories action policy", () => {
  it("allows memory reads for members and memory edits for managers or DM owners", () => {
    for (const action of ["server-memory-open", "personal-memory-open"] as const) {
      expect(resolvePersonaMemoriesActionState(action, GUILD_MEMBER)).toBe("enabled");
      expect(resolvePersonaMemoriesActionState(action, DM_OWNER)).toBe("enabled");
    }
    expect(resolvePersonaMemoriesActionState("stm-edit", GUILD_MANAGER)).toBe("enabled");
    expect(resolvePersonaMemoriesActionState("stm-edit", GUILD_MEMBER)).toBe("disabled");
    expect(resolvePersonaMemoriesActionState("stm-edit", DM_OWNER)).toBe("enabled");
  });

  it("omits conditioning from DMs and keeps it manager-only in guilds", () => {
    expect(resolvePersonaMemoriesActionState("conditioning", GUILD_MANAGER)).toBe("enabled");
    expect(resolvePersonaMemoriesActionState("conditioning", GUILD_MEMBER)).toBe("omitted");
    expect(resolvePersonaMemoriesActionState("conditioning", DM_OWNER)).toBe("omitted");
  });
});

describe("Persona Advanced action policy", () => {
  const allActions = ["image-tags", "attg", "character-reference", "prompt", "context-note"] as const;

  it("allows every Advanced action for a guild manager", () => {
    for (const action of allActions) {
      expect(resolvePersonaAdvancedActionState(action, GUILD_MANAGER)).toBe("enabled");
    }
  });

  it("keeps prompt and context note available in DMs", () => {
    for (const action of ["prompt", "context-note"] as const) {
      expect(resolvePersonaAdvancedActionState(action, DM_OWNER)).toBe("enabled");
    }
    expect(resolvePersonaAdvancedActionState("image-tags", DM_OWNER)).toBe("omitted");
    expect(resolvePersonaAdvancedActionState("attg", DM_OWNER)).toBe("omitted");
    expect(resolvePersonaAdvancedActionState("character-reference", DM_OWNER)).toBe("omitted");
  });

  it("omits every Advanced action for a guild member", () => {
    for (const action of allActions) {
      expect(resolvePersonaAdvancedActionState(action, GUILD_MEMBER)).toBe("omitted");
    }
  });
});

describe("Persona Overrides action policy", () => {
  const allActions: ConfigPersonaOverridesAction[] = ["humanizer", "text-override"];

  it("allows every Overrides action for a guild manager and DM owner", () => {
    for (const action of allActions) {
      expect(resolvePersonaOverridesActionState(action, GUILD_MANAGER)).toBe("enabled");
      expect(resolvePersonaOverridesActionState(action, DM_OWNER)).toBe("enabled");
    }
  });

  it("omits every Overrides action for a guild member", () => {
    for (const action of allActions) {
      expect(resolvePersonaOverridesActionState(action, GUILD_MEMBER)).toBe("omitted");
    }
  });
});

describe("Persona Sprites action policy", () => {
  const mutations = ["add", "edit", "remove", "import"] as const;

  it("allows every Sprites action for a guild manager", () => {
    for (const action of [...mutations, "inspect", "export"] as const) {
      expect(resolvePersonaSpritesActionState(action, GUILD_MANAGER)).toBe("enabled");
    }
  });

  it("keeps inspection and Export available to a guild member while disabling every mutation", () => {
    // `/persona sprites export` carries neither a guild nor a Manage Guild gate, so it survives on
    // a page whose own state is read-only.
    expect(resolveConfigPageState("persona", "sprites", GUILD_MEMBER)).toBe("read-only");
    expect(resolvePersonaSpritesActionState("inspect", GUILD_MEMBER)).toBe("enabled");
    expect(resolvePersonaSpritesActionState("export", GUILD_MEMBER)).toBe("enabled");
    for (const action of mutations) {
      expect(resolvePersonaSpritesActionState(action, GUILD_MEMBER)).toBe("disabled");
    }
  });

  it("omits the guild-only mutations in a DM while inspection and Export remain", () => {
    expect(resolvePersonaSpritesActionState("inspect", DM_OWNER)).toBe("enabled");
    expect(resolvePersonaSpritesActionState("export", DM_OWNER)).toBe("enabled");
    for (const action of mutations) {
      expect(resolvePersonaSpritesActionState(action, DM_OWNER)).toBe("omitted");
    }
  });
});

describe("Behavior action policy", () => {
  it("allows global General writes in DMs but omits Timezone", () => {
    for (const action of ["prompt", "context-note", "humanizer", "fetch-limit"] as const) {
      expect(resolveBehaviorGeneralActionState(action, DM_OWNER)).toBe("enabled");
    }
    expect(resolveBehaviorGeneralActionState("timezone", DM_OWNER)).toBe("omitted");
  });

  it("keeps General and Trigger writes manager-only in guilds", () => {
    for (const action of ["prompt", "context-note", "humanizer", "fetch-limit", "timezone"] as const) {
      expect(resolveBehaviorGeneralActionState(action, GUILD_MANAGER)).toBe("enabled");
      expect(resolveBehaviorGeneralActionState(action, GUILD_MEMBER)).toBe("disabled");
    }
    for (const action of [
      "random-add",
      "random-remove",
      "matching-limits",
      "deliberate-trigger-mode",
      "always-reply",
      "cooldown",
    ] as const) {
      expect(resolveBehaviorTriggerActionState(action, GUILD_MANAGER)).toBe("enabled");
      expect(resolveBehaviorTriggerActionState(action, GUILD_MEMBER)).toBe("disabled");
      expect(resolveBehaviorTriggerActionState(action, DM_OWNER)).toBe("omitted");
    }
  });

  it("covers every D10 action with manager, member, and DM policy decisions", () => {
    const routes: ConfigPanelRoute[] = [
      { action: "behavior-tool-mode-set", locale: "en-US", enabled: true },
      { action: "behavior-tool-context-open", locale: "en-US" },
      { action: "behavior-tool-context-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "behavior-tool-trigger-add-open", locale: "en-US" },
      { action: "behavior-tool-trigger-add-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "behavior-tool-trigger-remove-open", locale: "en-US" },
      { action: "behavior-tool-trigger-remove-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "behavior-send-limit-open", locale: "en-US" },
      { action: "behavior-send-limit-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "behavior-self-debug-set", locale: "en-US", enabled: true },
      { action: "behavior-workarounds-open", locale: "en-US" },
      { action: "behavior-workarounds-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "behavior-notice-visibility-open", locale: "en-US" },
      { action: "behavior-notice-visibility-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "behavior-speech-transcripts-set", locale: "en-US", enabled: true },
      { action: "behavior-memory-tagging-open", locale: "en-US" },
      { action: "behavior-memory-tagging-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "behavior-stm-parameters-open", locale: "en-US" },
      { action: "behavior-stm-parameters-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "behavior-stm-categories-open", locale: "en-US" },
      { action: "behavior-stm-categories-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "behavior-stm-prompt-open", locale: "en-US" },
      { action: "behavior-stm-prompt-submit", locale: "en-US", nonce: "nonce1234567" },
    ];
    for (const route of routes) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(
        route.action.startsWith("behavior-notice") || route.action === "behavior-speech-transcripts-set",
      );
    }
  });
});

describe("Permissions action policy", () => {
  it("keeps Bot Capabilities available to DMs and manager-only in guilds", () => {
    for (const action of ["tool-use", "manage"] as const) {
      expect(resolvePermissionsCapabilitiesActionState(action, GUILD_MANAGER)).toBe("enabled");
      expect(resolvePermissionsCapabilitiesActionState(action, GUILD_MEMBER)).toBe("disabled");
      expect(resolvePermissionsCapabilitiesActionState(action, DM_OWNER)).toBe("enabled");
    }
  });

  it("keeps Memory Privacy guild-manager-only and omitted in DMs", () => {
    expect(resolvePermissionsPrivacyActionState("privacy-bypass", GUILD_MANAGER)).toBe("enabled");
    expect(resolvePermissionsPrivacyActionState("privacy-bypass", GUILD_MEMBER)).toBe("disabled");
    expect(resolvePermissionsPrivacyActionState("privacy-bypass", DM_OWNER)).toBe("omitted");
  });

  it("authorizes every permissions route only for its permitted workspace", () => {
    const routes: ConfigPanelRoute[] = [
      { action: "permissions-tool-use-set", locale: "en-US", enabled: true },
      { action: "permissions-manage-open", locale: "en-US" },
      { action: "permissions-manage-submit", locale: "en-US", includeElevenLabs: true, nonce: "nonce1234567" },
      { action: "permissions-privacy-bypass-set", locale: "en-US", enabled: true },
    ];
    for (const route of routes) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(route.action !== "permissions-privacy-bypass-set");
    }
  });
});

describe("Channels Destinations action policy", () => {
  const allActions: ConfigChannelsDestinationsAction[] = ["log", "welcome"];

  it("keeps every Destinations action manager-only and guild-only", () => {
    for (const action of allActions) {
      expect(resolveChannelsDestinationsActionState(action, GUILD_MANAGER)).toBe("enabled");
      expect(resolveChannelsDestinationsActionState(action, GUILD_MEMBER)).toBe("disabled");
      expect(resolveChannelsDestinationsActionState(action, DM_OWNER)).toBe("omitted");
    }
  });

  it("authorizes every Destinations route only for a guild manager", () => {
    const routes: ConfigPanelRoute[] = [
      { action: "channels-log-open", locale: "en-US" },
      { action: "channels-log-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "channels-log-clear", locale: "en-US", channelId: "123456789012345678" },
      { action: "channels-welcome-open", locale: "en-US" },
      { action: "channels-welcome-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "channels-welcome-clear", locale: "en-US", channelId: "123456789012345678" },
    ];
    for (const route of routes) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(false);
    }
  });
});

describe("Channels Auto-Trigger action policy", () => {
  const allActions: ConfigChannelsAutoTriggerAction[] = ["auto-trigger", "threshold"];

  it("keeps every Auto-Trigger action manager-only and guild-only", () => {
    for (const action of allActions) {
      expect(resolveChannelsAutoTriggerActionState(action, GUILD_MANAGER)).toBe("enabled");
      expect(resolveChannelsAutoTriggerActionState(action, GUILD_MEMBER)).toBe("disabled");
      expect(resolveChannelsAutoTriggerActionState(action, DM_OWNER)).toBe("omitted");
    }
  });

  it("authorizes every Auto-Trigger route only for a guild manager", () => {
    const routes: ConfigPanelRoute[] = [
      { action: "channels-autoch-manage-open", locale: "en-US", start: 0 },
      { action: "channels-autoch-submit", locale: "en-US", start: 0, fp: "abcd1234", nonce: "nonce1234567" },
      { action: "channels-autoch-page", locale: "en-US", start: 0 },
      { action: "channels-autoch-configure-open", locale: "en-US" },
      {
        action: "channels-autoch-configure-submit",
        locale: "en-US",
        fp: "abcd1234",
        nonce: "nonce1234567",
      },
      { action: "channels-autoch-threshold-open", locale: "en-US" },
      {
        action: "channels-autoch-threshold-submit",
        locale: "en-US",
        fp: "abcd1234",
        nonce: "nonce1234567",
      },
    ];
    for (const route of routes) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(false);
    }
  });
});

describe("Channels Rules action policy", () => {
  const allActions: ConfigChannelsRulesAction[] = ["private", "roleplay", "blocklist"];

  it("keeps every Rules action manager-only and guild-only", () => {
    for (const action of allActions) {
      expect(resolveChannelsRulesActionState(action, GUILD_MANAGER)).toBe("enabled");
      expect(resolveChannelsRulesActionState(action, GUILD_MEMBER)).toBe("disabled");
      expect(resolveChannelsRulesActionState(action, DM_OWNER)).toBe("omitted");
    }
  });

  it("authorizes every Rules route only for a guild manager", () => {
    const routes: ConfigPanelRoute[] = [
      { action: "channels-private-manage-open", locale: "en-US", start: 0 },
      { action: "channels-private-submit", locale: "en-US", start: 0, fp: "abcd1234", nonce: "nonce1234567" },
      { action: "channels-private-page", locale: "en-US", start: 0 },
      { action: "channels-rp-manage-open", locale: "en-US", start: 0 },
      { action: "channels-rp-submit", locale: "en-US", start: 0, fp: "abcd1234", nonce: "nonce1234567" },
      { action: "channels-rp-page", locale: "en-US", start: 0 },
      { action: "channels-blocklist-manage-open", locale: "en-US", start: 0 },
      {
        action: "channels-blocklist-submit",
        locale: "en-US",
        start: 0,
        fp: "abcd1234",
        nonce: "nonce1234567",
      },
      { action: "channels-blocklist-page", locale: "en-US", start: 0 },
    ];
    for (const route of routes) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(false);
    }
  });
});

describe("Channels Overrides action policy", () => {
  const allActions: ConfigChannelsOverridesAction[] = ["prompt", "context-note", "text-model"];

  it("keeps every Overrides action manager-only and guild-only", () => {
    for (const action of allActions) {
      expect(resolveChannelsOverridesActionState(action, GUILD_MANAGER)).toBe("enabled");
      expect(resolveChannelsOverridesActionState(action, GUILD_MEMBER)).toBe("disabled");
      expect(resolveChannelsOverridesActionState(action, DM_OWNER)).toBe("omitted");
    }
  });

  it("authorizes every Overrides route only for a guild manager", () => {
    const routes: ConfigPanelRoute[] = [
      { action: "channels-overrides-select", locale: "en-US" },
      { action: "channels-overrides-prompt-open", locale: "en-US", channelId: "123456789012345678" },
      {
        action: "channels-overrides-prompt-submit",
        locale: "en-US",
        channelId: "123456789012345678",
        fp: "abcd1234",
        nonce: "nonce1234567",
      },
      {
        action: "channels-overrides-prompt-clear",
        locale: "en-US",
        channelId: "123456789012345678",
        fp: "abcd1234",
      },
      { action: "channels-overrides-context-note-open", locale: "en-US", channelId: "123456789012345678" },
      {
        action: "channels-overrides-context-note-submit",
        locale: "en-US",
        channelId: "123456789012345678",
        fp: "abcd1234",
        nonce: "nonce1234567",
      },
      { action: "channels-overrides-text-open", locale: "en-US", channelId: "123456789012345678" },
      {
        action: "channels-overrides-text-provider-select",
        locale: "en-US",
        channelId: "123456789012345678",
        fp: "abcd1234",
      },
      {
        action: "channels-overrides-text-model-select",
        locale: "en-US",
        channelId: "123456789012345678",
        provider: "openrouter",
        fp: "abcd1234",
      },
      {
        action: "channels-overrides-text-model-page",
        locale: "en-US",
        channelId: "123456789012345678",
        provider: "openrouter",
        start: 0,
      },
      {
        action: "channels-overrides-text-clear",
        locale: "en-US",
        channelId: "123456789012345678",
        fp: "abcd1234",
      },
    ];
    for (const route of routes) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(false);
    }
  });
});

describe("isConfigRouteAuthorized", () => {
  const personaWriteRoutes: ConfigPanelRoute[] = [
    { action: "avatar-open", locale: "en-US", personaId: 5 },
    { action: "avatar-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
    { action: "rename-open", locale: "en-US", personaId: 5 },
    { action: "rename-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
    { action: "naming-open", locale: "en-US", personaId: 5, style: "neutral" },
    { action: "naming-submit", locale: "en-US", personaId: 5, style: "neutral", nonce: "nonce1234567" },
    { action: "promote-view", locale: "en-US", personaId: 5 },
    { action: "promote-confirm", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
  ];

  const triggerRoutes: ConfigPanelRoute[] = [
    { action: "trigger-add-open", locale: "en-US", personaId: 5 },
    { action: "trigger-add-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
    { action: "trigger-remove-open", locale: "en-US", personaId: 5 },
    { action: "trigger-remove-submit", locale: "en-US", personaId: 5, fp: "abcd1234", nonce: "nonce1234567" },
  ];

  const spriteMutationRoutes: ConfigPanelRoute[] = [
    { action: "sprite-add-open", locale: "en-US", personaId: 5 },
    { action: "sprite-add-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
    { action: "sprite-edit-open", locale: "en-US", personaId: 5, index: 0, fp: "abcd1234" },
    { action: "sprite-edit-submit", locale: "en-US", personaId: 5, index: 0, fp: "abcd1234", nonce: "nonce1234567" },
    { action: "sprite-remove-view", locale: "en-US", personaId: 5, index: 0, fp: "abcd1234" },
    {
      action: "sprite-remove-confirm",
      locale: "en-US",
      personaId: 5,
      index: 0,
      fp: "abcd1234",
      nonce: "nonce1234567",
    },
    { action: "sprite-import-open", locale: "en-US", personaId: 5 },
    { action: "sprite-import-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
  ];

  const spriteReadRoutes: ConfigPanelRoute[] = [
    { action: "sprite-select", locale: "en-US", personaId: 5 },
    { action: "sprite-page", locale: "en-US", personaId: 5, start: 25 },
    { action: "sprite-remove-cancel", locale: "en-US", personaId: 5 },
    { action: "sprite-export", locale: "en-US", personaId: 5 },
  ];

  const personaAdvancedRoutes: ConfigPanelRoute[] = [
    { action: "image-tags-open", locale: "en-US", personaId: 5 },
    { action: "image-tags-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
    { action: "attg-open", locale: "en-US", personaId: 5 },
    { action: "attg-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
    { action: "attg-clear-all", locale: "en-US", personaId: 5 },
    { action: "character-reference-open", locale: "en-US", personaId: 5 },
    { action: "character-reference-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
    { action: "character-reference-clear-view", locale: "en-US", personaId: 5 },
    { action: "character-reference-clear-confirm", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
    { action: "character-reference-clear-cancel", locale: "en-US", personaId: 5 },
    { action: "prompt-open", locale: "en-US", personaId: 5 },
    { action: "prompt-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
    { action: "prompt-remove", locale: "en-US", personaId: 5 },
    { action: "context-note-open", locale: "en-US", personaId: 5 },
    { action: "context-note-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
  ];

  const personaOverridesRoutes: ConfigPanelRoute[] = [
    { action: "humanizer-open", locale: "en-US", personaId: 5 },
    { action: "humanizer-select", locale: "en-US", personaId: 5 },
    { action: "humanizer-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
    { action: "text-override-open", locale: "en-US", personaId: 5 },
    { action: "text-override-provider-select", locale: "en-US", personaId: 5 },
    { action: "text-override-model-select", locale: "en-US", personaId: 5, provider: "openrouter" },
    {
      action: "text-override-model-submit",
      locale: "en-US",
      personaId: 5,
      provider: "openrouter",
      nonce: "nonce1234567",
    },
    { action: "text-override-model-page", locale: "en-US", personaId: 5, provider: "openrouter", start: 0 },
    { action: "text-override-clear", locale: "en-US", personaId: 5 },
  ];

  it("refuses a forged sprite mutation replayed by a member or in a DM while Export still lands", () => {
    for (const route of [...spriteMutationRoutes, ...spriteReadRoutes]) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
    }
    for (const route of spriteMutationRoutes) {
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(false);
    }
    // The read-only page must not take Export down with the mutations it disables.
    for (const route of spriteReadRoutes) {
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(true);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(true);
    }
  });

  it("maps Advanced and Overrides routes to their separate page policies", () => {
    for (const route of personaAdvancedRoutes) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      const dmAllowed = route.action.startsWith("prompt-") || route.action.startsWith("context-note-");
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(dmAllowed);
    }
    for (const route of personaOverridesRoutes) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(true);
    }
  });

  it("authorizes every Persona General route for a guild manager", () => {
    for (const route of [...personaWriteRoutes, ...triggerRoutes]) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
    }
  });

  it("refuses a forged manager-owned route replayed by a guild member", () => {
    for (const route of personaWriteRoutes) {
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
    }
    for (const route of triggerRoutes) expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
  });

  it("refuses guild-only routes replayed inside a DM workspace", () => {
    for (const route of triggerRoutes) {
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(false);
    }
    expect(isConfigRouteAuthorized({ action: "avatar-open", locale: "en-US", personaId: 5 }, DM_OWNER)).toBe(false);
    expect(isConfigRouteAuthorized({ action: "rename-open", locale: "en-US", personaId: 5 }, DM_OWNER)).toBe(true);
  });

  it("refuses navigation into a category or page the actor may not open", () => {
    const navigate = (category: ConfigCategory, page: ConfigPage): ConfigPanelRoute => ({
      action: "category",
      locale: "en-US",
      category,
      page,
    });

    expect(isConfigRouteAuthorized(navigate("channels", "destinations"), GUILD_MEMBER)).toBe(false);
    expect(isConfigRouteAuthorized(navigate("models", "switch"), GUILD_MEMBER)).toBe(false);
    expect(isConfigRouteAuthorized(navigate("permissions", "capabilities"), GUILD_MEMBER)).toBe(false);
    expect(isConfigRouteAuthorized(navigate("persona", "advanced"), GUILD_MEMBER)).toBe(false);
    expect(isConfigRouteAuthorized(navigate("persona", "memories"), GUILD_MEMBER)).toBe(true);

    expect(isConfigRouteAuthorized(navigate("channels", "destinations"), DM_OWNER)).toBe(false);
    expect(isConfigRouteAuthorized(navigate("behavior", "trigger"), DM_OWNER)).toBe(false);
    expect(isConfigRouteAuthorized(navigate("models", "image"), DM_OWNER)).toBe(false);
    expect(isConfigRouteAuthorized(navigate("models", "switch"), DM_OWNER)).toBe(true);
  });

  it("allows a member to reach the persona selector that scopes their readable pages", () => {
    expect(isConfigRouteAuthorized({ action: "persona-select", locale: "en-US", personaId: 5 }, GUILD_MEMBER)).toBe(
      true,
    );
    expect(
      isConfigRouteAuthorized({ action: "persona-page", locale: "en-US", personaId: 5, start: 25 }, GUILD_MEMBER),
    ).toBe(true);
  });

  it("keeps Persona Voice routes manager-only in guilds while allowing the DM owner", () => {
    const routes: ConfigPanelRoute[] = [
      { action: "voice-select", locale: "en-US", personaId: 5 },
      { action: "voice-page", locale: "en-US", personaId: 5, start: 0 },
      { action: "voice-chooser-cancel", locale: "en-US", personaId: 5 },
      { action: "voice-clear", locale: "en-US", personaId: 5 },
      { action: "voice-design-open", locale: "en-US", personaId: 5 },
      { action: "voice-design-submit", locale: "en-US", personaId: 5, nonce: "nonce1234567" },
      { action: "voice-design-remove", locale: "en-US", personaId: 5 },
    ];

    for (const route of routes) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(true);
    }
  });

  it("authorizes provider-independent clear through the Models switch page", () => {
    // The clear rides the switch page's provider select now, so that route carries its gate.
    for (const capability of ["image", "nai-image"] as const) {
      const route: ConfigPanelRoute = { action: "model-provider-select", locale: "en-US", capability };
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(true);
    }
    expect(Object.keys(MODELS_PAGE_BY_ROUTE)).toContain("model-provider-select");
  });

  it("authorizes endpoint activation through the Models switch page", () => {
    for (const capability of ["tts", "stt"] as const) {
      const route: ConfigPanelRoute = { action: "endpoint-select", locale: "en-US", capability };
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(true);
    }
    expect(MODELS_PAGE_BY_ROUTE["endpoint-select"]).toBe("switch");
  });

  it("keeps the NovelAI preset selection manager-only and outside DM workspaces", () => {
    const route: ConfigPanelRoute = { action: "nai-preset-select", locale: "en-US", start: 0, fp: "abcd1234" };
    expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
    expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
    expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(false);
    expect(MODELS_PAGE_BY_ROUTE["nai-preset-select"]).toBe("parameters");
  });

  it("keeps every TTS Parameters & Voices route manager-only in a guild and open to a DM owner", () => {
    // These ten absorb /speech leaves that shipped with no handler-level check at all, so the panel
    // route is their entire gate. The DM owner keeps access because the page is workspace scoped.
    const routes: ConfigPanelRoute[] = [
      { action: "tts-parameters-open", locale: "en-US" },
      { action: "tts-parameters-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "tts-turbo-set", locale: "en-US", enabled: true },
      { action: "voice-sample-select", locale: "en-US", start: 0 },
      { action: "voice-sample-page", locale: "en-US", start: 0 },
      { action: "voice-sample-add-open", locale: "en-US" },
      { action: "voice-sample-add-submit", locale: "en-US", nonce: "nonce1234567" },
      { action: "voice-sample-remove-view", locale: "en-US", index: 0, fp: "abcd1234" },
      { action: "voice-sample-remove-confirm", locale: "en-US", index: 0, fp: "abcd1234", nonce: "nonce1234567" },
      { action: "voice-sample-remove-cancel", locale: "en-US" },
    ];

    for (const route of routes) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
      expect(isConfigRouteAuthorized(route, DM_OWNER)).toBe(true);
    }
  });

  it("covers every declared action, so a new route cannot default to authorized", () => {
    // A route added without a policy branch falls through to `false`; this pins that the suite
    // above actually names each action rather than leaving new ones silently denied and untested.
    const covered = new Set<ConfigPanelRoute["action"]>([
      ...personaWriteRoutes.map((route) => route.action),
      ...triggerRoutes.map((route) => route.action),
      "attribute-select",
      "attribute-page",
      "attribute-add-open",
      "attribute-add-submit",
      "attribute-edit-open",
      "attribute-edit-submit",
      "attribute-remove",
      "dialogue-select",
      "dialogue-page",
      "dialogue-add-open",
      "dialogue-add-submit",
      "dialogue-edit-open",
      "dialogue-edit-submit",
      "dialogue-remove",
      "category",
      "page",
      "persona-select",
      "persona-page",
      "naming-style-select",
      "promote-cancel",
      "retry",
      "refresh",
      "server-memory-open",
      "personal-memory-open",
      "stm-edit-open",
      "stm-edit-submit",
      "conditioning-open",
      "conditioning-submit",
      "image-tags-open",
      "image-tags-submit",
      "attg-open",
      "attg-submit",
      "attg-clear-all",
      "character-reference-open",
      "character-reference-submit",
      "character-reference-clear-view",
      "character-reference-clear-confirm",
      "character-reference-clear-cancel",
      "prompt-open",
      "prompt-submit",
      "prompt-remove",
      "context-note-open",
      "context-note-submit",
      "humanizer-open",
      "humanizer-select",
      "humanizer-submit",
      "text-override-open",
      "text-override-provider-select",
      "text-override-model-select",
      "text-override-model-submit",
      "text-override-model-page",
      "text-override-clear",
      ...spriteMutationRoutes.map((route) => route.action),
      ...spriteReadRoutes.map((route) => route.action),
      ...Object.keys(MODELS_PAGE_BY_ROUTE),
      ...Object.keys(BEHAVIOR_GENERAL_ACTION_BY_ROUTE),
      ...Object.keys(BEHAVIOR_TRIGGER_ACTION_BY_ROUTE),
      ...Object.keys(BEHAVIOR_EXPERIMENTAL_ACTION_BY_ROUTE),
      ...Object.keys(BEHAVIOR_NOTICES_ACTION_BY_ROUTE),
      ...Object.keys(BEHAVIOR_MEMORY_ACTION_BY_ROUTE),
      ...Object.keys(PERMISSIONS_CAPABILITIES_ACTION_BY_ROUTE),
      ...Object.keys(PERMISSIONS_PRIVACY_ACTION_BY_ROUTE),
      ...Object.keys(CHANNELS_DESTINATIONS_ACTION_BY_ROUTE),
      ...Object.keys(CHANNELS_AUTO_TRIGGER_ACTION_BY_ROUTE),
      ...Object.keys(CHANNELS_RULES_ACTION_BY_ROUTE),
      ...Object.keys(CHANNELS_OVERRIDES_ACTION_BY_ROUTE),
      ...Object.keys(PERSONA_VOICE_PAGE_BY_ROUTE),
    ]);

    const unknownRoute = { action: "not-a-real-action", locale: "en-US" } as unknown as ConfigPanelRoute;
    expect(isConfigRouteAuthorized(unknownRoute, GUILD_MANAGER)).toBe(false);
    expect([...covered].sort()).toEqual(Object.keys(CONFIG_ROUTE_CODECS).sort());
  });
});
