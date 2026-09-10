import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { MessageFlags, type Client } from "discord.js";
import type { MemoryBucket } from "@/types/db/dataExport";
import type { TomoriState } from "@/types/db/schema";
import { cache } from "@/utils/cache/tomoriStateCacheStore";
import {
  buildTransferRouteId,
  parseTransferPanelRoute,
  type TransferPanelRoute,
} from "@/utils/discord/transferCatalog";
import { dispatchGlobalInteraction } from "@/utils/discord/interactions/router";
import {
  readTransferSnapshot,
  resetTransferSnapshots,
  storeTransferSnapshot,
  type TransferSnapshotRecordInput,
} from "@/utils/discord/interactions/transferSnapshotStore";
import {
  createTransferInteractionRoute,
  resolveMemoryMappingPlan,
  resolveSelectedConfigSections,
  transferInteractionRoute,
} from "@/utils/discord/interactions/transferRoutes";
import { buildConfigSectionChecklistModal, buildConfigSectionCheckboxGroupId } from "@/utils/discord/ui/transferPanel";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

type InteractionKind = "button" | "string" | "modal";

type MockInteractionOptions = {
  customId: string;
  kind: InteractionKind;
  actorDiscId?: string;
  guildId?: string | null;
  canManageGuild?: boolean;
  /** Reproduces discord.js resolving `guild` from the client cache while `guildId` comes from the payload. */
  guildCached?: boolean;
  values?: string[];
};

function makeInteraction({
  customId,
  kind,
  actorDiscId = "actor-1",
  guildId = null,
  canManageGuild = false,
  guildCached = true,
  values = [],
}: MockInteractionOptions): GlobalRoutableInteraction {
  return {
    id: `interaction-${customId}`,
    customId,
    locale: "en-US",
    guildLocale: "en-US",
    user: { id: actorDiscId },
    guildId,
    guild: guildId && guildCached ? { id: guildId } : null,
    memberPermissions: { has: (permission: string) => permission === "ManageGuild" && canManageGuild },
    replied: false,
    deferred: false,
    type: 3,
    isMessageComponent: () => true,
    isModalSubmit: () => kind === "modal",
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "string",
    values,
    reply: async () => {},
    update: async () => {},
    fetchReply: async () => ({}),
  } as unknown as GlobalRoutableInteraction;
}

function makeMemoryBuckets(count = 2): MemoryBucket[] {
  return Array.from({ length: count }, (_unused, index) => ({
    name: `bucket-${index}`,
    label: `Bucket ${index}`,
    memories: [{ content: `Memory ${index}`, tags: [] }],
  }));
}

function makeMemoryRecord(
  overrides: Partial<TransferSnapshotRecordInput> & {
    buckets?: MemoryBucket[];
    mapping?: Record<string, number | "skip">;
  } = {},
): TransferSnapshotRecordInput {
  const { buckets = makeMemoryBuckets(), mapping, ...recordOverrides } = overrides;
  return makeRecord({
    kind: "workspace_memories",
    ownership: "workspace",
    destinationKey: "guild-1",
    strategy: "merge",
    ...recordOverrides,
    exportResult: {
      success: true,
      sourceVersion: "2.0",
      sourceType: "workspace_memories",
      detectedSections: buckets.map((bucket) => bucket.name),
      payload: { buckets },
      droppedFields: [],
    },
    ...(mapping ? { mapping } : {}),
  });
}

function seedMemoryDestinations(count = 2): void {
  const personas = Array.from({ length: count }, (_unused, index) => ({
    persona_id: index + 1,
    persona_lineage_id: index + 100,
    persona_nickname: `Persona ${index}`,
  })) as unknown as TomoriState[];
  const mainPersona = personas[0];
  if (!mainPersona) throw new Error("Memory destination fixture requires a persona");
  cache.set("guild-1", { personas, mainPersona, cachedAt: Date.now() });
}

afterEach(() => {
  cache.delete("guild-1");
  resetTransferSnapshots();
});

