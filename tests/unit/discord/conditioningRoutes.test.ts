import { beforeAll, describe, expect, it } from "bun:test";
import { MessageFlags, type ButtonInteraction, type Client, type ModalSubmitInteraction } from "discord.js";
import {
  createConditioningInteractionRoute,
  type ConditioningRouteDependencies,
} from "@/utils/discord/interactions/conditioningRoutes";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildConditioningRouteId,
  computeConditioningAggregateFingerprint,
  type ConditioningAggregateEntry,
  type ConditioningPanelRoute,
} from "@/utils/discord/conditioningPanelCatalog";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const CLIENT = {} as Client;

function makeEntry(overrides: Partial<ConditioningAggregateEntry> = {}): ConditioningAggregateEntry {
  return {
    serverId: 1,
    personaName: "Tomori",
    personaLineageId: 101,
    conditioningType: "reward",
    actionKey: "feed",
    reasonText: "did well",
    reasonNormalized: "did well",
    actionText: null,
    totalCount: 1,
    updatedAt: new Date(1_000_000),
    userDiscIds: ["u1"],
    conditioningIds: [1],
    ...overrides,
  };
}

interface MockInteractionOptions {
  guildId?: string | null;
  hasPermission?: boolean;
  isButton?: boolean;
  isModalSubmit?: boolean;
}

function parseRouteOrThrow(customId: string) {
  const parsed = parseInteractionRoute(customId);
  if (!parsed) throw new Error(`Route parse failed: ${customId}`);
  return parsed;
}

function createMockInteraction(customId: string, options: MockInteractionOptions = {}) {
  const { guildId = "guild-1", hasPermission = true, isButton = true, isModalSubmit = false } = options;
  let repliedMessage: unknown = null;
  let editedReply: unknown = null;
  let deferredUpdate = false;
  let deferredReplyPayload: unknown = null;
  let deferredReplyCount = 0;

  const interaction = {
    id: "interaction-1",
    customId,
    guildId,
    user: { id: "user-1" },
    memberPermissions: {
      has: () => hasPermission,
    },
    deferred: false,
    replied: false,
    isButton: () => isButton,
    isModalSubmit: () => isModalSubmit,
    isStringSelectMenu: () => false,
    isMessageComponent: () => isButton,
    reply: async (payload: unknown) => {
      repliedMessage = payload;
      interaction.replied = true;
      return payload;
    },
    deferUpdate: async () => {
      deferredUpdate = true;
      interaction.deferred = true;
    },
    deferReply: async (payload: unknown) => {
      deferredReplyPayload = payload;
      deferredReplyCount += 1;
      interaction.deferred = true;
    },
    editReply: async (payload: unknown) => {
      editedReply = payload;
      return payload;
    },
    getRepliedMessage: () => repliedMessage,
    getEditedReply: () => editedReply,
    getDeferredReply: () => deferredReplyPayload,
    getDeferredReplyCount: () => deferredReplyCount,
    wasDeferredUpdate: () => deferredUpdate,
  };

  return interaction;
}

