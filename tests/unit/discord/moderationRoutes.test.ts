import { beforeAll, describe, expect, it } from "bun:test";
import {
  ChannelType,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { CooldownType } from "@/types/db/schema";
import {
  buildInitialModerationPanel,
  createModerationInteractionRoute,
  executeModerationCommand,
  type ModerationRouteDependencies,
} from "@/utils/discord/interactions/moderationRoutes";
import { dispatchGlobalInteraction } from "@/utils/discord/interactions/router";
import { moderationOperations, type ModerationScopeData } from "@/utils/moderation/moderationOperations";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function createScopeData(overrides: Partial<ModerationScopeData> = {}): ModerationScopeData {
  return {
    guildId: "guild-1",
    serverId: 1,
    readStatus: "fresh",
    memberAccess: {
      serverMemteachingEnabled: true,
      attributeMemteachingEnabled: false,
      sampledialogueMemteachingEnabled: true,
      promptSnapshotEnabled: false,
    },
    userBlacklist: {
      personalizationUserIds: ["u1"],
      personaBlocks: [],
      personalMemoriesEnabled: true,
    },
    whitelist: {
      channels: [],
      personaChannels: [],
      roles: [],
      personaNames: new Map(),
    },
    ...overrides,
  };
}

describe("moderation interaction routes", () => {
  it("acknowledges with deferUpdate and repaints on category switch without writing to database", async () => {
    const log: string[] = [];
    const editReplyCalls: unknown[] = [];

    const mockInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "moderation:v1:category:en-US:user-blacklist",
      guildId: "guild-1",
      memberPermissions: {
        has: (perm: string) => perm === "ManageGuild",
      },
      deferUpdate: async () => {
        log.push("deferUpdate");
      },
      editReply: async (payload: unknown) => {
        log.push("editReply");
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const deps: ModerationRouteDependencies = {
      resolveScope: async (_interaction, forceRefresh) => {
        log.push(forceRefresh ? "load-refresh" : "load");
        return createScopeData();
      },
    };

    const route = createModerationInteractionRoute(deps);
    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["category", "en-US", "user-blacklist"],
    });

    expect(log).toEqual(["deferUpdate", "load", "editReply"]);
    const serialized = JSON.stringify(editReplyCalls[0]);
    expect(serialized).toContain("User Blacklist");
  });

  it("handles page select menu interactions", async () => {
    const editReplyCalls: unknown[] = [];
    const mockInteraction = {
      isButton: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      customId: "moderation:v1:select-page:en-US",
      values: ["roles"],
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as StringSelectMenuInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async () => createScopeData(),
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["select-page", "en-US"],
    });

    const serialized = JSON.stringify(editReplyCalls[0]);
    expect(serialized).toContain("Whitelisted Roles");
  });

  it("handles range navigation route", async () => {
    const editReplyCalls: unknown[] = [];
    const mockInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "moderation:v1:range:en-US:user-blacklist:none:1",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async () => createScopeData(),
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["range", "en-US", "user-blacklist", "none", "1"],
    });

    expect(editReplyCalls).toHaveLength(1);
  });

  it("clamps out-of-range route when rows disappear and visibly renders the surviving row", async () => {
    const editReplyCalls: unknown[] = [];
    const mockInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "moderation:v1:range:en-US:user-blacklist:none:99",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const scopeWithSingleRow: ModerationScopeData = {
      ...createScopeData(),
      userBlacklist: {
        personalizationUserIds: ["surviving-member-123"],
        personaBlocks: [],
      },
    };

    const route = createModerationInteractionRoute({
      resolveScope: async () => scopeWithSingleRow,
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["range", "en-US", "user-blacklist", "none", "99"],
    });

    expect(editReplyCalls).toHaveLength(1);
    const serialized = JSON.stringify(editReplyCalls[0]);
    expect(serialized).toContain("surviving-member-123");
  });

  it("does not invoke write operations during navigation routes", async () => {
    let updateCalled = 0;
    const route = createModerationInteractionRoute({
      resolveScope: async () => createScopeData(),
      operations: {
        updateMemberPermissions: async () => {
          updateCalled++;
          return { status: "success", changes: [], patch: {} };
        },
      },
    });

    const editReplyCalls: unknown[] = [];
    const mockInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "moderation:v1:category:en-US:whitelist",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["category", "en-US", "whitelist"],
    });

    expect(editReplyCalls).toHaveLength(1);
    expect(updateCalled).toBe(0);
  });

  it("denies member-access-open when user lacks Manage Server without reading state or showing modal", async () => {
    let scopeRead = 0;
    let memberAccessRead = 0;
    let modalShown = 0;
    let replyPayload: unknown = null;

    const mockInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "moderation:v1:member-access-open:en-US",
      guildId: "guild-1",
      memberPermissions: {
        has: () => false,
      },
      reply: async (payload: unknown) => {
        replyPayload = payload;
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async () => {
        scopeRead++;
        return createScopeData();
      },
      resolveMemberAccess: async () => {
        memberAccessRead++;
        return {
          guildId: "guild-1",
          serverId: 1,
          readStatus: "fresh",
          memberAccess: createScopeData().memberAccess,
        };
      },
      showMemberAccessModal: async () => {
        modalShown++;
      },
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-open", "en-US"],
    });

    expect(scopeRead).toBe(0);
    expect(memberAccessRead).toBe(0);
    expect(modalShown).toBe(0);
    expect(JSON.stringify(replyPayload)).toContain("You need `Manage Server` permission to use this moderation panel.");
  });

  it("rejects member-access-open when setup is missing or read is not fresh", async () => {
    let modalShown = 0;
    let replyPayload: unknown = null;

    const mockInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "moderation:v1:member-access-open:en-US",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      reply: async (payload: unknown) => {
        replyPayload = payload;
      },
    } as unknown as ButtonInteraction;

    const missingRoute = createModerationInteractionRoute({
      resolveMemberAccess: async () => null,
      showMemberAccessModal: async () => {
        modalShown++;
      },
    });

    await missingRoute.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-open", "en-US"],
    });

    expect(modalShown).toBe(0);
    expect(JSON.stringify(replyPayload)).toContain("TomoriBot is not set up in this server yet.");

    const unavailableRoute = createModerationInteractionRoute({
      resolveMemberAccess: async () => ({
        guildId: "guild-1",
        serverId: 1,
        readStatus: "unavailable",
        memberAccess: createScopeData().memberAccess,
      }),
      showMemberAccessModal: async () => {
        modalShown++;
      },
    });

    await unavailableRoute.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-open", "en-US"],
    });

    expect(modalShown).toBe(0);
    expect(JSON.stringify(replyPayload)).toContain("Moderation settings could not be loaded. Retry to try again.");

    const staleRoute = createModerationInteractionRoute({
      resolveMemberAccess: async () => ({
        guildId: "guild-1",
        serverId: 1,
        readStatus: "stale",
        memberAccess: createScopeData().memberAccess,
      }),
      showMemberAccessModal: async () => {
        modalShown++;
      },
    });

    await staleRoute.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-open", "en-US"],
    });

    expect(modalShown).toBe(0);
    expect(JSON.stringify(replyPayload)).toContain("Moderation settings could not be loaded. Retry to try again.");
  });

  it("opens member-access modal with fresh state, nonce, and no pre-defer on valid button click without calling full scope resolver", async () => {
    const log: string[] = [];
    let modalState: unknown = null;
    let modalNonce: string | null = null;
    let scopeCalls = 0;

    const mockInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "moderation:v1:member-access-open:en-US",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {
        log.push("deferUpdate");
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async () => {
        scopeCalls++;
        return createScopeData();
      },
      resolveMemberAccess: async () => {
        log.push("resolveMemberAccess");
        return {
          guildId: "guild-1",
          serverId: 1,
          readStatus: "fresh",
          memberAccess: createScopeData().memberAccess,
        };
      },
      createNonce: () => "nonceabc123",
      showMemberAccessModal: async (_interaction, _locale, state, nonce) => {
        log.push("showModal");
        modalState = state;
        modalNonce = nonce;
      },
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-open", "en-US"],
    });

    expect(log).toEqual(["resolveMemberAccess", "showModal"]);
    expect(scopeCalls).toBe(0);
    expect(modalNonce).toBe("nonceabc123");
    expect(modalState).toEqual({
      serverMemteachingEnabled: true,
      attributeMemteachingEnabled: false,
      sampledialogueMemteachingEnabled: true,
      promptSnapshotEnabled: false,
    });
  });

  it("denies member-access-submit on permission loss between open and submit before any write", async () => {
    let updateCalled = 0;
    let cleanedNonce: string | null = null;
    const editReplyCalls: unknown[] = [];

    const mockInteraction = {
      id: "int-123",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: "moderation:v1:member-access-submit:en-US:nonce123",
      guildId: "guild-1",
      memberPermissions: {
        has: () => false,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async () => createScopeData(),
      takeCheckboxValues: (_id, nonce) => {
        cleanedNonce = nonce;
        return ["servermemories"];
      },
      operations: {
        updateMemberPermissions: async () => {
          updateCalled++;
          return { status: "success", changes: [], patch: {} };
        },
      },
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-submit", "en-US", "nonce123"],
    });

    expect(cleanedNonce).toBe("nonce123");
    expect(updateCalled).toBe(0);
    expect(JSON.stringify(editReplyCalls[0])).toContain(
      "You need `Manage Server` permission to use this moderation panel.",
    );
  });

  it("treats missing checkbox transport as invalid/expired input with no write", async () => {
    let updateCalled = 0;
    const editReplyCalls: unknown[] = [];

    const mockInteraction = {
      id: "int-missing",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: "moderation:v1:member-access-submit:en-US:nonce123",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async () => createScopeData(),
      takeCheckboxValues: () => undefined,
      operations: {
        updateMemberPermissions: async () => {
          updateCalled++;
          return { status: "success", changes: [], patch: {} };
        },
      },
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-submit", "en-US", "nonce123"],
    });

    expect(updateCalled).toBe(0);
    const serialized = JSON.stringify(editReplyCalls[0]);
    expect(serialized).toContain("Member access could not be updated");
    expect(serialized).toContain("The modal submission could not be processed. Open the editor again to retry.");
  });

  it("blocks writes on submit when refreshed moderation scope is stale or unavailable", async () => {
    let updateCalled = 0;
    const editReplyCalls: unknown[] = [];

    const mockInteraction = {
      id: "int-stale",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: "moderation:v1:member-access-submit:en-US:nonce123",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async () => ({ ...createScopeData(), readStatus: "stale" }),
      takeCheckboxValues: () => ["servermemories"],
      operations: {
        updateMemberPermissions: async () => {
          updateCalled++;
          return { status: "success", changes: [], patch: {} };
        },
      },
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-submit", "en-US", "nonce123"],
    });

    expect(updateCalled).toBe(0);
    const serialized = JSON.stringify(editReplyCalls[0]);
    expect(serialized).toContain("Member access could not be updated");
    expect(serialized).toContain("Saved data may be out of date because the read failed.");
  });

  it("filters unknown/malformed checkbox values and writes recognized definitions", async () => {
    let passedSelectedValues: unknown = null;
    const editReplyCalls: unknown[] = [];

    const mockInteraction = {
      id: "int-valid",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: "moderation:v1:member-access-submit:en-US:nonce123",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async () => createScopeData(),
      takeCheckboxValues: () => ["servermemories", "malicious_payload", "promptsnapshot", "unknown_option"],
      operations: {
        updateMemberPermissions: async (input) => {
          passedSelectedValues = input.selectedValues;
          return {
            status: "success",
            changes: [
              {
                setting: "prompt_snapshot_enabled",
                isEnabled: true,
                value: "promptsnapshot",
                labelKey: "commands.server.member-permissions.promptsnapshot_label",
                descKey: "commands.server.member-permissions.promptsnapshot_desc",
              },
            ],
            patch: { prompt_snapshot_enabled: true },
          };
        },
      },
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-submit", "en-US", "nonce123"],
    });

    expect(passedSelectedValues).toEqual(["servermemories", "promptsnapshot"]);
    const serialized = JSON.stringify(editReplyCalls[0]);
    expect(serialized).toContain("Member access updated");
    expect(serialized).toContain("Updated member permissions for this server.");
  });

  it("handles unchanged submission with informational receipt and no DB write", async () => {
    const resolveCalls: boolean[] = [];
    const editReplyCalls: unknown[] = [];

    const mockInteraction = {
      id: "int-unchanged",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: "moderation:v1:member-access-submit:en-US:nonce123",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async (_interaction, forceRefresh) => {
        resolveCalls.push(Boolean(forceRefresh));
        return createScopeData();
      },
      takeCheckboxValues: () => ["servermemories", "sampledialogues"],
      operations: {
        updateMemberPermissions: async () => ({
          status: "unchanged",
          changes: [],
          patch: {},
        }),
      },
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-submit", "en-US", "nonce123"],
    });

    expect(resolveCalls).toEqual([false, false]);
    const serialized = JSON.stringify(editReplyCalls[0]);
    expect(serialized).toContain("Member access was already current");
    expect(serialized).toContain("Member permissions already match the requested state. No write was needed.");
  });

  it("handles repository failure on submit with failure receipt", async () => {
    const resolveCalls: boolean[] = [];
    const editReplyCalls: unknown[] = [];

    const mockInteraction = {
      id: "int-failure",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: "moderation:v1:member-access-submit:en-US:nonce123",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async (_interaction, forceRefresh) => {
        resolveCalls.push(Boolean(forceRefresh));
        return createScopeData();
      },
      takeCheckboxValues: () => [],
      operations: {
        updateMemberPermissions: async () => ({
          status: "failure",
          changes: [],
          patch: {},
        }),
      },
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-submit", "en-US", "nonce123"],
    });

    expect(resolveCalls).toEqual([false, false]);
    const serialized = JSON.stringify(editReplyCalls[0]);
    expect(serialized).toContain("Member access could not be updated");
    expect(serialized).toContain(
      "The database write failed or permissions changed. Retry to refresh current settings.",
    );
  });

  it("reloads and repaints on successful submit, retaining receipt if post-write reload is unavailable", async () => {
    const resolveCalls: boolean[] = [];
    const editReplyCalls: unknown[] = [];

    const mockInteraction = {
      id: "int-postreload-unavail",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: "moderation:v1:member-access-submit:en-US:nonce123",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async (_interaction, forceRefresh) => {
        resolveCalls.push(Boolean(forceRefresh));
        if (resolveCalls.length === 2) {
          return null;
        }
        return createScopeData();
      },
      takeCheckboxValues: () => ["attributelist"],
      operations: {
        updateMemberPermissions: async () => ({
          status: "success",
          changes: [
            {
              setting: "attribute_memteaching_enabled",
              isEnabled: true,
              value: "attributelist",
              labelKey: "commands.server.member-permissions.attributelist_label",
              descKey: "commands.server.member-permissions.attributelist_desc",
            },
          ],
          patch: { attribute_memteaching_enabled: true },
        }),
      },
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-submit", "en-US", "nonce123"],
    });

    expect(resolveCalls).toEqual([false, false]);
    const serialized = JSON.stringify(editReplyCalls[0]);
    expect(serialized).toContain("Member access updated");
    expect(serialized).toContain("Moderation settings could not be loaded. Retry to try again.");
  });

  it("handles retry route with force refresh", async () => {
    const loadCalls: boolean[] = [];
    const mockInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "moderation:v1:retry:en-US:member-access:none",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async (_interaction, forceRefresh) => {
        loadCalls.push(Boolean(forceRefresh));
        return createScopeData();
      },
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["retry", "en-US", "member-access", "none"],
    });

    expect(loadCalls).toEqual([true]);
  });

  it("denies access when user lacks Manage Server permission", async () => {
    const editReplyCalls: unknown[] = [];
    const mockInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "moderation:v1:category:en-US:whitelist",
      guildId: "guild-1",
      memberPermissions: {
        has: () => false,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async () => createScopeData(),
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["category", "en-US", "whitelist"],
    });

    const serialized = JSON.stringify(editReplyCalls[0]);
    expect(serialized).toContain("You need `Manage Server` permission to use this moderation panel.");
  });

  it("handles missing setup gracefully", async () => {
    const editReplyCalls: unknown[] = [];
    const mockInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "moderation:v1:category:en-US:whitelist",
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
      deferUpdate: async () => {},
      editReply: async (payload: unknown) => {
        editReplyCalls.push(payload);
      },
    } as unknown as ButtonInteraction;

    const route = createModerationInteractionRoute({
      resolveScope: async () => null,
    });

    await route.execute({} as Client, mockInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["category", "en-US", "whitelist"],
    });

    const serialized = JSON.stringify(editReplyCalls[0]);
    expect(serialized).toContain("TomoriBot is not set up in this server yet.");
  });

  it("handles stale route versions through router dispatch", async () => {
    let replyPayload: unknown = null;
    const mockInteraction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      customId: "moderation:v0:category:en-US:whitelist",
      locale: "en-US",
      reply: async (payload: unknown) => {
        replyPayload = payload;
      },
    } as unknown as ButtonInteraction;

    const handled = await dispatchGlobalInteraction({} as Client, mockInteraction);
    expect(handled).toBe(true);
    expect(JSON.stringify(replyPayload)).toContain("This moderation panel is outdated. Run /moderation again.");
  });

  it("rejects slash command execution outside guild", async () => {
    const mockInteraction = {
      guildId: null,
      memberPermissions: null,
    } as unknown as ChatInputCommandInteraction;

    const payload = await buildInitialModerationPanel(mockInteraction, "en-US");
    expect(JSON.stringify(payload)).toContain("The moderation panel is only available in a server.");
  });

  it("rejects slash command execution for non-managers", async () => {
    const mockInteraction = {
      guildId: "guild-1",
      memberPermissions: {
        has: () => false,
      },
    } as unknown as ChatInputCommandInteraction;

    const payload = await buildInitialModerationPanel(mockInteraction, "en-US");
    expect(JSON.stringify(payload)).toContain("You need `Manage Server` permission to use this moderation panel.");
  });

  it("renders initial panel on valid slash execution", async () => {
    const mockInteraction = {
      guildId: "guild-1",
      memberPermissions: {
        has: () => true,
      },
    } as unknown as ChatInputCommandInteraction;

    const payload = await buildInitialModerationPanel(mockInteraction, "en-US", {
      resolveScope: async () => createScopeData(),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Server Moderation");
    expect(serialized).toContain("Member Access Settings");
  });

  it("executes moderation command with ephemeral deferReply", async () => {
    const log: string[] = [];
    const mockInteraction = {
      deferReply: async (options: { flags?: number }) => {
        log.push(`deferReply:${options?.flags}`);
      },
      editReply: async () => {
        log.push("editReply");
      },
    } as unknown as ChatInputCommandInteraction;

    await executeModerationCommand(mockInteraction, "en-US", async () => ({ components: [] }) as never);

    expect(log).toEqual(["deferReply:64", "editReply"]);
  });

  describe("user-blacklist-add-open route", () => {
    it("denies user-blacklist-add-open when user lacks Manage Server without reading state or opening modal", async () => {
      let resolveUserBlacklistAddCalled = 0;
      let modalShown = 0;
      let replyPayload: unknown = null;

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-add-open:en-US",
        guildId: "guild-1",
        memberPermissions: {
          has: () => false,
        },
        reply: async (payload: unknown) => {
          replyPayload = payload;
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveUserBlacklistAdd: async () => {
          resolveUserBlacklistAddCalled++;
          return { guildId: "guild-1", serverId: 1, readStatus: "fresh", personalMemoriesEnabled: true };
        },
        showUserBlacklistAddModal: async () => {
          modalShown++;
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-open", "en-US"],
      });

      expect(resolveUserBlacklistAddCalled).toBe(0);
      expect(modalShown).toBe(0);
      expect(JSON.stringify(replyPayload)).toContain(
        "You need `Manage Server` permission to use this moderation panel.",
      );
    });

    it("rejects user-blacklist-add-open when workspace is not setup", async () => {
      let modalShown = 0;
      let replyPayload: unknown = null;

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-add-open:en-US",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        reply: async (payload: unknown) => {
          replyPayload = payload;
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveUserBlacklistAdd: async () => null,
        showUserBlacklistAddModal: async () => {
          modalShown++;
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-open", "en-US"],
      });

      expect(modalShown).toBe(0);
      expect(JSON.stringify(replyPayload)).toContain("TomoriBot is not set up in this server yet.");
    });

    it("rejects user-blacklist-add-open when read is unavailable or stale", async () => {
      let modalShown = 0;
      let replyPayload: unknown = null;

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-add-open:en-US",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        reply: async (payload: unknown) => {
          replyPayload = payload;
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveUserBlacklistAdd: async () => ({
          guildId: "guild-1",
          serverId: 1,
          readStatus: "unavailable",
          personalMemoriesEnabled: true,
        }),
        showUserBlacklistAddModal: async () => {
          modalShown++;
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-open", "en-US"],
      });

      expect(modalShown).toBe(0);
      expect(JSON.stringify(replyPayload)).toContain("Moderation settings could not be loaded. Retry to try again.");
    });

    it("rejects user-blacklist-add-open when personalization is disabled", async () => {
      let modalShown = 0;
      let replyPayload: unknown = null;

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-add-open:en-US",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        reply: async (payload: unknown) => {
          replyPayload = payload;
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveUserBlacklistAdd: async () => ({
          guildId: "guild-1",
          serverId: 1,
          readStatus: "fresh",
          personalMemoriesEnabled: false,
        }),
        showUserBlacklistAddModal: async () => {
          modalShown++;
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-open", "en-US"],
      });

      expect(modalShown).toBe(0);
      expect(JSON.stringify(replyPayload)).toContain("Personalization is disabled for this server.");
    });

    it("opens User Blacklist Add raw modal with nonce without pre-deferral", async () => {
      let modalShownNonce: string | null = null;
      let replyCalled = 0;
      let deferCalled = 0;

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-add-open:en-US",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        reply: async () => {
          replyCalled++;
        },
        deferReply: async () => {
          deferCalled++;
        },
        deferUpdate: async () => {
          deferCalled++;
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        createNonce: () => "testnonce_xyz",
        resolveUserBlacklistAdd: async () => ({
          guildId: "guild-1",
          serverId: 1,
          readStatus: "fresh",
          personalMemoriesEnabled: true,
        }),
        showUserBlacklistAddModal: async (_interaction, _locale, nonce) => {
          modalShownNonce = nonce;
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-open", "en-US"],
      });

      expect(replyCalled).toBe(0);
      expect(deferCalled).toBe(0);
      expect(modalShownNonce).toBe("testnonce_xyz");
    });
  });

  describe("user-blacklist-add-submit route", () => {
    it("consumes transport on permission denial and editReplies terminal permission denied", async () => {
      let transportConsumed = 0;
      let editReplyPayload: unknown = null;

      const mockInteraction = {
        id: "interaction-deny-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:user-blacklist-add-submit:en-US:nonce123",
        guildId: "guild-1",
        memberPermissions: {
          has: () => false,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyPayload = payload;
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        takeUserSelectValue: (interactionId, nonce) => {
          expect(interactionId).toBe("interaction-deny-1");
          expect(nonce).toBe("nonce123");
          transportConsumed++;
          return "123456789012345678";
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-submit", "en-US", "nonce123"],
      });

      expect(transportConsumed).toBe(1);
      expect(JSON.stringify(editReplyPayload)).toContain(
        "You need `Manage Server` permission to use this moderation panel.",
      );
    });

    it("repaints with invalid_input receipt when user select transport is missing or malformed", async () => {
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        id: "interaction-malformed-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:user-blacklist-add-submit:en-US:nonce123",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeUserSelectValue: () => undefined,
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-submit", "en-US", "nonce123"],
      });

      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("The modal submission could not be processed.");
    });

    it("repaints with invalid_user receipt when user fetch fails", async () => {
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        id: "interaction-notfound-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:user-blacklist-add-submit:en-US:nonce123",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeUserSelectValue: () => "123456789012345678",
        resolveUser: async () => null,
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-submit", "en-US", "nonce123"],
      });

      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("The selected user could not be found or is no longer in this server.");
    });

    it("repaints with cannot_blacklist_bot receipt when target user is a bot", async () => {
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        id: "interaction-bot-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:user-blacklist-add-submit:en-US:nonce123",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeUserSelectValue: () => "999999999999999999",
        resolveUser: async () => ({ id: "999999999999999999", username: "MusicBot", bot: true }),
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-submit", "en-US", "nonce123"],
      });

      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("Cannot blacklist bot");
      expect(serialized).toContain("MusicBot");
    });

    it("successfully adds user to blacklist, reloads scope without force refresh, and repaints user-blacklist page with success receipt", async () => {
      const editReplyCalls: unknown[] = [];
      const resolveCalls: boolean[] = [];
      let addOperationInput: unknown = null;

      const mockInteraction = {
        id: "interaction-success-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:user-blacklist-add-submit:en-US:nonce123",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const initialScope = createScopeData();
      const updatedScope = {
        ...initialScope,
        userBlacklist: {
          personalizationUserIds: ["u1", "123456789012345678"],
          personaBlocks: [],
          personalMemoriesEnabled: true,
        },
      };

      const route = createModerationInteractionRoute({
        resolveScope: async (_interaction, forceRefresh) => {
          resolveCalls.push(Boolean(forceRefresh));
          return resolveCalls.length === 1 ? initialScope : updatedScope;
        },
        takeUserSelectValue: () => "123456789012345678",
        resolveUser: async () => ({ id: "123456789012345678", username: "AnonMember", bot: false }),
        operations: {
          updateMemberPermissions: async () => ({ status: "unchanged", changes: [], patch: {} }),
          addUserToBlacklist: async (input) => {
            addOperationInput = input;
            return { status: "success", targetUserId: "123456789012345678" };
          },
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-submit", "en-US", "nonce123"],
      });

      expect(resolveCalls).toEqual([false, false]);
      expect(addOperationInput).toEqual({
        guildId: "guild-1",
        serverId: 1,
        targetUserId: "123456789012345678",
        isBot: false,
        personalMemoriesEnabled: true,
      });
      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("Member blacklisted");
      expect(serialized).toContain("Added AnonMember to the personalization blacklist.");
      expect(serialized).toContain("Blacklisted Members `(2)`");
      expect(serialized).toContain("<@123456789012345678>");
    });

    it("repaints with already_blacklisted info receipt when user is already blacklisted", async () => {
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        id: "interaction-dup-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:user-blacklist-add-submit:en-US:nonce123",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeUserSelectValue: () => "123456789012345678",
        resolveUser: async () => ({ id: "123456789012345678", username: "ExistingMember", bot: false }),
        operations: {
          updateMemberPermissions: async () => ({ status: "unchanged", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "already_blacklisted", targetUserId: "123456789012345678" }),
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-submit", "en-US", "nonce123"],
      });

      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("Member already blacklisted");
      expect(serialized).toContain("ExistingMember is already on the personalization blacklist.");
    });

    it("resolves member through current guild membership using default user resolver", async () => {
      let fetchedMemberId: string | null = null;
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        id: "interaction-guild-resolve-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:user-blacklist-add-submit:en-US:nonce123",
        guildId: "guild-1",
        guild: {
          members: {
            fetch: async (id: string) => {
              fetchedMemberId = id;
              return {
                user: { id, username: "Sparrow", bot: false },
              };
            },
          },
        },
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const initialScope = createScopeData();
      const updatedScope = {
        ...initialScope,
        userBlacklist: {
          personalizationUserIds: ["u1", "123456789012345678"],
          personaBlocks: [],
          personalMemoriesEnabled: true,
        },
      };

      let resolveCount = 0;
      const route = createModerationInteractionRoute({
        resolveScope: async () => {
          resolveCount++;
          return resolveCount === 1 ? initialScope : updatedScope;
        },
        takeUserSelectValue: () => "123456789012345678",
        operations: {
          updateMemberPermissions: async () => ({ status: "unchanged", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "123456789012345678" }),
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-submit", "en-US", "nonce123"],
      });

      expect(fetchedMemberId).toBe("123456789012345678");
      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("Member blacklisted");
      expect(serialized).toContain("Added Sparrow to the personalization blacklist.");
    });

    it("repaints with invalid_user receipt when default user resolver member fetch fails or outside guild", async () => {
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        id: "interaction-guild-fail-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:user-blacklist-add-submit:en-US:nonce123",
        guildId: "guild-1",
        guild: {
          members: {
            fetch: async () => {
              throw new Error("Unknown Member");
            },
          },
        },
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeUserSelectValue: () => "123456789012345678",
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-submit", "en-US", "nonce123"],
      });

      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("The selected user could not be found or is no longer in this server.");
    });
  });

  describe("user-blacklist-remove-prompt route", () => {
    it("denies user-blacklist-remove-prompt when actor lacks Manage Server without reading state", async () => {
      let resolveCalled = 0;
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-remove-prompt:en-US:personalization:123456789012345678",
        guildId: "guild-1",
        memberPermissions: {
          has: () => false,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => {
          resolveCalled++;
          return createScopeData();
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-remove-prompt", "en-US", "personalization", "123456789012345678"],
      });

      expect(resolveCalled).toBe(0);
      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("You need `Manage Server` permission to use this moderation panel.");
    });

    it("rejects user-blacklist-remove-prompt when workspace is not setup", async () => {
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-remove-prompt:en-US:personalization:123456789012345678",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => null,
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-remove-prompt", "en-US", "personalization", "123456789012345678"],
      });

      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("TomoriBot is not set up in this server yet. Run /setup first.");
    });

    it("repaints with changed_receipt when personalization target was already removed", async () => {
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-remove-prompt:en-US:personalization:999999999999999999",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => ({
          ...createScopeData(),
          userBlacklist: {
            personalizationUserIds: ["other-user"],
            personaBlocks: [],
            personalMemoriesEnabled: true,
          },
        }),
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-remove-prompt", "en-US", "personalization", "999999999999999999"],
      });

      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("Blacklist state changed");
      expect(serialized).toContain("That entry is no longer present in the blacklist.");
    });

    it("renders confirmation view when personalization target exists", async () => {
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-remove-prompt:en-US:personalization:123456789012345678",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => ({
          ...createScopeData(),
          userBlacklist: {
            personalizationUserIds: ["123456789012345678"],
            personaBlocks: [],
            personalMemoriesEnabled: true,
          },
        }),
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-remove-prompt", "en-US", "personalization", "123456789012345678"],
      });

      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("Remove Blacklisted Member");
      expect(serialized).toContain("Remove <@123456789012345678> from the personalization blacklist?");
      expect(serialized).toContain("user-blacklist-remove-confirm");
      expect(serialized).toContain("user-blacklist-remove-cancel");
    });
  });

  describe("user-blacklist-remove-cancel route", () => {
    it("returns to canonical user-blacklist page without performing writes", async () => {
      let writeCalled = 0;
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-remove-cancel:en-US",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        operations: {
          updateMemberPermissions: async () => {
            writeCalled++;
            return { status: "success", changes: [], patch: {} };
          },
          addUserToBlacklist: async () => {
            writeCalled++;
            return { status: "success", targetUserId: "u" };
          },
          removeUserFromBlacklist: async () => {
            writeCalled++;
            return { status: "success", targetUserId: "u" };
          },
          removePersonaUserBlock: async () => {
            writeCalled++;
            return {
              status: "success",
              personaId: 1,
              targetUserId: "u",
              block: {
                server_id: 1,
                persona_id: 1,
                user_disc_id: "u",
                block_type: "mute",
                reason: "",
                expires_at: new Date(),
                created_at: new Date(),
                updated_at: new Date(),
              },
            };
          },
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-remove-cancel", "en-US"],
      });

      expect(writeCalled).toBe(0);
      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("User Blacklist");
    });
  });

  describe("user-blacklist-remove-confirm route", () => {
    it("denies user-blacklist-remove-confirm when actor lacks Manage Server", async () => {
      let removeCalled = 0;
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-remove-confirm:en-US:personalization:123456789012345678",
        guildId: "guild-1",
        memberPermissions: {
          has: () => false,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => {
            removeCalled++;
            return { status: "success", targetUserId: "123456789012345678" };
          },
          removePersonaUserBlock: async () => ({ status: "not_found", personaId: 1, targetUserId: "u" }),
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-remove-confirm", "en-US", "personalization", "123456789012345678"],
      });

      expect(removeCalled).toBe(0);
      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("You need `Manage Server` permission to use this moderation panel.");
    });

    it("rejects user-blacklist-remove-confirm when readStatus is stale", async () => {
      let removeCalled = 0;
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-remove-confirm:en-US:personalization:123456789012345678",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => ({
          ...createScopeData(),
          readStatus: "stale",
          userBlacklist: {
            personalizationUserIds: ["123456789012345678"],
            personaBlocks: [],
            personalMemoriesEnabled: true,
          },
        }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => {
            removeCalled++;
            return { status: "success", targetUserId: "123456789012345678" };
          },
          removePersonaUserBlock: async () => ({ status: "not_found", personaId: 1, targetUserId: "u" }),
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-remove-confirm", "en-US", "personalization", "123456789012345678"],
      });

      expect(removeCalled).toBe(0);
      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("Removal failed");
      expect(serialized).toContain("Saved data may be out of date");
    });

    it("returns changed_receipt without write when target disappeared before confirm", async () => {
      let removeCalled = 0;
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-remove-confirm:en-US:personalization:123456789012345678",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => ({
          ...createScopeData(),
          userBlacklist: {
            personalizationUserIds: [],
            personaBlocks: [],
            personalMemoriesEnabled: true,
          },
        }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => {
            removeCalled++;
            return { status: "success", targetUserId: "123456789012345678" };
          },
          removePersonaUserBlock: async () => ({ status: "not_found", personaId: 1, targetUserId: "u" }),
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-remove-confirm", "en-US", "personalization", "123456789012345678"],
      });

      expect(removeCalled).toBe(0);
      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("Blacklist state changed");
    });

    it("successfully removes personalization entry, verifies forceRefresh=false on reload, and renders receipt", async () => {
      const scopeLoadLog: boolean[] = [];
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-remove-confirm:en-US:personalization:123456789012345678",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async (_interaction, forceRefresh) => {
          scopeLoadLog.push(Boolean(forceRefresh));
          return {
            ...createScopeData(),
            userBlacklist: {
              personalizationUserIds: scopeLoadLog.length === 1 ? ["123456789012345678"] : [],
              personaBlocks: [],
              personalMemoriesEnabled: true,
            },
          };
        },
        resolveUser: async () => ({ id: "123456789012345678", username: "alice", bot: false }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async ({ targetUserId }) => ({
            status: "success",
            targetUserId,
          }),
          removePersonaUserBlock: async () => ({ status: "not_found", personaId: 1, targetUserId: "u" }),
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-remove-confirm", "en-US", "personalization", "123456789012345678"],
      });

      expect(scopeLoadLog).toEqual([false, false]);
      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("Blacklist entry removed");
      expect(serialized).toContain("Removed alice from the personalization blacklist.");
    });

    it("successfully removes persona block entry, verifies forceRefresh=false on reload, and renders receipt with persona name", async () => {
      const scopeLoadLog: boolean[] = [];
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-remove-confirm:en-US:persona-block:2:123456789012345678",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const mockBlock = {
        server_id: 1,
        persona_id: 2,
        user_disc_id: "123456789012345678",
        block_type: "mute" as const,
        reason: "spam",
        expires_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
        persona_name: "Tomori",
      };

      const route = createModerationInteractionRoute({
        resolveScope: async (_interaction, forceRefresh) => {
          scopeLoadLog.push(Boolean(forceRefresh));
          return {
            ...createScopeData(),
            userBlacklist: {
              personalizationUserIds: [],
              personaBlocks: scopeLoadLog.length === 1 ? [mockBlock] : [],
              personalMemoriesEnabled: true,
            },
          };
        },
        resolveUser: async () => ({ id: "123456789012345678", username: "bob", bot: false }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => ({ status: "not_found", targetUserId: "u" }),
          removePersonaUserBlock: async ({ personaId, targetUserId }) => ({
            status: "success",
            personaId,
            targetUserId,
            block: mockBlock,
          }),
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-remove-confirm", "en-US", "persona-block", "2", "123456789012345678"],
      });

      expect(scopeLoadLog).toEqual([false, false]);
      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("Blacklist entry removed");
      expect(serialized).toContain("Removed bob's restriction on **Tomori**.");
    });

    it("renders failure receipt when removal operation fails", async () => {
      const editReplyCalls: unknown[] = [];

      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:user-blacklist-remove-confirm:en-US:personalization:123456789012345678",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyCalls.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => ({
          ...createScopeData(),
          userBlacklist: {
            personalizationUserIds: ["123456789012345678"],
            personaBlocks: [],
            personalMemoriesEnabled: true,
          },
        }),
        resolveUser: async () => ({ id: "123456789012345678", username: "alice", bot: false }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => ({
            status: "failure",
            targetUserId: "123456789012345678",
          }),
          removePersonaUserBlock: async () => ({ status: "failure", personaId: 1, targetUserId: "u" }),
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-remove-confirm", "en-US", "personalization", "123456789012345678"],
      });

      expect(editReplyCalls).toHaveLength(1);
      const serialized = JSON.stringify(editReplyCalls[0]);
      expect(serialized).toContain("Removal failed");
      expect(serialized).toContain("The database write failed. Retry to refresh current settings.");
    });
  });

  describe("whitelist-channel-add-open route execution", () => {
    it("denies unauthorized button clicks before resolving channel add data", async () => {
      let resolveAddCalled = false;
      const replies: unknown[] = [];
      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:whitelist-channel-add-open:en-US",
        guildId: "guild-1",
        memberPermissions: {
          has: () => false,
        },
        reply: async (payload: unknown) => {
          replies.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveWhitelistChannelAdd: async () => {
          resolveAddCalled = true;
          return null;
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-add-open", "en-US"],
      });

      expect(resolveAddCalled).toBe(false);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toEqual({
        content: "You need `Manage Server` permission to use this moderation panel.",
        flags: 64,
      });
    });

    it("opens whitelist channel add modal with nonce on fresh scope", async () => {
      let shownModalNonce: string | null = null;
      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:whitelist-channel-add-open:en-US",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveWhitelistChannelAdd: async () => ({
          guildId: "guild-1",
          serverId: 1,
          readStatus: "fresh",
          config: {
            cooldown_type: CooldownType.PER_CHANNEL,
            cooldown_length: 15,
          },
        }),
        createNonce: () => "testnonce789",
        showWhitelistChannelAddModal: async (_interaction, _locale, nonce) => {
          shownModalNonce = nonce;
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-add-open", "en-US"],
      });

      expect(shownModalNonce).toBe("testnonce789");
    });
  });

  describe("whitelist-channel-add-submit route execution", () => {
    it("validates channel type is GuildText, invokes upsert, and renders success receipt", async () => {
      let deferred = false;
      const editReplies: unknown[] = [];
      const mockModal = {
        id: "modal-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:whitelist-channel-add-submit:en-US:testnonce789",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {
          deferred = true;
        },
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
        fields: {
          getTextInputValue: () => "25",
        },
      } as unknown as ModalSubmitInteraction;

      let upsertArgs: unknown = null;
      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeChannelSelectValue: () => "111222333444555666",
        takeCooldownTypeSelectValue: () => "1",
        resolveChannel: async (_i, id) => ({ id, name: "bot-lounge", type: ChannelType.GuildText }),
        resolveWhitelistChannelAdd: async () => ({
          guildId: "guild-1",
          serverId: 1,
          readStatus: "fresh",
          config: { cooldown_type: null, cooldown_length: null },
        }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removePersonaUserBlock: async () => ({ status: "success", personaId: 1, targetUserId: "u" }),
          upsertWhitelistChannel: async (args) => {
            upsertArgs = args;
            return {
              status: "success",
              channelId: args.channelId,
              cooldownType: args.requestedCooldownType,
              cooldownLength: args.requestedCooldownLength,
              isUpdate: false,
            };
          },
          removeWhitelistChannel: async () => ({ status: "success", channelId: "c" }),
        },
      });

      await route.execute({} as Client, mockModal, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-add-submit", "en-US", "testnonce789"],
      });

      expect(deferred).toBe(true);
      expect(upsertArgs).toEqual({
        guildId: "guild-1",
        serverId: 1,
        channelId: "111222333444555666",
        requestedCooldownType: CooldownType.PER_USER,
        requestedCooldownLength: 25,
        serverConfig: { cooldown_type: null, cooldown_length: null },
      });
      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).toContain("Channel whitelist updated");
      expect(serialized).toContain("Updated whitelist settings for #bot-lounge.");
    });

    it("rejects non-text channel types with error receipt", async () => {
      const editReplies: unknown[] = [];
      const mockModal = {
        id: "modal-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:whitelist-channel-add-submit:en-US:testnonce789",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
        fields: {
          getTextInputValue: () => "",
        },
      } as unknown as ModalSubmitInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeChannelSelectValue: () => "111222333444555666",
        takeCooldownTypeSelectValue: () => undefined,
        resolveChannel: async (_i, id) => ({ id, name: "general-voice", type: ChannelType.GuildVoice }),
        resolveWhitelistChannelAdd: async () => null,
      });

      await route.execute({} as Client, mockModal, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-add-submit", "en-US", "testnonce789"],
      });

      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).toContain(
        "The selected channel could not be found, is not a text channel, or is no longer in this server.",
      );
    });

    it("handles unchanged status with info receipt", async () => {
      const editReplies: unknown[] = [];
      const mockModal = {
        id: "modal-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:whitelist-channel-add-submit:en-US:testnonce789",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
        fields: {
          getTextInputValue: () => "",
        },
      } as unknown as ModalSubmitInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeChannelSelectValue: () => "111222333444555666",
        takeCooldownTypeSelectValue: () => undefined,
        resolveChannel: async (_i, id) => ({ id, name: "bot-lounge", type: ChannelType.GuildText }),
        resolveWhitelistChannelAdd: async () => ({
          guildId: "guild-1",
          serverId: 1,
          readStatus: "fresh",
          config: { cooldown_type: null, cooldown_length: null },
        }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removePersonaUserBlock: async () => ({ status: "success", personaId: 1, targetUserId: "u" }),
          upsertWhitelistChannel: async (args) => ({
            status: "unchanged",
            channelId: args.channelId,
            cooldownType: null,
            cooldownLength: null,
          }),
          removeWhitelistChannel: async () => ({ status: "success", channelId: "c" }),
        },
      });

      await route.execute({} as Client, mockModal, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-add-submit", "en-US", "testnonce789"],
      });

      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).toContain("Channel whitelist already current");
      expect(serialized).toContain(
        "Whitelist settings for #bot-lounge already match the requested state. No write was needed.",
      );
    });

    it("rejects add submit without upsert when resolveWhitelistChannelAdd returns null or stale", async () => {
      let upsertCalled = 0;
      const editReplies: unknown[] = [];
      const mockModal = {
        id: "modal-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:whitelist-channel-add-submit:en-US:testnonce789",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
        fields: {
          getTextInputValue: () => "10",
        },
      } as unknown as ModalSubmitInteraction;

      const nullRoute = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeChannelSelectValue: () => "111222333444555666",
        takeCooldownTypeSelectValue: () => "1",
        resolveChannel: async (_i, id) => ({ id, name: "bot-lounge", type: ChannelType.GuildText }),
        resolveWhitelistChannelAdd: async () => null,
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removePersonaUserBlock: async () => ({ status: "success", personaId: 1, targetUserId: "u" }),
          upsertWhitelistChannel: async () => {
            upsertCalled++;
            return { status: "success", channelId: "c", cooldownType: null, cooldownLength: null, isUpdate: false };
          },
          removeWhitelistChannel: async () => ({ status: "success", channelId: "c" }),
        },
      });

      await nullRoute.execute({} as Client, mockModal, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-add-submit", "en-US", "testnonce789"],
      });

      expect(upsertCalled).toBe(0);
      expect(JSON.stringify(editReplies[0])).toContain("Moderation settings could not be loaded");

      const staleRoute = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeChannelSelectValue: () => "111222333444555666",
        takeCooldownTypeSelectValue: () => "1",
        resolveChannel: async (_i, id) => ({ id, name: "bot-lounge", type: ChannelType.GuildText }),
        resolveWhitelistChannelAdd: async () => ({
          guildId: "guild-1",
          serverId: 1,
          readStatus: "stale",
          config: { cooldown_type: null, cooldown_length: null },
        }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removePersonaUserBlock: async () => ({ status: "success", personaId: 1, targetUserId: "u" }),
          upsertWhitelistChannel: async () => {
            upsertCalled++;
            return { status: "success", channelId: "c", cooldownType: null, cooldownLength: null, isUpdate: false };
          },
          removeWhitelistChannel: async () => ({ status: "success", channelId: "c" }),
        },
      });

      await staleRoute.execute({} as Client, mockModal, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-add-submit", "en-US", "testnonce789"],
      });

      expect(upsertCalled).toBe(0);
      expect(JSON.stringify(editReplies[1])).toContain("Saved data may be out of date");
    });

    it("rejects add submit without upsert when resolveWhitelistChannelAdd has mismatched guild or server identity", async () => {
      let upsertCalled = 0;
      const editReplies: unknown[] = [];
      const mockModal = {
        id: "modal-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:whitelist-channel-add-submit:en-US:testnonce789",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
        fields: {
          getTextInputValue: () => "10",
        },
      } as unknown as ModalSubmitInteraction;

      const mismatchedRoute = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeChannelSelectValue: () => "111222333444555666",
        takeCooldownTypeSelectValue: () => "1",
        resolveChannel: async (_i, id) => ({ id, name: "bot-lounge", type: ChannelType.GuildText }),
        resolveWhitelistChannelAdd: async () => ({
          guildId: "other-guild",
          serverId: 999,
          readStatus: "fresh",
          config: { cooldown_type: null, cooldown_length: null },
        }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removePersonaUserBlock: async () => ({ status: "success", personaId: 1, targetUserId: "u" }),
          upsertWhitelistChannel: async () => {
            upsertCalled++;
            return { status: "success", channelId: "c", cooldownType: null, cooldownLength: null, isUpdate: false };
          },
          removeWhitelistChannel: async () => ({ status: "success", channelId: "c" }),
        },
      });

      await mismatchedRoute.execute({} as Client, mockModal, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-add-submit", "en-US", "testnonce789"],
      });

      expect(upsertCalled).toBe(0);
      expect(JSON.stringify(editReplies[0])).toContain("Moderation settings could not be loaded");
    });
  });

  describe("whitelist-channel-remove routes execution", () => {
    it("renders confirmation view on whitelist-channel-remove-prompt", async () => {
      const editReplies: unknown[] = [];
      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:whitelist-channel-remove-prompt:en-US:111222333444555666",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => ({
          ...createScopeData(),
          whitelist: {
            channels: [
              {
                server_id: 1,
                channel_disc_id: "111222333444555666",
                cooldown_type: null,
                cooldown_length: null,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
            personaChannels: [],
            roles: [],
            personaNames: new Map(),
          },
        }),
        resolveChannel: async (_i, id) => ({ id, name: "bot-lounge", type: ChannelType.GuildText }),
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-remove-prompt", "en-US", "111222333444555666"],
      });

      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).toContain("### Remove Whitelisted Channel");
      expect(serialized).toContain("moderation:v1:whitelist-channel-remove-confirm:en-US:111222333444555666");
      expect(serialized).toContain("moderation:v1:whitelist-channel-remove-cancel:en-US");
    });

    it("renders changed-state receipt and does not show confirmation when channel disappears before remove prompt", async () => {
      const editReplies: unknown[] = [];
      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:whitelist-channel-remove-prompt:en-US:111222333444555666",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => ({
          ...createScopeData(),
          whitelist: {
            channels: [
              {
                server_id: 1,
                channel_disc_id: "111222333444555666",
                cooldown_type: null,
                cooldown_length: null,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
            personaChannels: [],
            roles: [],
            personaNames: new Map(),
          },
        }),
        resolveChannel: async () => null,
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-remove-prompt", "en-US", "111222333444555666"],
      });

      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).toContain("Whitelist state changed");
      expect(serialized).not.toContain("### Remove Whitelisted Channel");
      expect(serialized).not.toContain("whitelist-channel-remove-confirm");
    });

    it("renders changed-state receipt and does not show confirmation when channel type is not GuildText on prompt", async () => {
      const editReplies: unknown[] = [];
      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:whitelist-channel-remove-prompt:en-US:111222333444555666",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => ({
          ...createScopeData(),
          whitelist: {
            channels: [
              {
                server_id: 1,
                channel_disc_id: "111222333444555666",
                cooldown_type: null,
                cooldown_length: null,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
            personaChannels: [],
            roles: [],
            personaNames: new Map(),
          },
        }),
        resolveChannel: async (_i, id) => ({ id, name: "voice-chat", type: ChannelType.GuildVoice }),
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-remove-prompt", "en-US", "111222333444555666"],
      });

      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).toContain("Whitelist state changed");
      expect(serialized).not.toContain("### Remove Whitelisted Channel");
      expect(serialized).not.toContain("whitelist-channel-remove-confirm");
    });

    it("cancels removal and returns to normal panel on whitelist-channel-remove-cancel", async () => {
      const editReplies: unknown[] = [];
      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:whitelist-channel-remove-cancel:en-US",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-remove-cancel", "en-US"],
      });

      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).not.toContain("### Remove Whitelisted Channel");
      expect(serialized).toContain("### Whitelisted Channels");
    });

    it("removes channel and renders success receipt on whitelist-channel-remove-confirm", async () => {
      const editReplies: unknown[] = [];
      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:whitelist-channel-remove-confirm:en-US:111222333444555666",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
      } as unknown as ButtonInteraction;

      let removeArgs: unknown = null;
      const route = createModerationInteractionRoute({
        resolveScope: async () => ({
          ...createScopeData(),
          whitelist: {
            channels: [
              {
                server_id: 1,
                channel_disc_id: "111222333444555666",
                cooldown_type: null,
                cooldown_length: null,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
            personaChannels: [],
            roles: [],
            personaNames: new Map(),
          },
        }),
        resolveChannel: async (_i, id) => ({ id, name: "bot-lounge", type: ChannelType.GuildText }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removePersonaUserBlock: async () => ({ status: "success", personaId: 1, targetUserId: "u" }),
          upsertWhitelistChannel: async () => ({
            status: "success",
            channelId: "c",
            cooldownType: null,
            cooldownLength: null,
            isUpdate: false,
          }),
          removeWhitelistChannel: async (args) => {
            removeArgs = args;
            return { status: "success", channelId: args.channelId };
          },
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-remove-confirm", "en-US", "111222333444555666"],
      });

      expect(removeArgs).toEqual({
        guildId: "guild-1",
        serverId: 1,
        channelId: "111222333444555666",
      });
      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).toContain("Channel removed");
      expect(serialized).toContain("Removed #bot-lounge from the whitelist.");
    });

    it("renders changed-state receipt and does not call remove operation when channel disappears immediately before confirm", async () => {
      let removeCalled = 0;
      const editReplies: unknown[] = [];
      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:whitelist-channel-remove-confirm:en-US:111222333444555666",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => ({
          ...createScopeData(),
          whitelist: {
            channels: [
              {
                server_id: 1,
                channel_disc_id: "111222333444555666",
                cooldown_type: null,
                cooldown_length: null,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
            personaChannels: [],
            roles: [],
            personaNames: new Map(),
          },
        }),
        resolveChannel: async () => null,
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removePersonaUserBlock: async () => ({ status: "success", personaId: 1, targetUserId: "u" }),
          upsertWhitelistChannel: async () => ({
            status: "success",
            channelId: "c",
            cooldownType: null,
            cooldownLength: null,
            isUpdate: false,
          }),
          removeWhitelistChannel: async () => {
            removeCalled++;
            return { status: "success", channelId: "111222333444555666" };
          },
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-remove-confirm", "en-US", "111222333444555666"],
      });

      expect(removeCalled).toBe(0);
      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).toContain("Whitelist state changed");
    });

    it("renders changed-state receipt and does not call remove operation when resolved channel is not GuildText immediately before confirm", async () => {
      let removeCalled = 0;
      const editReplies: unknown[] = [];
      const mockInteraction = {
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        customId: "moderation:v1:whitelist-channel-remove-confirm:en-US:111222333444555666",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
      } as unknown as ButtonInteraction;

      const route = createModerationInteractionRoute({
        resolveScope: async () => ({
          ...createScopeData(),
          whitelist: {
            channels: [
              {
                server_id: 1,
                channel_disc_id: "111222333444555666",
                cooldown_type: null,
                cooldown_length: null,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
            personaChannels: [],
            roles: [],
            personaNames: new Map(),
          },
        }),
        resolveChannel: async (_i, id) => ({ id, name: "stage-channel", type: ChannelType.GuildStageVoice }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removePersonaUserBlock: async () => ({ status: "success", personaId: 1, targetUserId: "u" }),
          upsertWhitelistChannel: async () => ({
            status: "success",
            channelId: "c",
            cooldownType: null,
            cooldownLength: null,
            isUpdate: false,
          }),
          removeWhitelistChannel: async () => {
            removeCalled++;
            return { status: "success", channelId: "111222333444555666" };
          },
        },
      });

      await route.execute({} as Client, mockInteraction, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-remove-confirm", "en-US", "111222333444555666"],
      });

      expect(removeCalled).toBe(0);
      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).toContain("Whitelist state changed");
    });
  });

  describe("default Discord resolvers", () => {
    it("defaultResolveUser does not fall back to client.users.fetch when member is not in guild", async () => {
      let memberFetchCalled = false;
      let clientFetchCalled = false;

      const mockInteraction = {
        guild: {
          members: {
            fetch: async () => {
              memberFetchCalled = true;
              throw new Error("Unknown Member");
            },
          },
        },
        client: {
          users: {
            fetch: async (id: string) => {
              clientFetchCalled = true;
              return { id, username: "global-user", bot: false };
            },
          },
        },
      } as unknown as ModalSubmitInteraction;

      let addCalled = 0;
      const editReplies: unknown[] = [];

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeUserSelectValue: () => "123456789012345678",
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => {
            addCalled++;
            return { status: "success", targetUserId: "123456789012345678" };
          },
          removeUserFromBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removePersonaUserBlock: async () => ({ status: "success", personaId: 1, targetUserId: "u" }),
          upsertWhitelistChannel: async () => ({
            status: "success",
            channelId: "c",
            cooldownType: null,
            cooldownLength: null,
            isUpdate: false,
          }),
          removeWhitelistChannel: async () => ({ status: "success", channelId: "c" }),
        },
      });

      const modalSubmit = {
        ...mockInteraction,
        id: "modal-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:user-blacklist-add-submit:en-US:testnonce789",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
      } as unknown as ModalSubmitInteraction;

      await route.execute({} as Client, modalSubmit, {
        namespace: "moderation",
        version: "v1",
        segments: ["user-blacklist-add-submit", "en-US", "testnonce789"],
      });

      expect(memberFetchCalled).toBe(true);
      expect(clientFetchCalled).toBe(false);
      expect(addCalled).toBe(0);
      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).toContain("The selected user could not be found or is no longer in this server.");
    });

    it("defaultResolveChannel does not fall back to client.channels.fetch when channel is not in guild", async () => {
      let guildChannelFetchCalled = false;
      let clientChannelFetchCalled = false;

      const mockInteraction = {
        guild: {
          channels: {
            fetch: async () => {
              guildChannelFetchCalled = true;
              throw new Error("Unknown Channel");
            },
          },
        },
        client: {
          channels: {
            fetch: async (id: string) => {
              clientChannelFetchCalled = true;
              return { id, name: "external-channel", type: ChannelType.GuildText };
            },
          },
        },
      } as unknown as ModalSubmitInteraction;

      let upsertCalled = 0;
      const editReplies: unknown[] = [];

      const route = createModerationInteractionRoute({
        resolveScope: async () => createScopeData(),
        takeChannelSelectValue: () => "111222333444555666",
        takeCooldownTypeSelectValue: () => undefined,
        resolveWhitelistChannelAdd: async () => ({
          guildId: "guild-1",
          serverId: 1,
          readStatus: "fresh",
          config: { cooldown_type: null, cooldown_length: null },
        }),
        operations: {
          updateMemberPermissions: async () => ({ status: "success", changes: [], patch: {} }),
          addUserToBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removeUserFromBlacklist: async () => ({ status: "success", targetUserId: "u" }),
          removePersonaUserBlock: async () => ({ status: "success", personaId: 1, targetUserId: "u" }),
          upsertWhitelistChannel: async () => {
            upsertCalled++;
            return { status: "success", channelId: "c", cooldownType: null, cooldownLength: null, isUpdate: false };
          },
          removeWhitelistChannel: async () => ({ status: "success", channelId: "c" }),
        },
      });

      const modalSubmit = {
        ...mockInteraction,
        id: "modal-1",
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        customId: "moderation:v1:whitelist-channel-add-submit:en-US:testnonce789",
        guildId: "guild-1",
        memberPermissions: {
          has: () => true,
        },
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
        fields: {
          getTextInputValue: () => "",
        },
      } as unknown as ModalSubmitInteraction;

      await route.execute({} as Client, modalSubmit, {
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-channel-add-submit", "en-US", "testnonce789"],
      });

      expect(guildChannelFetchCalled).toBe(true);
      expect(clientChannelFetchCalled).toBe(false);
      expect(upsertCalled).toBe(0);
      expect(editReplies).toHaveLength(1);
      const serialized = JSON.stringify(editReplies[0]);
      expect(serialized).toContain(
        "The selected channel could not be found, is not a text channel, or is no longer in this server.",
      );
    });
  });
});