function makeRecord(
  overrides: Partial<TransferSnapshotRecordInput> & { detectedSections?: string[] } = {},
): TransferSnapshotRecordInput {
  const { detectedSections, exportResult, ...recordOverrides } = overrides;
  return {
    actorDiscId: "actor-1",
    kind: "workspace_config",
    ownership: "personal",
    destinationKey: "actor-1",
    fingerprint: "fingerprint-1",
    exportResult: {
      success: true,
      sourceVersion: "2.0",
      sourceType: "workspace_config",
      detectedSections: detectedSections ?? ["chat"],
      payload: {},
      droppedFields: [],
    },
    ...recordOverrides,
    ...(exportResult ? { exportResult: { ...exportResult, ...(detectedSections ? { detectedSections } : {}) } } : {}),
  };
}

function makeRouteId(route: TransferPanelRoute): string {
  return buildTransferRouteId(route);
}

beforeAll(async () => initializeLocalizer());

describe("transfer interaction routes", () => {
  it("dispatches transfer v2 through the registered namespace stale-version branch", async () => {
    const interaction = makeInteraction({
      customId: "transfer:v2:cancel:en-US:nonce-1234",
      kind: "button",
    });
    const replySpy = spyOn(interaction, "reply");

    await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);
    expect(replySpy).toHaveBeenCalledWith({
      content: localizer("en-US", "general.errors.outdated_panel", { command: "/import" }),
      flags: MessageFlags.Ephemeral,
    });
  });

  it("refuses an unauthorized workspace interaction and preserves the snapshot", async () => {
    resetTransferSnapshots();
    storeTransferSnapshot("nonce-1234", makeRecord({ ownership: "workspace", destinationKey: "guild-1" }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: "nonce-1234" }),
      kind: "button",
      guildId: "guild-1",
    });
    const refusalReply = spyOn(interaction, "reply");

    await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);
    const refusalPayload = refusalReply.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(refusalPayload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.permission_denied_description"),
    );
    const authorizedInteraction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: "nonce-1234" }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const authorizedReply = spyOn(authorizedInteraction, "reply");
    await expect(dispatchGlobalInteraction({} as Client, authorizedInteraction)).resolves.toBe(true);
    const authorizedPayload = authorizedReply.mock.calls[0]?.[0] as {
      embeds: Array<{ data: { description?: string } }>;
    };
    expect(authorizedPayload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.unavailable_description"),
    );
    expect(readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1").status).toBe("ok");
  });

  it("accepts a DM-backed workspace interaction for its actor", async () => {
    resetTransferSnapshots();
    storeTransferSnapshot("nonce-1234", makeRecord({ ownership: "workspace", destinationKey: "actor-1" }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: "nonce-1234" }),
      kind: "button",
      canManageGuild: false,
    });
    const replySpy = spyOn(interaction, "reply");

    await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(localizer("en-US", "commands.transfer.unavailable_description"));
  });

  it("refuses a DM-backed workspace interaction inside a guild", async () => {
    resetTransferSnapshots();
    storeTransferSnapshot("nonce-1234", makeRecord({ ownership: "workspace", destinationKey: "actor-1" }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: "nonce-1234" }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const replySpy = spyOn(interaction, "reply");

    await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.permission_denied_description"),
    );
    expect(readTransferSnapshot("nonce-1234", "actor-1", "workspace", "actor-1").status).toBe("ok");
  });

  it("refuses a guild workspace interaction in a DM", async () => {
    resetTransferSnapshots();
    storeTransferSnapshot("nonce-1234", makeRecord({ ownership: "workspace", destinationKey: "guild-1" }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: "nonce-1234" }),
      kind: "button",
      canManageGuild: false,
    });
    const replySpy = spyOn(interaction, "reply");

    await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.permission_denied_description"),
    );
    expect(readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1").status).toBe("ok");
  });

  it("still requires ManageGuild when the guild is absent from the client cache", async () => {
    resetTransferSnapshots();
    storeTransferSnapshot("nonce-1234", makeRecord({ ownership: "workspace", destinationKey: "guild-1" }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: "nonce-1234" }),
      kind: "button",
      guildId: "guild-1",
      guildCached: false,
      canManageGuild: false,
    });
    const replySpy = spyOn(interaction, "reply");

    await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.permission_denied_description"),
    );
    expect(readTransferSnapshot("nonce-1234", "actor-1", "workspace", "guild-1").status).toBe("ok");
  });

  it("refuses an unknown nonce with the localized expired message", async () => {
    resetTransferSnapshots();
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: "nonce-1234" }),
      kind: "button",
    });
    const replySpy = spyOn(interaction, "reply");

    await dispatchGlobalInteraction({} as Client, interaction);

    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.snapshot_expired_description"),
    );
  });

  it("consumes on cancel and refuses a second cancel", async () => {
    resetTransferSnapshots();
    storeTransferSnapshot("nonce-1234", makeRecord());
    const routeId = makeRouteId({ action: "cancel", locale: "en-US", nonce: "nonce-1234" });

    await dispatchGlobalInteraction({} as Client, makeInteraction({ customId: routeId, kind: "button" }));
    expect(readTransferSnapshot("nonce-1234", "actor-1", "personal", "actor-1").status).toBe("missing");

    const secondInteraction = makeInteraction({ customId: routeId, kind: "button" });
    const replySpy = spyOn(secondInteraction, "reply");
    await dispatchGlobalInteraction({} as Client, secondInteraction);
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.snapshot_expired_description"),
    );
  });

  it("does not consume a non-terminal action", async () => {
    resetTransferSnapshots();
    storeTransferSnapshot("nonce-1234", makeRecord());
    await dispatchGlobalInteraction(
      {} as Client,
      makeInteraction({
        customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: "nonce-1234" }),
        kind: "button",
      }),
    );

    expect(readTransferSnapshot("nonce-1234", "actor-1", "personal", "actor-1").status).toBe("ok");
  });

  it("rejects interaction-kind mismatches", async () => {
    const route = createTransferInteractionRoute();
    const modalRoute = parseInteractionRoute(
      makeRouteId({ action: "config-apply", locale: "en-US", nonce: "nonce-1234" }),
    );
    const buttonRoute = parseInteractionRoute(
      makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: "nonce-2345" }),
    );
    const memoryMapRoute = parseInteractionRoute(
      makeRouteId({ action: "memory-map", locale: "en-US", nonce: "nonce-3456", bucketIndex: 0, destPage: 0 }),
    );
    const memoryBucketSelectRoute = parseInteractionRoute(
      makeRouteId({ action: "memory-bucket-select", locale: "en-US", nonce: "nonce-4567", bucketPage: 0 }),
    );
    const memoryBucketPageRoute = parseInteractionRoute(
      makeRouteId({ action: "memory-bucket-page", locale: "en-US", nonce: "nonce-5678", bucketPage: 0 }),
    );
    expect(modalRoute).not.toBeNull();
    expect(buttonRoute).not.toBeNull();
    expect(memoryMapRoute).not.toBeNull();
    expect(memoryBucketSelectRoute).not.toBeNull();
    expect(memoryBucketPageRoute).not.toBeNull();
    if (!modalRoute || !buttonRoute || !memoryMapRoute || !memoryBucketSelectRoute || !memoryBucketPageRoute)
      throw new Error("Route did not parse for interaction kind test");

    await expect(
      route.execute(
        {} as Client,
        makeInteraction({
          customId: makeRouteId({ action: "config-apply", locale: "en-US", nonce: "nonce-1234" }),
          kind: "button",
        }),
        modalRoute,
      ),
    ).rejects.toThrow("modal submission");
    await expect(
      transferInteractionRoute.execute(
        {} as Client,
        makeInteraction({
          customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: "nonce-2345" }),
          kind: "modal",
        }),
        buttonRoute,
      ),
    ).rejects.toThrow("button interaction");
    await expect(
      transferInteractionRoute.execute(
        {} as Client,
        makeInteraction({
          customId: makeRouteId({
            action: "memory-map",
            locale: "en-US",
            nonce: "nonce-3456",
            bucketIndex: 0,
            destPage: 0,
          }),
          kind: "button",
        }),
        memoryMapRoute,
      ),
    ).rejects.toThrow("string select");
    await expect(
      transferInteractionRoute.execute(
        {} as Client,
        makeInteraction({
          customId: makeRouteId({
            action: "memory-bucket-select",
            locale: "en-US",
            nonce: "nonce-4567",
            bucketPage: 0,
          }),
          kind: "button",
        }),
        memoryBucketSelectRoute,
      ),
    ).rejects.toThrow("string select");
    await expect(
      transferInteractionRoute.execute(
        {} as Client,
        makeInteraction({
          customId: makeRouteId({ action: "memory-bucket-page", locale: "en-US", nonce: "nonce-5678", bucketPage: 0 }),
          kind: "string",
        }),
        memoryBucketPageRoute,
      ),
    ).rejects.toThrow("button interaction");
  });

  it("replies for a valid memory map string select", async () => {
    resetTransferSnapshots();
    storeTransferSnapshot("nonce-1234", makeRecord());
    const interaction = makeInteraction({
      customId: makeRouteId({
        action: "memory-map",
        locale: "en-US",
        nonce: "nonce-1234",
        bucketIndex: 0,
        destPage: 0,
      }),
      kind: "string",
    });
    const replySpy = spyOn(interaction, "reply");

    await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(localizer("en-US", "commands.transfer.unavailable_description"));
  });

  it("resolves memory mapping rules without mutating the inputs", () => {
    const buckets = makeMemoryBuckets(3);
    expect(resolveMemoryMappingPlan(buckets, { "bucket-0": 100, "bucket-1": "skip" })).toEqual({
      status: "refused",
      reason: "unresolved",
      bucketName: "bucket-2",
    });
    expect(resolveMemoryMappingPlan(buckets, { "bucket-0": 100, "bucket-1": 100, "bucket-2": "skip" })).toEqual({
      status: "refused",
      reason: "duplicate-destination",
      bucketName: "bucket-1",
      destinationLineageId: 100,
    });
    expect(resolveMemoryMappingPlan(buckets, { "bucket-0": "skip", "bucket-1": "skip", "bucket-2": "skip" })).toEqual({
      status: "refused",
      reason: "all-skipped",
    });
    expect(resolveMemoryMappingPlan(buckets, { "bucket-0": "skip", "bucket-1": 101, "bucket-2": "skip" })).toEqual({
      status: "ok",
      plan: [
        { bucketName: "bucket-0", destinationLineageId: "skip" },
        { bucketName: "bucket-1", destinationLineageId: 101 },
        { bucketName: "bucket-2", destinationLineageId: "skip" },
      ],
    });
  });

  it("preserves the first memory binding when binding a second bucket", async () => {
    const nonce = "nonce-memory-preserve-binding";
    storeTransferSnapshot(nonce, makeMemoryRecord({ mapping: { "bucket-0": 100 } }));
    seedMemoryDestinations();
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-map", locale: "en-US", nonce, bucketIndex: 1, destPage: 0 }),
      kind: "string",
      guildId: "guild-1",
      canManageGuild: true,
      values: ["101"],
    });
    const updateSpy = spyOn(interaction, "update");

    await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const result = readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.snapshot.mapping).toEqual({ "bucket-0": 100, "bucket-1": 101 });
      expect(result.snapshot.selectedBucket).toBe("bucket-1");
    }
  });

  it("refuses an out-of-range memory bucket index without mutating the snapshot", async () => {
    const nonce = "nonce-memory-bucket-bounds";
    storeTransferSnapshot(nonce, makeMemoryRecord({ mapping: { "bucket-0": 100, "bucket-1": "skip" } }));
    seedMemoryDestinations();
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-map", locale: "en-US", nonce, bucketIndex: 2, destPage: 0 }),
      kind: "string",
      guildId: "guild-1",
      canManageGuild: true,
      values: ["100"],
    });
    const replySpy = spyOn(interaction, "reply");

    await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);

    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.memory_bucket_index_invalid_description"),
    );
    const result = readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.snapshot.mapping).toEqual({ "bucket-0": 100, "bucket-1": "skip" });
  });

  it("refuses mapping without a chosen strategy and refuses personal mappings", async () => {
    const noStrategyNonce = "nonce-memory-no-strategy";
    storeTransferSnapshot(noStrategyNonce, makeMemoryRecord({ strategy: undefined }));
    seedMemoryDestinations();
    const noStrategyInteraction = makeInteraction({
      customId: makeRouteId({
        action: "memory-map",
        locale: "en-US",
        nonce: noStrategyNonce,
        bucketIndex: 0,
        destPage: 0,
      }),
      kind: "string",
      guildId: "guild-1",
      canManageGuild: true,
      values: ["100"],
    });
    const noStrategyReply = spyOn(noStrategyInteraction, "reply");
    await expect(dispatchGlobalInteraction({} as Client, noStrategyInteraction)).resolves.toBe(true);
    expect(
      (noStrategyReply.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> }).embeds[0]?.data
        .description,
    ).toBe(localizer("en-US", "commands.transfer.memory_strategy_required_description"));

    const personalNonce = "nonce-personal-memory-mapping";
    storeTransferSnapshot(
      personalNonce,
      makeMemoryRecord({ kind: "personal_memories", ownership: "personal", destinationKey: "actor-1" }),
    );
    const personalInteraction = makeInteraction({
      customId: makeRouteId({ action: "memory-bucket-select", locale: "en-US", nonce: personalNonce, bucketPage: 0 }),
      kind: "string",
      values: ["0"],
    });
    const personalReply = spyOn(personalInteraction, "reply");
    await expect(dispatchGlobalInteraction({} as Client, personalInteraction)).resolves.toBe(true);
    expect(
      (personalReply.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> }).embeds[0]?.data
        .description,
    ).toBe(localizer("en-US", "commands.transfer.memory_personal_unavailable_description"));
  });

  it("keeps every memory mapping action non-terminal", async () => {
    const actions: Array<{
      action: TransferPanelRoute["action"];
      kind: InteractionKind;
      values?: string[];
      buckets?: MemoryBucket[];
      mapping?: Record<string, number | "skip">;
    }> = [
      { action: "memory-bucket-select", kind: "string", values: ["1"] },
      { action: "memory-bucket-page", kind: "button", buckets: makeMemoryBuckets(26) },
      { action: "memory-map", kind: "string", values: ["101"] },
      { action: "memory-map-page", kind: "button" },
      { action: "memory-confirm", kind: "button", mapping: { "bucket-0": 100, "bucket-1": 101 } },
    ];

    for (const [index, action] of actions.entries()) {
      const nonce = `nonce-memory-nonterminal-${index}`;
      const buckets = action.buckets ?? makeMemoryBuckets();
      const mapping = action.mapping ?? {};
      storeTransferSnapshot(nonce, makeMemoryRecord({ buckets, mapping }));
      seedMemoryDestinations(26);
      const route =
        action.action === "memory-bucket-select"
          ? makeRouteId({ action: "memory-bucket-select", locale: "en-US", nonce, bucketPage: 0 })
          : action.action === "memory-bucket-page"
            ? makeRouteId({ action: "memory-bucket-page", locale: "en-US", nonce, bucketPage: 1 })
            : action.action === "memory-map"
              ? makeRouteId({ action: "memory-map", locale: "en-US", nonce, bucketIndex: 1, destPage: 0 })
              : action.action === "memory-map-page"
                ? makeRouteId({ action: "memory-map-page", locale: "en-US", nonce, bucketIndex: 0, destPage: 0 })
                : makeRouteId({ action: "memory-confirm", locale: "en-US", nonce });
      const interaction = makeInteraction({
        customId: route,
        kind: action.kind,
        guildId: "guild-1",
        canManageGuild: true,
        values: action.values,
      });
      if (action.action === "memory-confirm") spyOn(interaction, "reply");
      else spyOn(interaction, "update");

      await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);
      expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("ok");
    }
  });

  it("rejects both interaction-kind directions for every memory mapping action", async () => {
    const route = createTransferInteractionRoute();
    const cases: Array<{ route: TransferPanelRoute; wrongKind: InteractionKind; message: string }> = [
      {
        route: { action: "memory-bucket-select", locale: "en-US", nonce: "nonce-kind-select", bucketPage: 0 },
        wrongKind: "button",
        message: "string select",
      },
      {
        route: { action: "memory-map", locale: "en-US", nonce: "nonce-kind-map", bucketIndex: 0, destPage: 0 },
        wrongKind: "button",
        message: "string select",
      },
      {
        route: { action: "memory-bucket-page", locale: "en-US", nonce: "nonce-kind-bucket-page", bucketPage: 0 },
        wrongKind: "string",
        message: "button interaction",
      },
      {
        route: {
          action: "memory-map-page",
          locale: "en-US",
          nonce: "nonce-kind-map-page",
          bucketIndex: 0,
          destPage: 0,
        },
        wrongKind: "string",
        message: "button interaction",
      },
      {
        route: { action: "memory-confirm", locale: "en-US", nonce: "nonce-kind-confirm" },
        wrongKind: "string",
        message: "button interaction",
      },
    ];

    for (const testCase of cases) {
      const parsed = parseInteractionRoute(makeRouteId(testCase.route));
      expect(parsed).not.toBeNull();
      if (!parsed) throw new Error("Memory interaction kind fixture did not parse");
      await expect(
        route.execute(
          {} as Client,
          makeInteraction({ customId: makeRouteId(testCase.route), kind: testCase.wrongKind }),
          parsed,
        ),
      ).rejects.toThrow(testCase.message);
    }
  });

  it("records both memory strategies without consuming the snapshot", async () => {
    for (const strategy of ["merge", "replace"] as const) {
      resetTransferSnapshots();
      const nonce = `nonce-${strategy}`;
      storeTransferSnapshot(nonce, makeRecord({ kind: "personal_memories" }));
      const interaction = makeInteraction({
        customId: makeRouteId({ action: "memory-strategy", locale: "en-US", nonce, strategy }),
        kind: "button",
      });
      const replySpy = spyOn(interaction, "reply");

      await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);

      const result = readTransferSnapshot(nonce, "actor-1", "personal", "actor-1");
      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.snapshot.strategy).toBe(strategy);
      expect(replySpy).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses memory strategy on a config snapshot", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-strategy";
    storeTransferSnapshot(nonce, makeRecord());
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-strategy", locale: "en-US", nonce, strategy: "merge" }),
      kind: "button",
    });
    const replySpy = spyOn(interaction, "reply");

    await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);

    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(localizer("en-US", "commands.transfer.unavailable_description"));
    const result = readTransferSnapshot(nonce, "actor-1", "personal", "actor-1");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.snapshot.strategy).toBeUndefined();
  });

  it("refuses memory strategy for an unauthorized workspace snapshot", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-unauthorized-strategy";
    storeTransferSnapshot(
      nonce,
      makeRecord({ kind: "workspace_memories", ownership: "workspace", destinationKey: "guild-1" }),
    );
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-strategy", locale: "en-US", nonce, strategy: "replace" }),
      kind: "button",
      guildId: "guild-1",
    });
    const replySpy = spyOn(interaction, "reply");

    await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);

    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.permission_denied_description"),
    );
    const result = readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.snapshot.strategy).toBeUndefined();
  });

  it("opens the config checklist modal without replying or deferring", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-continue";
    storeTransferSnapshot(
      nonce,
      makeRecord({
        kind: "workspace_config",
        detectedSections: ["chat", "triggers"],
      }),
    );
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-continue", locale: "en-US", nonce }),
      kind: "button",
    });
    const replySpy = spyOn(interaction, "reply");
    const captured: Array<{ custom_id: string }> = [];
    const route = createTransferInteractionRoute({
      showConfigChecklistModal: async (_button, locale, kind, detectedSections, modalNonce) => {
        captured.push(
          buildConfigSectionChecklistModal({
            locale,
            kind,
            detectedSections,
            nonce: modalNonce,
          }),
        );
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("Config continue route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(captured).toHaveLength(1);
    expect(replySpy).not.toHaveBeenCalled();
    expect(interaction.deferred).toBe(false);
    expect(interaction.replied).toBe(false);
    const modalRoute = parseInteractionRoute(captured[0]?.custom_id ?? "");
    expect(modalRoute).not.toBeNull();
    if (!modalRoute) throw new Error("Config checklist modal route did not parse");
    expect(parseTransferPanelRoute(modalRoute)).toEqual({ action: "config-apply", locale: "en-US", nonce });
  });

  it("does not show a config modal for an unauthorized workspace snapshot", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-unauthorized";
    storeTransferSnapshot(
      nonce,
      makeRecord({
        kind: "workspace_config",
        ownership: "workspace",
        destinationKey: "guild-1",
      }),
    );
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-continue", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
    });
    const showModal = spyOn({ show: async () => {} }, "show");
    const route = createTransferInteractionRoute({
      showConfigChecklistModal: async () => showModal(),
    });
    const replySpy = spyOn(interaction, "reply");
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Unauthorized config continue route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(showModal).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("ok");
  });

  it("refuses a config snapshot with no importable sections and preserves the snapshot", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-empty-sections";
    storeTransferSnapshot(nonce, makeRecord({ kind: "workspace_config", detectedSections: [] }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-continue", locale: "en-US", nonce }),
      kind: "button",
    });
    const replySpy = spyOn(interaction, "reply");
    const showModal = spyOn({ show: async () => {} }, "show");
    const route = createTransferInteractionRoute({
      showConfigChecklistModal: async () => showModal(),
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Empty-section config continue route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(showModal).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0] as {
      embeds: Array<{ data: { title?: string; description?: string } }>;
    };
    expect(payload.embeds[0]?.data.title).toBe(
      localizer("en-US", "commands.transfer.config_no_importable_sections_title"),
    );
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.config_no_importable_sections_description"),
    );
    expect(readTransferSnapshot(nonce, "actor-1", "personal", "actor-1").status).toBe("ok");
  });

  it("refuses config sections from the other format and preserves the snapshot", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-wrong-sections";
    storeTransferSnapshot(
      nonce,
      makeRecord({
        kind: "personal_config",
        ownership: "workspace",
        destinationKey: "guild-1",
        detectedSections: ["chat", "triggers"],
      }),
    );
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-continue", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const replySpy = spyOn(interaction, "reply");
    const showModal = spyOn({ show: async () => {} }, "show");
    const route = createTransferInteractionRoute({
      showConfigChecklistModal: async () => showModal(),
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Cross-format config continue route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(showModal).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0] as {
      embeds: Array<{ data: { description?: string } }>;
    };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.config_no_importable_sections_description"),
    );
    expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("ok");
  });

  it("refuses config apply when the modal carries no checkbox evidence", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-no-evidence";
    storeTransferSnapshot(nonce, makeRecord({ detectedSections: ["chat", "triggers"] }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-apply", locale: "en-US", nonce }),
      kind: "modal",
    });
    const replySpy = spyOn(interaction, "reply");
    const takeValues = spyOn(
      { take: (_interactionId: string, _fieldId: string) => undefined as string[] | undefined },
      "take",
    );
    const route = createTransferInteractionRoute({ takeConfigSectionValues: takeValues });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Config apply route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(takeValues).toHaveBeenCalledWith(interaction.id, buildConfigSectionCheckboxGroupId(nonce));
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.config_selection_stale_description"),
    );
  });

  it("rejects config apply values absent from the snapshot", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-invalid";
    storeTransferSnapshot(nonce, makeRecord({ detectedSections: ["chat", "triggers"] }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-apply", locale: "en-US", nonce }),
      kind: "modal",
    });
    const replySpy = spyOn(interaction, "reply");
    const route = createTransferInteractionRoute({ takeConfigSectionValues: () => ["speech"] });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Invalid config apply route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.config_selection_invalid_description"),
    );
    expect(readTransferSnapshot(nonce, "actor-1", "personal", "actor-1").status).toBe("ok");
  });

  it("rejects an empty config apply selection", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-empty";
    storeTransferSnapshot(nonce, makeRecord({ detectedSections: ["chat", "triggers"] }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-apply", locale: "en-US", nonce }),
      kind: "modal",
    });
    const replySpy = spyOn(interaction, "reply");
    const route = createTransferInteractionRoute({ takeConfigSectionValues: () => [] });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Empty config apply route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.config_selection_empty_description"),
    );
  });

  it("resolves a valid config subset exactly and keeps the route placeholder until import exists", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-valid";
    const record = makeRecord({ detectedSections: ["chat", "triggers", "memory"] });
    storeTransferSnapshot(nonce, record);
    const resolved = resolveSelectedConfigSections({ ...record, expiresAt: Date.now() + 10_000 }, ["triggers"]);
    expect(resolved).toEqual({ status: "ok", sections: ["triggers"] });

    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-apply", locale: "en-US", nonce }),
      kind: "modal",
    });
    const replySpy = spyOn(interaction, "reply");
    const route = createTransferInteractionRoute({ takeConfigSectionValues: () => ["triggers"] });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Valid config apply route did not parse");
    await route.execute({} as Client, interaction, parsed);

    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(localizer("en-US", "commands.transfer.unavailable_description"));
  });

  it("refuses a memory snapshot on config continue", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-on-config";
    storeTransferSnapshot(nonce, makeRecord({ kind: "personal_memories" }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-continue", locale: "en-US", nonce }),
      kind: "button",
    });
    const replySpy = spyOn(interaction, "reply");
    const route = createTransferInteractionRoute({
      showConfigChecklistModal: async () => {
        throw new Error("Memory snapshot must not open the config checklist");
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Memory-on-config route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(localizer("en-US", "commands.transfer.unavailable_description"));
  });
});
