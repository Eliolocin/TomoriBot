import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { MessageFlags, type Client } from "discord.js";
import type { MemoryBucket } from "@/types/db/dataExport";
import { personalConfigExportDataSchema, workspaceConfigExportDataSchema } from "@/types/db/dataExport";
import type { TomoriState } from "@/types/db/schema";
import { cache } from "@/utils/cache/tomoriStateCacheStore";
import { importRepository, personalMemoryRepository, userRepository } from "@/utils/db/repositories";
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
  buildMemoryImportMappings,
  createTransferInteractionRoute,
  resolveMemoryMappingPlan,
  resolveSelectedConfigSections,
  transferInteractionRoute,
  type PersonalMemoryImportInput,
  type WorkspaceMemoryImportInput,
} from "@/utils/discord/interactions/transferRoutes";
import {
  buildConfigSectionChecklistModal,
  buildConfigSectionCheckboxGroupId,
  buildMemoryTransferPreviewPayload,
  type MemoryTransferDestination,
} from "@/utils/discord/ui/transferPanel";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

type InteractionKind = "button" | "string" | "modal";

/** The minimum a `chat` section must state literally, because these three fields carry no default. */
const CHAT_SECTION_VALUES = {
  llm_temperature: 1,
  humanizer_degree: 1,
  timezone_offset: 0,
  llm_logit_biases: [],
};

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
  const interaction = {
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
    reply: async () => {
      interaction.replied = true;
    },
    deferReply: async () => {
      interaction.deferred = true;
    },
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    editReply: async () => {},
    update: async () => {},
    fetchReply: async () => ({}),
  };
  return interaction as unknown as GlobalRoutableInteraction;
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

const WORKSPACE_DESTINATIONS: MemoryTransferDestination[] = [
  { ownership: "workspace", lineageId: 100, personaId: 1, label: "Persona 0" },
  { ownership: "workspace", lineageId: 101, personaId: 2, label: "Persona 1" },
];

const PERSONAL_DESTINATIONS: MemoryTransferDestination[] = [
  { ownership: "personal", lineageId: 0, label: "Global" },
  { ownership: "personal", lineageId: 55, label: "Sparrow" },
];

/** W7e-1's marker for a surface a later slice still owed. No control a user can press may still reach it. */
const PLACEHOLDER_TEXT_KEY = "commands.transfer.unavailable_title";

/**
 * Resolved per call, never at module load: the localizer is initialized in `beforeAll`, so a module-level
 * `localizer(...)` returns the key itself and every comparison against it silently passes.
 */
function placeholderText(): string {
  return localizer("en-US", PLACEHOLDER_TEXT_KEY);
}

afterEach(() => {
  cache.delete("guild-1");
  resetTransferSnapshots();
  for (const activeSpy of activeSpies.splice(0)) activeSpy.mockRestore();
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

/** Every TextDisplay body in a payload, joined: the terminal notice is a Components V2 panel, not an embed. */
function collectText(payload: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.content === "string") parts.push(record.content);
    for (const value of Object.values(record)) walk(value);
  };
  walk(payload);
  return parts.join("\n");
}

/**
 * Every rendered string in a payload, whether it travels as a Components V2 `content` or as a legacy embed title or
 * description. A check for "this text was not shown" has to read both, because a refusal replies with an embed while
 * a surface render edits a V2 panel, so a `content`-only walk silently sees nothing at all for every refusal.
 */