describe("moderation bulk removal routes", () => {
  it("opens one blacklist checklist modal without pre-deferring and snapshots the presented entries", async () => {
    const events: string[] = [];
    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      guildId: "guild-1",
      memberPermissions: { has: () => true },
      reply: async () => events.push("reply"),
      deferUpdate: async () => events.push("defer"),
    } as unknown as ButtonInteraction;
    const route = createModerationInteractionRoute({
      resolveScope: async () =>
        createScopeData({
          userBlacklist: {
            personalizationUserIds: ["123456789012345678"],
            personaBlocks: [],
            personalMemoriesEnabled: true,
          },
        }),
      resolveUser: async () => ({
        id: "123456789012345678",
        username: "jordan_h",
        displayName: "Jordan",
        bot: false,
      }),
      createNonce: () => "bulk_nonce",
      storeRemovalSnapshot: (nonce, values) => events.push(`snapshot:${nonce}:${values.join(",")}`),
      showRemovalModal: async (_interaction, _locale, nonce, action, options) => {
        events.push(`modal:${nonce}:${action}:${options[0]?.label}`);
      },
    });
    await route.execute({} as Client, interaction, {
      namespace: "moderation",
      version: "v1",
      segments: ["user-blacklist-remove-open", "en-US"],
    });
    expect(events).toEqual([
      "snapshot:bulk_nonce:u:123456789012345678",
      "modal:bulk_nonce:user-blacklist:Jordan (jordan_h)",
    ]);
  });

  it("removes only unchecked entries from the modal snapshot", async () => {
    const writes: unknown[] = [];
    const scope = createScopeData({
      userBlacklist: {
        personalizationUserIds: ["123456789012345678", "223456789012345678"],
        personaBlocks: [],
        personalMemoriesEnabled: true,
      },
    });
    const interaction = {
      id: "submit-1",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      guildId: "guild-1",
      memberPermissions: { has: () => true },
      deferUpdate: async () => undefined,
      editReply: async () => undefined,
    } as unknown as ModalSubmitInteraction;
    const route = createModerationInteractionRoute({
      resolveScope: async () => scope,
      takeRemovalSnapshot: () => ["u:123456789012345678", "u:223456789012345678"],
      takeRemovalCheckboxValues: (_id, _nonce, index) => (index === 0 ? ["u:223456789012345678"] : undefined),
      operations: {
        ...moderationOperations,
        removeUserBlacklistBatch: async (input) => {
          writes.push(input);
          return { status: "success", removedPersonalizationCount: 1, removedPersonaBlocks: [] };
        },
      },
    });
    await route.execute({} as Client, interaction, {
      namespace: "moderation",
      version: "v1",
      segments: ["user-blacklist-remove-submit", "en-US", "bulk_nonce"],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ personalizationUserIds: ["123456789012345678"], personaBlockKeys: [] });
  });
});

