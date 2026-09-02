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
  resolveConfigActor,
  resolveConfigCategoryState,
  resolveConfigLanding,
  resolveConfigPageState,
  resolvePersonaGeneralActionState,
  resolvePersonaMemoriesActionState,
  visibleConfigCategories,
  visibleConfigPages,
  type ConfigActor,
  type ConfigPersonaGeneralAction,
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

  it("leaves manager-owned categories visible but inert for a guild member", () => {
    expect(resolveConfigCategoryState("persona", GUILD_MEMBER)).toBe("enabled");
    expect(resolveConfigCategoryState("behavior", GUILD_MEMBER)).toBe("enabled");
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
    expect(visibleConfigPages("models", DM_OWNER)).toEqual(["switch", "parameters", "fallbacks"]);
  });

  it("omits Persona Advanced from a guild member and leaves its siblings readable", () => {
    expect(resolveConfigPageState("persona", "advanced", GUILD_MEMBER)).toBe("omitted");
    expect(resolveConfigPageState("persona", "general", GUILD_MEMBER)).toBe("enabled");
    expect(resolveConfigPageState("persona", "memories", GUILD_MEMBER)).toBe("read-only");
    expect(resolveConfigPageState("persona", "sprites", GUILD_MEMBER)).toBe("read-only");
    expect(visibleConfigPages("persona", GUILD_MEMBER)).toEqual(["general", "memories", "sprites"]);
  });

  it("keeps Notices writable for a guild member while its Behavior siblings stay read-only", () => {
    expect(resolveConfigPageState("behavior", "notices", GUILD_MEMBER)).toBe("enabled");
    for (const page of ["general", "trigger", "experimental", "memory"] as const) {
      expect(resolveConfigPageState("behavior", page, GUILD_MEMBER)).toBe("read-only");
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

  it("keeps trigger actions member-accessible and disables the manager-owned identity actions", () => {
    // `/persona trigger add|remove` carry no Manage Guild gate today, while `/persona avatar`,
    // `rename`, `naming-habits`, and `swap` all do.
    expect(resolvePersonaGeneralActionState("trigger-add", GUILD_MEMBER)).toBe("enabled");
    expect(resolvePersonaGeneralActionState("trigger-remove", GUILD_MEMBER)).toBe("enabled");
    for (const action of ["avatar", "rename", "naming", "promote"] as const) {
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

  it("authorizes every Persona General route for a guild manager", () => {
    for (const route of [...personaWriteRoutes, ...triggerRoutes]) {
      expect(isConfigRouteAuthorized(route, GUILD_MANAGER)).toBe(true);
    }
  });

  it("refuses a forged manager-owned route replayed by a guild member", () => {
    for (const route of personaWriteRoutes) {
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(false);
    }
    for (const route of triggerRoutes) {
      expect(isConfigRouteAuthorized(route, GUILD_MEMBER)).toBe(true);
    }
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
    ]);

    const unknownRoute = { action: "not-a-real-action", locale: "en-US" } as unknown as ConfigPanelRoute;
    expect(isConfigRouteAuthorized(unknownRoute, GUILD_MANAGER)).toBe(false);
    expect([...covered].sort()).toEqual(Object.keys(CONFIG_ROUTE_CODECS).sort());
  });
});