describe("conditioning panel routes", () => {
  it("denies access to a non-manager before reading or deleting anything", async () => {
    let deleteCalled = false;
    let modalShown = false;
    const dependencies: ConditioningRouteDependencies = {
      resolveScope: async () => ({ guildId: "guild-1", entries: [makeEntry()] }),
      deleteGroups: async () => {
        deleteCalled = true;
        return 1;
      },
      showRemoveModal: async () => {
        modalShown = true;
      },
      takeCheckboxValues: () => ["0"],
      createNonce: () => "nonce123",
    };

    const route = createConditioningInteractionRoute(dependencies);

    const pageRoute: ConditioningPanelRoute = {
      action: "page",
      locale: "en-US",
      page: 0,
    };
    const pageCustomId = buildConditioningRouteId(pageRoute);
    const parsedPage = parseRouteOrThrow(pageCustomId);

    const nonManagerInteraction = createMockInteraction(pageCustomId, { hasPermission: false });
    await route.execute(CLIENT, nonManagerInteraction as unknown as ButtonInteraction, parsedPage);

    expect(deleteCalled).toBe(false);
    expect(modalShown).toBe(false);
    expect(nonManagerInteraction.getRepliedMessage()).toEqual({
      content: localizer("en-US", "general.errors.permission_denied_description"),
      flags: 64,
    });
  });

  it("opens modal directly when page button is clicked without deferUpdate", async () => {
    let modalShown = false;
    let modalFp: string | null = null;
    const entries = [makeEntry({ reasonNormalized: "matching entry" })];
    const validFp = computeConditioningAggregateFingerprint(entries, 0);

    const dependencies: ConditioningRouteDependencies = {
      resolveScope: async () => ({ guildId: "guild-1", entries }),
      deleteGroups: async () => 0,
      showRemoveModal: async (_interaction, _locale, _page, fp) => {
        modalShown = true;
        modalFp = fp;
      },
      takeCheckboxValues: () => undefined,
      createNonce: () => "nonce123",
    };

    const route = createConditioningInteractionRoute(dependencies);

    const pageRoute: ConditioningPanelRoute = {
      action: "page",
      locale: "en-US",
      page: 0,
    };
    const pageCustomId = buildConditioningRouteId(pageRoute);
    const parsedPage = parseRouteOrThrow(pageCustomId);

    const interaction = createMockInteraction(pageCustomId, { isButton: true });
    await route.execute(CLIENT, interaction as unknown as ButtonInteraction, parsedPage);

    expect(interaction.wasDeferredUpdate()).toBe(false);
    expect(modalShown).toBe(true);
    expect(modalFp).toBe(validFp);
  });

  it("deletes nothing when remove-submit has a stale fingerprint", async () => {
    let deleteCalled = false;
    const entries = [makeEntry({ reasonNormalized: "fresh entry" })];
    const dependencies: ConditioningRouteDependencies = {
      resolveScope: async () => ({ guildId: "guild-1", entries }),
      deleteGroups: async () => {
        deleteCalled = true;
        return 1;
      },
      showRemoveModal: async () => {},
      takeCheckboxValues: () => ["0"],
      createNonce: () => "nonce123",
    };

    const route = createConditioningInteractionRoute(dependencies);

    const submitRoute: ConditioningPanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: "stale_fp",
      nonce: "nonce123",
    };
    const submitCustomId = buildConditioningRouteId(submitRoute);
    const parsedSubmit = parseRouteOrThrow(submitCustomId);

    const interaction = createMockInteraction(submitCustomId, { isButton: false, isModalSubmit: true });
    await route.execute(CLIENT, interaction as unknown as ModalSubmitInteraction, parsedSubmit);

    expect(deleteCalled).toBe(false);
    const edited = interaction.getEditedReply() as { components: unknown[] };
    expect(edited).toBeDefined();
    const payloadText = JSON.stringify(edited);
    expect(payloadText).toContain(localizer("en-US", "commands.conditioning.panel.stale_heading"));
  });

  it("deletes nothing when remove-submit lacks checkbox evidence", async () => {
    let deleteCalled = false;
    const entries = [makeEntry({ reasonNormalized: "evidence test entry" })];
    const validFp = computeConditioningAggregateFingerprint(entries, 0);

    const dependencies: ConditioningRouteDependencies = {
      resolveScope: async () => ({ guildId: "guild-1", entries }),
      deleteGroups: async () => {
        deleteCalled = true;
        return 1;
      },
      showRemoveModal: async () => {},
      takeCheckboxValues: () => undefined,
      createNonce: () => "nonce123",
    };

    const route = createConditioningInteractionRoute(dependencies);

    const submitRoute: ConditioningPanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: validFp,
      nonce: "nonce123",
    };
    const submitCustomId = buildConditioningRouteId(submitRoute);
    const parsedSubmit = parseRouteOrThrow(submitCustomId);

    const interaction = createMockInteraction(submitCustomId, { isButton: false, isModalSubmit: true });
    await route.execute(CLIENT, interaction as unknown as ModalSubmitInteraction, parsedSubmit);

    expect(deleteCalled).toBe(false);
    const edited = interaction.getEditedReply() as { components: unknown[] };
    expect(edited).toBeDefined();
    const payloadText = JSON.stringify(edited);
    expect(payloadText).toContain(localizer("en-US", "commands.conditioning.panel.stale_heading"));
  });

  it("acknowledges an aggregate all-selected submit as an ephemeral no-op", async () => {
    let deleteCalled = false;
    let interaction: ReturnType<typeof createMockInteraction>;
    const entries = [makeEntry({ reasonNormalized: "already selected" })];
    const validFp = computeConditioningAggregateFingerprint(entries, 0);
    const dependencies: ConditioningRouteDependencies = {
      resolveScope: async () => {
        expect(interaction.getDeferredReplyCount()).toBe(1);
        return { guildId: "guild-1", entries };
      },
      deleteGroups: async () => {
        deleteCalled = true;
        return 1;
      },
      showRemoveModal: async () => {},
      takeCheckboxValues: () => ["0"],
      createNonce: () => "nonce123",
    };

    const route = createConditioningInteractionRoute(dependencies);
    const submitRoute: ConditioningPanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: validFp,
      nonce: "nonce123",
    };
    const submitCustomId = buildConditioningRouteId(submitRoute);
    const parsedSubmit = parseRouteOrThrow(submitCustomId);
    interaction = createMockInteraction(submitCustomId, { isButton: false, isModalSubmit: true });

    await route.execute(CLIENT, interaction as unknown as ModalSubmitInteraction, parsedSubmit);

    expect(interaction.getDeferredReply()).toEqual({ flags: MessageFlags.Ephemeral });
    expect(interaction.wasDeferredUpdate()).toBe(false);
    expect(deleteCalled).toBe(false);
    const edited = interaction.getEditedReply() as { embeds: unknown[] };
    expect(edited).toBeDefined();
    const payloadText = JSON.stringify(edited);
    expect(payloadText).toContain(localizer("en-US", "commands.conditioning.panel.no_changes_heading"));
    expect(payloadText).toContain(localizer("en-US", "commands.conditioning.panel.no_changes_detail"));
  });

  it("normal submit deletes unchecked groups grouped by persona lineage", async () => {
    const entry0 = makeEntry({
      personaLineageId: 101,
      serverId: 1,
      conditioningType: "reward",
      actionKey: "feed",
      reasonNormalized: "reason 0",
    });
    const entry1 = makeEntry({
      personaLineageId: 101,
      serverId: 1,
      conditioningType: "reward",
      actionKey: "tickle",
      reasonNormalized: "reason 1",
    });
    const entry2 = makeEntry({
      personaLineageId: 202,
      serverId: 1,
      conditioningType: "punish",
      actionKey: "bonk",
      reasonNormalized: "reason 2",
    });

    const entries = [entry0, entry1, entry2];
    const validFp = computeConditioningAggregateFingerprint(entries, 0);

    const deleteCalls: Array<{
      serverId: number;
      personaLineageId: number;
      groups: Array<{ conditioningType: string; actionKey: string; reasonNormalized: string }>;
    }> = [];

    const dependencies: ConditioningRouteDependencies = {
      resolveScope: async () => ({ guildId: "guild-1", entries }),
      deleteGroups: async (serverId, personaLineageId, groups) => {
        deleteCalls.push({ serverId, personaLineageId, groups });
        return groups.length;
      },
      showRemoveModal: async () => {},
      // Only index 0 remained checked; index 1 and index 2 were unchecked
      takeCheckboxValues: () => ["0"],
      createNonce: () => "nonce123",
    };

    const route = createConditioningInteractionRoute(dependencies);

    const submitRoute: ConditioningPanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: validFp,
      nonce: "nonce123",
    };
    const submitCustomId = buildConditioningRouteId(submitRoute);
    const parsedSubmit = parseRouteOrThrow(submitCustomId);

    const interaction = createMockInteraction(submitCustomId, { isButton: false, isModalSubmit: true });
    await route.execute(CLIENT, interaction as unknown as ModalSubmitInteraction, parsedSubmit);

    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0]).toEqual({
      serverId: 1,
      personaLineageId: 101,
      groups: [{ conditioningType: "reward", actionKey: "tickle", reasonNormalized: "reason 1" }],
    });
    expect(deleteCalls[1]).toEqual({
      serverId: 1,
      personaLineageId: 202,
      groups: [{ conditioningType: "punish", actionKey: "bonk", reasonNormalized: "reason 2" }],
    });

    const edited = interaction.getEditedReply() as { components: unknown[] };
    expect(edited).toBeDefined();
    const payloadText = JSON.stringify(edited);
    expect(payloadText).toContain(localizer("en-US", "commands.conditioning.panel.success_heading"));
    expect(payloadText).toContain(localizer("en-US", "commands.conditioning.panel.success_detail", { count: "2" }));
  });

  it("verifies non-vacuity of fingerprint check", async () => {
    // Proves that when fingerprint check is bypassed/weakened, deletions occur on stale data,
    // but with the active guard, deletions are strictly blocked.
    const initialEntries = [
      makeEntry({ personaLineageId: 101, conditioningType: "reward", actionKey: "feed", reasonNormalized: "old" }),
    ];
    const oldFp = computeConditioningAggregateFingerprint(initialEntries, 0);

    const updatedEntries = [
      makeEntry({ personaLineageId: 101, conditioningType: "reward", actionKey: "feed", reasonNormalized: "new" }),
    ];
    const newFp = computeConditioningAggregateFingerprint(updatedEntries, 0);
    expect(oldFp).not.toBe(newFp);

    let deleteCallCount = 0;
    const dependencies: ConditioningRouteDependencies = {
      resolveScope: async () => ({ guildId: "guild-1", entries: updatedEntries }),
      deleteGroups: async (_serverId, _personaLineageId, groups) => {
        deleteCallCount += groups.length;
        return groups.length;
      },
      showRemoveModal: async () => {},
      takeCheckboxValues: () => [], // unchecked everything
      createNonce: () => "nonce123",
    };

    const route = createConditioningInteractionRoute(dependencies);

    // Stale submission (using oldFp against updated entries)
    const staleRoute: ConditioningPanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: oldFp,
      nonce: "nonce123",
    };
    const staleInteraction = createMockInteraction(buildConditioningRouteId(staleRoute), {
      isButton: false,
      isModalSubmit: true,
    });
    await route.execute(
      CLIENT,
      staleInteraction as unknown as ModalSubmitInteraction,
      parseRouteOrThrow(staleInteraction.customId),
    );

    // Guard blocked the deletion
    expect(deleteCallCount).toBe(0);

    // Matching submission (using newFp against updated entries)
    const freshRoute: ConditioningPanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: newFp,
      nonce: "nonce123",
    };
    const freshInteraction = createMockInteraction(buildConditioningRouteId(freshRoute), {
      isButton: false,
      isModalSubmit: true,
    });
    await route.execute(
      CLIENT,
      freshInteraction as unknown as ModalSubmitInteraction,
      parseRouteOrThrow(freshInteraction.customId),
    );

    // Deletion succeeded only with valid fingerprint
    expect(deleteCallCount).toBe(1);
  });
});