function collectRenderedText(payload: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    for (const key of ["content", "title", "description"]) {
      if (typeof record[key] === "string") parts.push(record[key]);
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(payload);
  return parts.join("\n");
}

/**
 * Every rendered control, parsed back into a route. A test that dispatches one of these drives the exact custom ID
 * the panel emitted, which is what makes the panel-to-route seam observable rather than assumed.
 */
function renderedTransferRoutes(payload: unknown): TransferPanelRoute[] {
  const routes: TransferPanelRoute[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const customId = record.customId ?? record.custom_id;
    if (typeof customId === "string") {
      const parsed = parseInteractionRoute(customId);
      const route = parsed ? parseTransferPanelRoute(parsed) : null;
      if (route) routes.push(route);
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(payload);
  return routes;
}

/**
 * Spies restored by `afterEach`. `mockRestore` also clears a mock's recorded calls, so a repository spy must
 * outlive its assertions rather than being restored inside the test that made them.
 */
const activeSpies: Array<{ mockRestore(): void }> = [];

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

  it("consumes on cancel and replaces the panel with a terminal notice", async () => {
    resetTransferSnapshots();
    storeTransferSnapshot("nonce-1234", makeRecord());
    const routeId = makeRouteId({ action: "cancel", locale: "en-US", nonce: "nonce-1234" });
    const interaction = makeInteraction({ customId: routeId, kind: "button" });
    const updateSpy = spyOn(interaction, "update");
    const replySpy = spyOn(interaction, "reply");

    await dispatchGlobalInteraction({} as Client, interaction);

    expect(readTransferSnapshot("nonce-1234", "actor-1", "personal", "actor-1").status).toBe("missing");
    // Cancelling must not leave the preview and its Continue button on screen, so the panel is edited in place.
    expect(replySpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const panelText = collectText(updateSpy.mock.calls[0]?.[0]);
    expect(panelText).toContain(localizer("en-US", "commands.transfer.cancelled_title"));
    expect(panelText).toContain(localizer("en-US", "commands.transfer.cancelled_description"));

    const secondInteraction = makeInteraction({ customId: routeId, kind: "button" });
    const secondReplySpy = spyOn(secondInteraction, "reply");
    await dispatchGlobalInteraction({} as Client, secondInteraction);
    expect(secondReplySpy).toHaveBeenCalledTimes(1);
    const payload = secondReplySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
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

  it("refuses mapping without a chosen strategy and still maps a personal snapshot", async () => {
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
      makeMemoryRecord({
        kind: "personal_memories",
        ownership: "personal",
        destinationKey: "actor-1",
        mapping: { "bucket-0": 0, "bucket-1": 55 },
      }),
    );
    const personalInteraction = makeInteraction({
      customId: makeRouteId({
        action: "memory-map",
        locale: "en-US",
        nonce: personalNonce,
        bucketIndex: 1,
        destPage: 0,
      }),
      kind: "string",
      values: ["55"],
    });
    const personalUpdate = spyOn(personalInteraction, "update");
    const personalRoute = createTransferInteractionRoute({
      getPersonalMemoryDestinations: async () => PERSONAL_DESTINATIONS,
    });
    const personalParsed = parseInteractionRoute(personalInteraction.customId);
    if (!personalParsed) throw new Error("Personal memory mapping route did not parse");

    await personalRoute.execute({} as Client, personalInteraction, personalParsed);

    const personalPanel = collectText(personalUpdate.mock.calls[0]?.[0]);
    expect(personalPanel).toContain(localizer("en-US", "commands.transfer.memory_mapping_title"));
    expect(personalPanel).toContain("Sparrow");
  });

  it("keeps every non-terminal memory mapping action from consuming the snapshot", async () => {
    const actions: Array<{
      action: TransferPanelRoute["action"];
      kind: InteractionKind;
      values?: string[];
      buckets?: MemoryBucket[];
      mapping?: Record<string, number | "skip">;
      strategy?: "merge" | "replace";
    }> = [
      { action: "memory-bucket-select", kind: "string", values: ["1"] },
      { action: "memory-bucket-page", kind: "button", buckets: makeMemoryBuckets(26) },
      { action: "memory-map", kind: "string", values: ["101"] },
      { action: "memory-map-page", kind: "button" },
      // A Replace confirm renders the destructive preview on its first click, so that click is not terminal.
      {
        action: "memory-confirm",
        kind: "button",
        strategy: "replace",
        mapping: { "bucket-0": 100, "bucket-1": 101 },
      },
    ];

    for (const [index, action] of actions.entries()) {
      const nonce = `nonce-memory-nonterminal-${index}`;
      const buckets = action.buckets ?? makeMemoryBuckets();
      const mapping = action.mapping ?? {};
      storeTransferSnapshot(nonce, makeMemoryRecord({ buckets, mapping, strategy: action.strategy ?? "merge" }));
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
      // Every one of these renders in place, so the panel it was clicked on is the one it edits.
      spyOn(interaction, "update");

      await expect(dispatchGlobalInteraction({} as Client, interaction)).resolves.toBe(true);
      expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("ok");
    }
  });

  it("binds a confirmed Merge to the persona the destination list offered and consumes the snapshot", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-merge-write";
    storeTransferSnapshot(nonce, makeMemoryRecord({ mapping: { "bucket-0": 100, "bucket-1": 101 } }));
    seedMemoryDestinations();
    const applied: WorkspaceMemoryImportInput[] = [];
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const editSpy = spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        return { success: true, itemsImported: { memoriesInserted: 2, memoriesSkipped: 1, memoriesDeleted: 0 } };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Merge confirm route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(applied).toEqual([
      {
        destinationKey: "guild-1",
        actorDiscId: "actor-1",
        strategy: "merge",
        mappings: [
          { bucketName: "bucket-0", personaId: 1, memories: [{ content: "Memory 0", tags: [] }] },
          { bucketName: "bucket-1", personaId: 2, memories: [{ content: "Memory 1", tags: [] }] },
        ],
      },
    ]);
    expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("missing");
    const panelText = collectText(editSpy.mock.calls[0]?.[0]);
    expect(panelText).toContain(localizer("en-US", "commands.transfer.memory_import_success_title"));
    expect(panelText).toContain(
      localizer("en-US", "commands.transfer.memory_import_success_description", {
        strategy: localizer("en-US", "commands.transfer.memory_merge_label"),
        inserted: 2,
        skipped: 1,
        deleted: 0,
      }),
    );
  });

  it("acknowledges the confirm as an update before running the memory transaction", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-write-order";
    storeTransferSnapshot(nonce, makeMemoryRecord({ mapping: { "bucket-0": 100, "bucket-1": 101 } }));
    seedMemoryDestinations();
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const deferUpdateSpy = spyOn(interaction, "deferUpdate");
    spyOn(interaction, "editReply");
    const acknowledged: boolean[] = [];
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async () => {
        acknowledged.push(interaction.deferred || interaction.replied);
        return { success: true, itemsImported: { memoriesInserted: 2 } };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Merge ordering route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(acknowledged).toEqual([true]);
    // An update, not a defer: a plain defer would open a new ephemeral and leave the mapping controls on screen.
    expect(deferUpdateSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the snapshot when the memory write fails and reports the repository error", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-write-failure";
    storeTransferSnapshot(nonce, makeMemoryRecord({ mapping: { "bucket-0": 100, "bucket-1": 101 } }));
    seedMemoryDestinations();
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const editSpy = spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async () => ({
        success: false,
        error: "commands.data.import.error_update_failed",
      }),
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Failed memory write route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("ok");
    const panelText = collectText(editSpy.mock.calls[0]?.[0]);
    expect(panelText).toContain(localizer("en-US", "commands.transfer.memory_import_failed_title"));
    expect(panelText).toContain(localizer("en-US", "commands.data.import.error_update_failed"));
  });

  it("refuses a mapping whose destination the current destination list no longer offers", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-stale-destination";
    // The mapping was made earlier; by confirm time the persona it named is no longer among the offered ones.
    storeTransferSnapshot(nonce, makeMemoryRecord({ mapping: { "bucket-0": 999, "bucket-1": 101 } }));
    seedMemoryDestinations();
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const replySpy = spyOn(interaction, "reply");
    const applied: WorkspaceMemoryImportInput[] = [];
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        return { success: true };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Stale destination route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(applied).toEqual([]);
    expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("ok");
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.memory_mapping_invalid_description"),
    );
  });

  it("renders the destructive Replace preview on the first confirm and writes nothing", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-replace-preview";
    storeTransferSnapshot(
      nonce,
      makeMemoryRecord({ strategy: "replace", mapping: { "bucket-0": 100, "bucket-1": "skip" } }),
    );
    seedMemoryDestinations();
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const updateSpy = spyOn(interaction, "update");
    const applied: WorkspaceMemoryImportInput[] = [];
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        return { success: true };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Replace preview route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(applied).toEqual([]);
    const stored = readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1");
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.snapshot.replaceConfirmed).toBe(true);

    const panelText = collectText(updateSpy.mock.calls[0]?.[0]);
    expect(panelText).toContain(localizer("en-US", "commands.transfer.memory_replace_confirmation_title"));
    expect(panelText).toContain("Persona 0");
    expect(panelText).toContain(
      localizer("en-US", "commands.transfer.memory_skip_confirmation_line", { bucket: "Bucket 1" }),
    );
  });

  it("never writes from the mapping panel's Confirm, which only opens the Replace preview", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-replace-replay";
    // The state a duplicated click on the first Confirm leaves behind: the preview was shown, so the flag is set.
    storeTransferSnapshot(
      nonce,
      makeMemoryRecord({
        strategy: "replace",
        mapping: { "bucket-0": 100, "bucket-1": "skip" },
        replaceConfirmed: true,
      }),
    );
    seedMemoryDestinations();
    const applied: WorkspaceMemoryImportInput[] = [];
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const updateSpy = spyOn(interaction, "update");
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        return { success: true };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Replayed Replace confirm route did not parse");

    await route.execute({} as Client, interaction, parsed);

    // Only the control the preview itself renders commits a Replace, so a repeated or duplicated click on the
    // mapping panel's Confirm re-renders the preview instead of destroying the destination scope.
    expect(applied).toEqual([]);
    expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("ok");
    expect(collectText(updateSpy.mock.calls[0]?.[0])).toContain(
      localizer("en-US", "commands.transfer.memory_replace_confirmation_title"),
    );
  });

  it("refuses the destructive Replace action when the preview was never recorded", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-replace-forged";
    storeTransferSnapshot(
      nonce,
      makeMemoryRecord({ strategy: "replace", mapping: { "bucket-0": 100, "bucket-1": "skip" } }),
    );
    seedMemoryDestinations();
    const applied: WorkspaceMemoryImportInput[] = [];
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-replace-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const replySpy = spyOn(interaction, "reply");
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        return { success: true };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Forged Replace confirm route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(applied).toEqual([]);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.memory_replace_confirmation_stale_description"),
    );
  });

  it("commits a Replace only on the recorded confirmation and reports the deleted count", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-replace-write";
    storeTransferSnapshot(
      nonce,
      makeMemoryRecord({
        strategy: "replace",
        mapping: { "bucket-0": 100, "bucket-1": "skip" },
        replaceConfirmed: true,
      }),
    );
    seedMemoryDestinations();
    const applied: WorkspaceMemoryImportInput[] = [];
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-replace-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const editSpy = spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        return { success: true, itemsImported: { memoriesInserted: 1, memoriesSkipped: 0, memoriesDeleted: 4 } };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Replace write route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(applied).toEqual([
      {
        destinationKey: "guild-1",
        actorDiscId: "actor-1",
        strategy: "replace",
        mappings: [{ bucketName: "bucket-0", personaId: 1, memories: [{ content: "Memory 0", tags: [] }] }],
      },
    ]);
    expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("missing");
    const panelText = collectText(editSpy.mock.calls[0]?.[0]);
    expect(panelText).toContain(
      localizer("en-US", "commands.transfer.memory_import_success_description", {
        strategy: localizer("en-US", "commands.transfer.memory_replace_label"),
        inserted: 1,
        skipped: 0,
        deleted: 4,
      }),
    );
  });

  it("refuses a second confirmation that arrives while the first write is still in flight", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-in-flight";
    storeTransferSnapshot(nonce, makeMemoryRecord({ mapping: { "bucket-0": 100, "bucket-1": 101 } }));
    seedMemoryDestinations();
    const applied: WorkspaceMemoryImportInput[] = [];
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    spyOn(interaction, "editReply");
    let duplicateDescription: string | undefined;
    let nestedDispatchStarted = false;
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        // One duplicate click lands while this write is still awaiting its transaction. The nested dispatch is not
        // repeated further, so a missing guard shows up as a second write rather than as unbounded recursion.
        if (nestedDispatchStarted) return { success: true, itemsImported: { memoriesInserted: 2 } };
        nestedDispatchStarted = true;
        const duplicate = makeInteraction({
          customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
          kind: "button",
          guildId: "guild-1",
          canManageGuild: true,
        });
        const duplicateReply = spyOn(duplicate, "reply");
        const duplicateParsed = parseInteractionRoute(duplicate.customId);
        if (!duplicateParsed) throw new Error("Duplicate confirm route did not parse");
        await route.execute({} as Client, duplicate, duplicateParsed);
        duplicateDescription = (
          duplicateReply.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> } | undefined
        )?.embeds[0]?.data.description;
        return { success: true, itemsImported: { memoriesInserted: 2 } };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("In-flight confirm route did not parse");

    await route.execute({} as Client, interaction, parsed);

    // Without the claim the nested confirmation would validate against the same snapshot and write the bundle a
    // second time, so this count is the property under test rather than a restatement of it.
    expect(applied).toHaveLength(1);
    expect(duplicateDescription).toBe(localizer("en-US", "commands.transfer.memory_import_in_progress_description"));
    expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("missing");
  });

  it("releases the write claim when the import fails so the same file stays retryable", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-claim-release";
    storeTransferSnapshot(nonce, makeMemoryRecord({ mapping: { "bucket-0": 100, "bucket-1": 101 } }));
    seedMemoryDestinations();
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async () => ({ success: false, error: "commands.data.import.error_update_failed" }),
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Claim release route did not parse");

    await route.execute({} as Client, interaction, parsed);

    const stored = readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1");
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.snapshot.writeClaimed).toBe(false);

    // The retry is what proves the release: a still-claimed snapshot would refuse here instead of writing.
    const retried: WorkspaceMemoryImportInput[] = [];
    const retryInteraction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    spyOn(retryInteraction, "editReply");
    const retryRoute = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        retried.push(input);
        return { success: true, itemsImported: { memoriesInserted: 2 } };
      },
    });
    const retryParsed = parseInteractionRoute(retryInteraction.customId);
    if (!retryParsed) throw new Error("Retry confirm route did not parse");

    await retryRoute.execute({} as Client, retryInteraction, retryParsed);

    expect(retried).toHaveLength(1);
    expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("missing");
  });

  it("releases the write claim when the transaction throws", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-claim-throw";
    storeTransferSnapshot(nonce, makeMemoryRecord({ mapping: { "bucket-0": 100, "bucket-1": 101 } }));
    seedMemoryDestinations();
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async () => {
        throw new Error("injected transaction failure");
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Claim throw route did not parse");

    await expect(route.execute({} as Client, interaction, parsed)).rejects.toThrow("injected transaction failure");

    const stored = readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1");
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.snapshot.writeClaimed).toBe(false);
  });

  it("commits a Replace from the control the destructive preview itself renders", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-replace-seam";
    storeTransferSnapshot(
      nonce,
      makeMemoryRecord({ strategy: "replace", mapping: { "bucket-0": 100, "bucket-1": "skip" } }),
    );
    seedMemoryDestinations();
    const applied: WorkspaceMemoryImportInput[] = [];
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        return { success: true, itemsImported: { memoriesInserted: 1 } };
      },
    });

    const firstInteraction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const updateSpy = spyOn(firstInteraction, "update");
    const firstParsed = parseInteractionRoute(firstInteraction.customId);
    if (!firstParsed) throw new Error("Preview seam route did not parse");

    await route.execute({} as Client, firstInteraction, firstParsed);

    expect(applied).toEqual([]);
    const confirmRoute = renderedTransferRoutes(updateSpy.mock.calls[0]?.[0]).find(
      (rendered) => rendered.action === "memory-replace-confirm",
    );
    // A preview whose own confirm control carried the mapping panel's action would never commit anything, and a
    // route test that hard-codes the action instead of reading it could not tell the difference.
    expect(confirmRoute).toBeDefined();
    if (!confirmRoute) throw new Error("The destructive preview rendered no Replace confirm control");

    const secondInteraction = makeInteraction({
      customId: buildTransferRouteId(confirmRoute),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    spyOn(secondInteraction, "editReply");
    const secondParsed = parseInteractionRoute(secondInteraction.customId);
    if (!secondParsed) throw new Error("Rendered Replace confirm route did not parse");

    await route.execute({} as Client, secondInteraction, secondParsed);

    expect(applied).toHaveLength(1);
    expect(applied[0]?.strategy).toBe("replace");
    expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("missing");
  });

  it("refuses the destructive Replace action after the mapping moved on from the preview", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-replace-moved";
    storeTransferSnapshot(
      nonce,
      makeMemoryRecord({
        strategy: "replace",
        mapping: { "bucket-0": 100, "bucket-1": "skip" },
        replaceConfirmed: true,
      }),
    );
    seedMemoryDestinations();
    const applied: WorkspaceMemoryImportInput[] = [];
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        return { success: true };
      },
    });

    // A delayed destination change lands after the destructive preview listed destination 100.
    const mappingInteraction = makeInteraction({
      customId: makeRouteId({ action: "memory-map", locale: "en-US", nonce, bucketIndex: 0, destPage: 0 }),
      kind: "string",
      guildId: "guild-1",
      canManageGuild: true,
      values: ["101"],
    });
    spyOn(mappingInteraction, "update");
    const mappingParsed = parseInteractionRoute(mappingInteraction.customId);
    if (!mappingParsed) throw new Error("Delayed mapping route did not parse");
    await route.execute({} as Client, mappingInteraction, mappingParsed);

    const confirmInteraction = makeInteraction({
      customId: makeRouteId({ action: "memory-replace-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const replySpy = spyOn(confirmInteraction, "reply");
    const confirmParsed = parseInteractionRoute(confirmInteraction.customId);
    if (!confirmParsed) throw new Error("Moved-plan confirm route did not parse");
    await route.execute({} as Client, confirmInteraction, confirmParsed);

    // Destination 101 was never named in a preview this reader confirmed, so the write must not happen.
    expect(applied).toEqual([]);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.memory_replace_confirmation_stale_description"),
    );
  });

  it("refuses the destructive Replace action on a Merge snapshot", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-replace-on-merge";
    storeTransferSnapshot(
      nonce,
      makeMemoryRecord({ strategy: "merge", mapping: { "bucket-0": 100, "bucket-1": 101 } }),
    );
    seedMemoryDestinations();
    const applied: WorkspaceMemoryImportInput[] = [];
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-replace-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    const replySpy = spyOn(interaction, "reply");
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        return { success: true };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Merge snapshot Replace route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(applied).toEqual([]);
    const payload = replySpy.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> };
    expect(payload.embeds[0]?.data.description).toBe(
      localizer("en-US", "commands.transfer.memory_replace_confirmation_stale_description"),
    );
  });

  it("refuses to cancel a write that is already running", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-memory-cancel-inflight";
    storeTransferSnapshot(nonce, makeMemoryRecord({ mapping: { "bucket-0": 100, "bucket-1": 101 } }));
    seedMemoryDestinations();
    let cancelDescription: string | undefined;
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async () => {
        // A queued Cancel arrives while this write is still awaiting its transaction.
        const cancel = makeInteraction({
          customId: makeRouteId({ action: "cancel", locale: "en-US", nonce }),
          kind: "button",
          guildId: "guild-1",
          canManageGuild: true,
        });
        const cancelReply = spyOn(cancel, "reply");
        const cancelParsed = parseInteractionRoute(cancel.customId);
        if (!cancelParsed) throw new Error("In-flight cancel route did not parse");
        await route.execute({} as Client, cancel, cancelParsed);
        cancelDescription = (
          cancelReply.mock.calls[0]?.[0] as { embeds: Array<{ data: { description?: string } }> } | undefined
        )?.embeds[0]?.data.description;
        // The write then fails, and the snapshot has to still be there for a retry.
        return { success: false, error: "commands.data.import.error_update_failed" };
      },
    });
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    spyOn(interaction, "editReply");
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("In-flight write route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(cancelDescription).toBe(localizer("en-US", "commands.transfer.memory_import_in_progress_description"));
    const stored = readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1");
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.snapshot.writeClaimed).toBe(false);
  });

  it("imports a personal bundle keyed on the lineage the plan carries", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-personal-memory-write";
    storeTransferSnapshot(
      nonce,
      makeMemoryRecord({
        kind: "personal_memories",
        ownership: "personal",
        destinationKey: "actor-1",
        mapping: { "bucket-0": 0, "bucket-1": 55 },
      }),
    );
    const applied: PersonalMemoryImportInput[] = [];
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
    });
    const editSpy = spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({
      getPersonalMemoryDestinations: async () => PERSONAL_DESTINATIONS,
      applyPersonalMemoryImport: async (input) => {
        applied.push(input);
        return { success: true, itemsImported: { memoriesInserted: 2, memoriesSkipped: 0, memoriesDeleted: 0 } };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Personal memory write route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(applied).toEqual([
      {
        destinationKey: "actor-1",
        strategy: "merge",
        mappings: [
          { bucketName: "bucket-0", personaLineageId: 0, memories: [{ content: "Memory 0", tags: [] }] },
          { bucketName: "bucket-1", personaLineageId: 55, memories: [{ content: "Memory 1", tags: [] }] },
        ],
      },
    ]);
    expect(readTransferSnapshot(nonce, "actor-1", "personal", "actor-1").status).toBe("missing");
    expect(collectText(editSpy.mock.calls[0]?.[0])).toContain(
      localizer("en-US", "commands.transfer.memory_import_success_title"),
    );
  });

  it("addresses a DM-backed workspace snapshot by its own destination key", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-dm-workspace-write";
    storeTransferSnapshot(
      nonce,
      makeMemoryRecord({
        ownership: "workspace",
        destinationKey: "actor-1",
        mapping: { "bucket-0": 100, "bucket-1": 101 },
      }),
    );
    const destinationReads: string[] = [];
    const applied: WorkspaceMemoryImportInput[] = [];
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
    });
    spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({
      getWorkspaceMemoryDestinations: async (key) => {
        destinationReads.push(key);
        return WORKSPACE_DESTINATIONS;
      },
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        return { success: true, itemsImported: { memoriesInserted: 2 } };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("DM workspace route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(destinationReads).toEqual(["actor-1"]);
    expect(applied[0]?.destinationKey).toBe("actor-1");
  });

  it("drives the default workspace destination read through the real persona cache", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-default-destinations";
    storeTransferSnapshot(nonce, makeMemoryRecord({ mapping: { "bucket-0": 100, "bucket-1": 101 } }));
    seedMemoryDestinations();
    const applied: WorkspaceMemoryImportInput[] = [];
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({
      applyWorkspaceMemoryImport: async (input) => {
        applied.push(input);
        return { success: true, itemsImported: { memoriesInserted: 2 } };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Default destination route did not parse");

    await route.execute({} as Client, interaction, parsed);

    // The default read offers one destination per lineage and carries the persona id the write needs, so a
    // regression to a lineage-only destination would leave the mapping homeless.
    expect(applied[0]?.mappings.map((mapping) => mapping.personaId)).toEqual([1, 2]);
  });

  it("drives the default personal destination read through the repositories", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-default-personal-dest";
    storeTransferSnapshot(
      nonce,
      makeMemoryRecord({
        kind: "personal_memories",
        ownership: "personal",
        destinationKey: "actor-1",
        mapping: { "bucket-0": 0, "bucket-1": 55 },
      }),
    );
    const userSpy = spyOn(userRepository, "loadByDiscordId").mockResolvedValue({ user_id: 9 } as never);
    const lineageSpy = spyOn(personalMemoryRepository, "destinationLineages").mockResolvedValue([
      { lineageId: 55, nickname: "Sparrow" },
      { lineageId: 60, nickname: null },
    ]);
    activeSpies.push(userSpy, lineageSpy);
    const applied: PersonalMemoryImportInput[] = [];
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce }),
      kind: "button",
    });
    spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({
      applyPersonalMemoryImport: async (input) => {
        applied.push(input);
        return { success: true, itemsImported: { memoriesInserted: 2 } };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Default personal destination route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(userSpy).toHaveBeenCalledWith("actor-1");
    expect(lineageSpy).toHaveBeenCalledWith(9);
    expect(applied[0]?.mappings.map((mapping) => mapping.personaLineageId)).toEqual([0, 55]);
  });

  it("defaults each memory kind onto its own repository seam", async () => {
    resetTransferSnapshots();
    const workspaceNonce = "nonce-default-workspace-seam";
    storeTransferSnapshot(workspaceNonce, makeMemoryRecord({ mapping: { "bucket-0": 100, "bucket-1": 101 } }));
    seedMemoryDestinations();
    const workspaceSpy = spyOn(importRepository, "importWorkspaceMemoryBundle").mockResolvedValue({
      success: true,
      itemsImported: { memoriesInserted: 2 },
    });
    const personalBundleSpy = spyOn(importRepository, "importPersonalMemoryBundle");
    activeSpies.push(workspaceSpy, personalBundleSpy);
    const workspaceInteraction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: workspaceNonce }),
      kind: "button",
      guildId: "guild-1",
      canManageGuild: true,
    });
    spyOn(workspaceInteraction, "editReply");

    await dispatchGlobalInteraction({} as Client, workspaceInteraction);

    expect(personalBundleSpy).not.toHaveBeenCalled();
    expect(workspaceSpy).toHaveBeenCalledTimes(1);
    const [serverDiscId, importerDiscId, mappings, strategy] = workspaceSpy.mock.calls[0] ?? [];
    expect(serverDiscId).toBe("guild-1");
    // The imported rows are attributed to the invoking manager, not to an arbitrary users row.
    expect(importerDiscId).toBe("actor-1");
    expect(strategy).toBe("merge");
    expect(mappings).toEqual([
      { bucketName: "bucket-0", personaId: 1, memories: [{ content: "Memory 0", tags: [] }] },
      { bucketName: "bucket-1", personaId: 2, memories: [{ content: "Memory 1", tags: [] }] },
    ]);

    resetTransferSnapshots();
    const personalNonce = "nonce-default-personal-seam";
    storeTransferSnapshot(
      personalNonce,
      makeMemoryRecord({
        kind: "personal_memories",
        ownership: "personal",
        destinationKey: "actor-1",
        mapping: { "bucket-0": 0, "bucket-1": 55 },
      }),
    );
    const personalSpy = spyOn(importRepository, "importPersonalMemoryBundle").mockResolvedValue({
      success: true,
      itemsImported: { memoriesInserted: 2 },
    });
    activeSpies.push(personalSpy);
    const personalInteraction = makeInteraction({
      customId: makeRouteId({ action: "memory-confirm", locale: "en-US", nonce: personalNonce }),
      kind: "button",
    });
    spyOn(personalInteraction, "editReply");
    const personalRoute = createTransferInteractionRoute({
      getPersonalMemoryDestinations: async () => PERSONAL_DESTINATIONS,
    });

    await personalRoute.execute(
      {} as Client,
      personalInteraction,
      parseInteractionRoute(personalInteraction.customId) as never,
    );

    expect(personalSpy).toHaveBeenCalledTimes(1);
    expect(personalSpy.mock.calls[0]?.[0]).toBe("actor-1");
    expect(personalSpy.mock.calls[0]?.[2]).toBe("merge");
  });

  it("omits skipped buckets from the bundle and refuses a destination the plan cannot key", () => {
    const buckets = makeMemoryBuckets();
    const destinations = WORKSPACE_DESTINATIONS;
    const plan = resolveMemoryMappingPlan(buckets, { "bucket-0": 100, "bucket-1": "skip" });
    if (plan.status !== "ok") throw new Error("Skip fixture must resolve");

    expect(buildMemoryImportMappings("workspace_memories", buckets, plan.plan, destinations)).toMatchObject({
      status: "ok",
      kind: "workspace_memories",
      mappings: [{ bucketName: "bucket-0", personaId: 1 }],
    });

    // A personal destination can never satisfy a workspace write, so the whole bundle is refused rather than
    // silently importing part of it.
    expect(buildMemoryImportMappings("workspace_memories", buckets, plan.plan, PERSONAL_DESTINATIONS)).toEqual({
      status: "refused",
    });
    // A bucket the plan names but the snapshot no longer carries is refused for the same reason.
    expect(buildMemoryImportMappings("personal_memories", [], plan.plan, PERSONAL_DESTINATIONS)).toEqual({
      status: "refused",
    });
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

  it("records a chosen memory strategy, opens the mapping surface, and consumes nothing", async () => {
    const cases: Array<{
      strategy: "merge" | "replace";
      record: TransferSnapshotRecordInput;
      dependencies: Parameters<typeof createTransferInteractionRoute>[0];
    }> = [
      { strategy: "merge", record: makeMemoryRecord({ strategy: undefined }), dependencies: {} },
      { strategy: "replace", record: makeMemoryRecord({ strategy: undefined }), dependencies: {} },
      {
        strategy: "merge",
        record: makeMemoryRecord({
          strategy: undefined,
          kind: "personal_memories",
          ownership: "personal",
          destinationKey: "actor-1",
        }),
        dependencies: { getPersonalMemoryDestinations: async () => PERSONAL_DESTINATIONS },
      },
    ];

    for (const testCase of cases) {
      resetTransferSnapshots();
      const nonce = `nonce-strategy-${testCase.strategy}-${testCase.record.ownership}`;
      storeTransferSnapshot(nonce, testCase.record);
      seedMemoryDestinations();
      const interaction = makeInteraction({
        customId: makeRouteId({ action: "memory-strategy", locale: "en-US", nonce, strategy: testCase.strategy }),
        kind: "button",
        guildId: testCase.record.ownership === "workspace" ? "guild-1" : null,
        canManageGuild: true,
      });
      const updateSpy = spyOn(interaction, "update");
      const replySpy = spyOn(interaction, "reply");
      const parsed = parseInteractionRoute(interaction.customId);
      if (!parsed) throw new Error("Memory strategy route did not parse");

      await createTransferInteractionRoute(testCase.dependencies).execute({} as Client, interaction, parsed);

      const result = readTransferSnapshot(nonce, "actor-1", testCase.record.ownership, testCase.record.destinationKey);
      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.snapshot.strategy).toBe(testCase.strategy);
      // Choosing a strategy has to open the mapping surface: its controls exist only there, so replying anything
      // else would leave the flow with no way forward.
      expect({ strategy: testCase.strategy, replies: replySpy.mock.calls.length }).toEqual({
        strategy: testCase.strategy,
        replies: 0,
      });
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const panelText = collectText(updateSpy.mock.calls[0]?.[0]);
      expect(panelText).toContain(localizer("en-US", "commands.transfer.memory_mapping_title"));
      expect(panelText).toContain(
        localizer("en-US", "commands.transfer.memory_mapping_strategy", {
          strategy: localizer(
            "en-US",
            testCase.strategy === "merge"
              ? "commands.transfer.memory_merge_label"
              : "commands.transfer.memory_replace_label",
          ),
        }),
      );
      expect(panelText).not.toContain(placeholderText());
    }
  });

  it("leaves no control on the memory preview without a destination", async () => {
    const nonce = "nonce-preview-controls";
    const previewPayload = buildMemoryTransferPreviewPayload({
      locale: "en-US",
      kind: "workspace_memories",
      buckets: makeMemoryBuckets(),
      nonce,
    });
    const rendered = renderedTransferRoutes(previewPayload);
    expect(rendered.length).toBeGreaterThan(0);

    for (const renderedRoute of rendered) {
      resetTransferSnapshots();
      // The strategy is already recorded, so this exercises each control's own destination rather than the
      // strategy gate in front of the mapping surface.
      storeTransferSnapshot(nonce, makeMemoryRecord({ strategy: "merge" }));
      seedMemoryDestinations();
      const interaction = makeInteraction({
        customId: buildTransferRouteId(renderedRoute),
        kind: "button",
        guildId: "guild-1",
        canManageGuild: true,
      });
      const updateSpy = spyOn(interaction, "update");
      const replySpy = spyOn(interaction, "reply");
      const parsed = parseInteractionRoute(interaction.customId);
      if (!parsed) throw new Error(`Rendered preview control ${renderedRoute.action} did not parse`);

      await createTransferInteractionRoute().execute({} as Client, interaction, parsed);

      // The placeholder is the marker for a surface a later slice still owed. Every control the preview renders has
      // to reach a real destination, whether by replying with a refusal or by rendering the next surface.
      const reachedText = `${collectRenderedText(replySpy.mock.calls[0]?.[0])}\n${collectRenderedText(updateSpy.mock.calls[0]?.[0])}`;
      expect({ route: renderedRoute, placeholder: reachedText.includes(placeholderText()) }).toEqual({
        route: renderedRoute,
        placeholder: false,
      });
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

  it("resolves a valid config subset exactly", () => {
    const record = makeRecord({ detectedSections: ["chat", "triggers", "memory"] });
    const resolved = resolveSelectedConfigSections({ ...record, expiresAt: Date.now() + 10_000 }, ["triggers"]);
    expect(resolved).toEqual({ status: "ok", sections: ["triggers"] });
  });

  it("applies the selected sections through the importer and consumes the snapshot", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-apply";
    storeTransferSnapshot(nonce, makeRecord({ detectedSections: ["chat", "triggers", "memory"] }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-apply", locale: "en-US", nonce }),
      kind: "modal",
    });
    const editSpy = spyOn(interaction, "editReply");
    const applied: Array<{ kind: string; sections: readonly string[]; destinationKey: string }> = [];
    const route = createTransferInteractionRoute({
      takeConfigSectionValues: () => ["triggers"],
      applyConfigImport: async (snapshot, sections, destinationKey) => {
        applied.push({ kind: snapshot.kind, sections, destinationKey });
        return { success: true, itemsImported: { configFieldsCount: 4 } };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Valid config apply route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(applied).toEqual([{ kind: "workspace_config", sections: ["triggers"], destinationKey: "actor-1" }]);
    expect(readTransferSnapshot(nonce, "actor-1", "personal", "actor-1").status).toBe("missing");
    const panelText = collectText(editSpy.mock.calls[0]?.[0]);
    expect(panelText).toContain(localizer("en-US", "commands.transfer.config_import_success_title"));
    expect(panelText).toContain(
      localizer("en-US", "commands.transfer.config_import_success_description", {
        sections: localizer("en-US", "commands.transfer.section_triggers_label"),
        fields: 4,
      }),
    );
  });

  it("acknowledges the modal submission as an update before running the import transaction", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-apply-order";
    storeTransferSnapshot(nonce, makeRecord({ detectedSections: ["chat"] }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-apply", locale: "en-US", nonce }),
      kind: "modal",
    });
    const deferUpdateSpy = spyOn(interaction, "deferUpdate");
    spyOn(interaction, "editReply");
    const acknowledged: boolean[] = [];
    const route = createTransferInteractionRoute({
      takeConfigSectionValues: () => ["chat"],
      applyConfigImport: async () => {
        acknowledged.push(interaction.deferred || interaction.replied);
        return { success: true, itemsImported: { configFieldsCount: 1 } };
      },
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Config apply ordering route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(acknowledged).toEqual([true]);
    // An update, not a defer: a plain defer would open a new ephemeral and leave the panel on screen.
    expect(deferUpdateSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the snapshot when the import fails and reports the repository error", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-apply-failure";
    storeTransferSnapshot(nonce, makeRecord({ detectedSections: ["chat"] }));
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-apply", locale: "en-US", nonce }),
      kind: "modal",
    });
    const editSpy = spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({
      takeConfigSectionValues: () => ["chat"],
      applyConfigImport: async () => ({ success: false, error: "commands.data.import.error_no_server_data" }),
    });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Failed config apply route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(readTransferSnapshot(nonce, "actor-1", "personal", "actor-1").status).toBe("ok");
    const panelText = collectText(editSpy.mock.calls[0]?.[0]);
    expect(panelText).toContain(localizer("en-US", "commands.transfer.config_import_failed_title"));
    expect(panelText).toContain(localizer("en-US", "commands.data.import.error_no_server_data"));
  });

  it("defaults to the workspace repository seam with the kind's own section vocabulary", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-default-workspace";
    storeTransferSnapshot(
      nonce,
      makeRecord({
        kind: "workspace_config",
        ownership: "workspace",
        destinationKey: "guild-1",
        exportResult: {
          success: true,
          sourceVersion: "2.0",
          sourceType: "workspace_config",
          detectedSections: ["chat"],
          payload: workspaceConfigExportDataSchema.parse({ chat: CHAT_SECTION_VALUES }),
          droppedFields: [],
        },
      }),
    );
    const importSpy = spyOn(importRepository, "importWorkspaceConfig").mockResolvedValue({
      success: true,
      itemsImported: { configFieldsCount: 2 },
    });
    const personalImportSpy = spyOn(importRepository, "importPersonalConfig");
    activeSpies.push(importSpy, personalImportSpy);
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-apply", locale: "en-US", nonce }),
      kind: "modal",
      guildId: "guild-1",
      canManageGuild: true,
    });
    spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({ takeConfigSectionValues: () => ["chat"] });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Default workspace seam route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(personalImportSpy).not.toHaveBeenCalled();
    expect(importSpy).toHaveBeenCalledTimes(1);
    const [destinationKey, payload, sections] = importSpy.mock.calls[0] ?? [];
    expect(destinationKey).toBe("guild-1");
    expect(sections).toEqual(["chat"]);
    expect(payload).toMatchObject({ chat: expect.objectContaining(CHAT_SECTION_VALUES) });
    expect(readTransferSnapshot(nonce, "actor-1", "workspace", "guild-1").status).toBe("missing");
  });

  it("defaults to the personal repository seam for a personal configuration snapshot", async () => {
    resetTransferSnapshots();
    const nonce = "nonce-config-default-personal";
    storeTransferSnapshot(
      nonce,
      makeRecord({
        kind: "personal_config",
        ownership: "personal",
        destinationKey: "actor-1",
        exportResult: {
          success: true,
          sourceVersion: "2.0",
          sourceType: "personal_config",
          detectedSections: ["profile"],
          payload: personalConfigExportDataSchema.parse({
            profile: { user_nickname: null, language_pref: "en-US" },
          }),
          droppedFields: [],
        },
      }),
    );
    const workspaceImportSpy = spyOn(importRepository, "importWorkspaceConfig");
    const personalImportSpy = spyOn(importRepository, "importPersonalConfig").mockResolvedValue({
      success: true,
      itemsImported: { configFieldsCount: 1 },
    });
    activeSpies.push(workspaceImportSpy, personalImportSpy);
    const interaction = makeInteraction({
      customId: makeRouteId({ action: "config-apply", locale: "en-US", nonce }),
      kind: "modal",
    });
    spyOn(interaction, "editReply");
    const route = createTransferInteractionRoute({ takeConfigSectionValues: () => ["profile"] });
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) throw new Error("Default personal seam route did not parse");

    await route.execute({} as Client, interaction, parsed);

    expect(workspaceImportSpy).not.toHaveBeenCalled();
    expect(personalImportSpy).toHaveBeenCalledTimes(1);
    expect(personalImportSpy.mock.calls[0]?.[0]).toBe("actor-1");
    expect(personalImportSpy.mock.calls[0]?.[2]).toEqual(["profile"]);
    expect(readTransferSnapshot(nonce, "actor-1", "personal", "actor-1").status).toBe("missing");
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