describe("moderation whitelist role routes", () => {
  it("opens the Role Select modal without pre-deferring or loading the full moderation scope", async () => {
    let deferred = false;
    let fullScopeReads = 0;
    let shownNonce = "";
    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      guildId: "guild-1",
      memberPermissions: { has: () => true },
      deferUpdate: async () => {
        deferred = true;
      },
      reply: async () => undefined,
    } as unknown as ButtonInteraction;
    const route = createModerationInteractionRoute({
      resolveScope: async () => {
        fullScopeReads++;
        return createScopeData();
      },
      resolveWhitelistRoleAdd: async () => ({
        guildId: "guild-1",
        serverId: 1,
        readStatus: "fresh",
        config: { cooldown_type: null, cooldown_length: null },
      }),
      createNonce: () => "roleNonce",
      showWhitelistRoleAddModal: async (_interaction, _locale, nonce) => {
        shownNonce = nonce;
      },
    });

    await route.execute({} as Client, interaction, {
      namespace: "moderation",
      version: "v1",
      segments: ["whitelist-role-add-open", "en-US"],
    });

    expect(deferred).toBe(false);
    expect(fullScopeReads).toBe(0);
    expect(shownNonce).toBe("roleNonce");
  });

  it("adds a current guild role and rejects the everyone role before writing", async () => {
    const writes: string[] = [];
    const edits: unknown[] = [];
    const interaction = {
      id: "modal-role",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      guildId: "guild-1",
      memberPermissions: { has: () => true },
      deferUpdate: async () => undefined,
      editReply: async (payload: unknown) => {
        edits.push(payload);
      },
    } as unknown as ModalSubmitInteraction;
    const roleScope = {
      guildId: "guild-1",
      serverId: 1,
      readStatus: "fresh" as const,
      config: { cooldown_type: null, cooldown_length: null },
    };
    const route = createModerationInteractionRoute({
      resolveScope: async () => createScopeData(),
      resolveWhitelistRoleAdd: async () => roleScope,
      takeRoleSelectValue: () => "123456789012345678",
      resolveRole: async (_interaction, id) => ({ id, name: "Members" }),
      operations: {
        ...moderationOperations,
        addWhitelistRole: async (input) => {
          writes.push(input.roleId);
          return { status: "success", roleId: input.roleId };
        },
      },
    });

    await route.execute({} as Client, interaction, {
      namespace: "moderation",
      version: "v1",
      segments: ["whitelist-role-add-submit", "en-US", "nonce123"],
    });
    expect(writes).toEqual(["123456789012345678"]);
    expect(JSON.stringify(edits.at(-1))).toContain("Role added to whitelist");

    const everyoneRoute = createModerationInteractionRoute({
      resolveScope: async () => createScopeData({ guildId: "123456789012345678" }),
      resolveWhitelistRoleAdd: async () => ({ ...roleScope, guildId: "123456789012345678" }),
      takeRoleSelectValue: () => "123456789012345678",
      resolveRole: async (_interaction, id) => ({ id, name: "@everyone" }),
      operations: {
        ...moderationOperations,
        addWhitelistRole: async (input) => {
          writes.push(input.roleId);
          return { status: "success", roleId: input.roleId };
        },
      },
    });
    const everyoneInteraction = {
      ...interaction,
      guildId: "123456789012345678",
    } as unknown as ModalSubmitInteraction;
    await everyoneRoute.execute({} as Client, everyoneInteraction, {
      namespace: "moderation",
      version: "v1",
      segments: ["whitelist-role-add-submit", "en-US", "nonce123"],
    });
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(edits.at(-1))).toContain("everyone role cannot be whitelisted");
  });

  it("re-resolves a whitelisted role before prompt and again before the confirmed write", async () => {
    let resolves = 0;
    let removes = 0;
    const edits: unknown[] = [];
    const roleId = "123456789012345678";
    const scope = createScopeData({
      whitelist: {
        channels: [],
        personaChannels: [],
        roles: [{ server_id: 1, role_disc_id: roleId, created_at: new Date(), updated_at: new Date() }],
        personaNames: new Map(),
      },
    });
    const interaction = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      guildId: "guild-1",
      memberPermissions: { has: () => true },
      deferUpdate: async () => undefined,
      editReply: async (payload: unknown) => {
        edits.push(payload);
      },
    } as unknown as ButtonInteraction;
    const route = createModerationInteractionRoute({
      resolveScope: async () => scope,
      resolveRole: async (_interaction, id) => {
        resolves++;
        return { id, name: "Members" };
      },
      operations: {
        ...moderationOperations,
        removeWhitelistRole: async (input) => {
          removes++;
          return { status: "success", roleId: input.roleId };
        },
      },
    });

    await route.execute({} as Client, interaction, {
      namespace: "moderation",
      version: "v1",
      segments: ["whitelist-role-remove-prompt", "en-US", roleId],
    });
    expect(JSON.stringify(edits.at(-1))).toContain("whitelist-role-remove-confirm");

    await route.execute({} as Client, interaction, {
      namespace: "moderation",
      version: "v1",
      segments: ["whitelist-role-remove-confirm", "en-US", roleId],
    });
    expect(resolves).toBe(2);
    expect(removes).toBe(1);
    expect(JSON.stringify(edits.at(-1))).toContain("Role removed from whitelist");
  });

  it("uses the current guild role manager and does not write when the selected role disappeared", async () => {
    let writes = 0;
    let fetches = 0;
    const edits: unknown[] = [];
    const interaction = {
      id: "modal-role-default-resolver",
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      guildId: "guild-1",
      guild: {
        roles: {
          fetch: async () => {
            fetches++;
            return null;
          },
        },
      },
      memberPermissions: { has: () => true },
      deferUpdate: async () => undefined,
      editReply: async (payload: unknown) => {
        edits.push(payload);
      },
    } as unknown as ModalSubmitInteraction;
    const route = createModerationInteractionRoute({
      resolveScope: async () => createScopeData(),
      resolveWhitelistRoleAdd: async () => ({
        guildId: "guild-1",
        serverId: 1,
        readStatus: "fresh",
        config: { cooldown_type: null, cooldown_length: null },
      }),
      takeRoleSelectValue: () => "123456789012345678",
      operations: {
        ...moderationOperations,
        addWhitelistRole: async (input) => {
          writes++;
          return { status: "success", roleId: input.roleId };
        },
      },
    });

    await route.execute({} as Client, interaction, {
      namespace: "moderation",
      version: "v1",
      segments: ["whitelist-role-add-submit", "en-US", "nonce123"],
    });

    expect(fetches).toBe(1);
    expect(writes).toBe(0);
    expect(JSON.stringify(edits.at(-1))).toContain("selected role is invalid");
  });
});
