import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { Attachment, Client } from "discord.js";
import { execute as executeImportMemories } from "@/commands/import/memories";
import { startMemoryImport, type MemoryImportDependencies } from "@/commands/import/memoriesImportOperation";
import { execute as executeImportPersonalMemories } from "@/commands/import/personal/memories";
import {
  EXPORT_V2_VERSION,
  getPersonalMemoriesV2ExportSchema,
  getWorkspaceMemoriesExportSchema,
  globalPersonalMemoriesExportSchema,
  personalMemoriesExportSchema,
  serverMemoriesExportSchema,
  workspaceConfigExportDataSchema,
  workspaceConfigExportSchema,
} from "@/types/db/dataExport";
import type { UserRow } from "@/types/db/schema";
import type { StandardEmbedOptions } from "@/types/discord/embed";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  readTransferSnapshot,
  resetTransferSnapshots,
  type TransferSnapshotRecordInput,
} from "@/utils/discord/interactions/transferSnapshotStore";
import { parseTransferPanelRoute, type TransferPanelRoute } from "@/utils/discord/transferCatalog";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { callMethods, type FakeInteraction, makeFakeInteraction } from "../../../helpers/fakeInteraction";

const GUILD_ID = "guild-111111111111111111";
const ACTOR_ID = "actor-222222222222222222";
const LOCALE = "en-US";
const NONCE = "abc123def456";
const ACTOR = {
  id: ACTOR_ID,
  displayName: "TestActor",
  globalName: "TestActor",
  username: "testactor",
  displayAvatarURL: () => "https://cdn.example.com/avatar.png",
};

const WORKSPACE_MEMORIES_JSON = JSON.stringify(
  getWorkspaceMemoriesExportSchema().parse({
    version: EXPORT_V2_VERSION,
    type: "workspace_memories",
    exported_at: "2026-01-01T00:00:00.000Z",
    data: { buckets: [{ name: "main", label: "Main", memories: [{ content: "A memory", tags: [] }] }] },
  }),
);

const PERSONAL_MEMORIES_JSON = JSON.stringify(
  getPersonalMemoriesV2ExportSchema().parse({
    version: EXPORT_V2_VERSION,
    type: "personal_memories",
    exported_at: "2026-01-01T00:00:00.000Z",
    data: { buckets: [{ name: "global", label: "Global", memories: [{ content: "A memory", tags: [] }] }] },
  }),
);

const WORKSPACE_CONFIG_JSON = JSON.stringify(
  workspaceConfigExportSchema.parse({
    version: EXPORT_V2_VERSION,
    type: "workspace_config",
    exported_at: "2026-01-01T00:00:00.000Z",
    data: workspaceConfigExportDataSchema.parse({
      chat: { llm_temperature: 1, humanizer_degree: 1, timezone_offset: 0, llm_logit_biases: [] },
    }),
  }),
);

const V1_SERVER_MEMORIES_JSON = JSON.stringify(
  serverMemoriesExportSchema.parse({
    version: "1.0",
    type: "server_memories",
    exported_at: "2026-01-01T00:00:00.000Z",
    data: { server_memories: [{ content: "A legacy memory", tags: [] }] },
  }),
);

const V1_PERSONAL_MEMORIES_JSON = JSON.stringify(
  personalMemoriesExportSchema.parse({
    version: "1.0",
    type: "personal_memories",
    exported_at: "2026-01-01T00:00:00.000Z",
    data: { personal_memories: [{ content: "A legacy memory", tags: [] }] },
  }),
);

const V1_GLOBAL_PERSONAL_MEMORIES_JSON = JSON.stringify(
  globalPersonalMemoriesExportSchema.parse({
    version: "1.0",
    type: "global_personal_memories",
    exported_at: "2026-01-01T00:00:00.000Z",
    data: { personal_memories: [{ content: "A legacy global memory", tags: [] }] },
  }),
);

const V1_COMBINED_SERVER_JSON = JSON.stringify({
  version: "1.0",
  type: "server",
  exported_at: "2026-01-01T00:00:00.000Z",
  data: { server_memories: [{ content: "A legacy memory", tags: [] }] },
});

const USER_DATA = { user_id: 1, user_disc_id: ACTOR_ID, language_pref: LOCALE } as unknown as UserRow;

function makeAttachment(fileName: string, contents: string): Attachment {
  return {
    url: `https://cdn.discordapp.com/attachments/1/2/${fileName}`,
    size: contents.length,
  } as unknown as Attachment;
}

interface DependencyCalls {
  downloads: number;
  snapshots: Array<{ nonce: string; record: TransferSnapshotRecordInput }>;
  previews: unknown[];
  replies: StandardEmbedOptions[];
}

interface DependencyOptions {
  contents?: string;
  downloadFails?: boolean;
  /** Leaves the real snapshot store in place, so a test can observe the binding the route will later look for. */
  realSnapshotStore?: boolean;
  /** Leaves the real guarded panel delivery in place, so a test can observe the real interaction sink. */
  realPreviewDelivery?: boolean;
}

function makeDependencies(input: DependencyOptions = {}): {
  deps: Partial<MemoryImportDependencies>;
  calls: DependencyCalls;
} {
  const calls: DependencyCalls = { downloads: 0, snapshots: [], previews: [], replies: [] };
  const contents = input.contents ?? WORKSPACE_MEMORIES_JSON;

  const deps: Partial<MemoryImportDependencies> = {
    downloadAttachment: mock(async () => {
      calls.downloads += 1;
      if (input.downloadFails) return { success: false };
      return { success: true, buffer: Buffer.from(contents, "utf8") };
    }),
    createSnapshotNonce: () => NONCE,
    replyInfoEmbed: mock(async (_interaction, _locale, options) => {
      calls.replies.push(options);
    }),
  };

  if (!input.realSnapshotStore) {
    deps.storeSnapshot = mock((nonce: string, record: TransferSnapshotRecordInput) => {
      calls.snapshots.push({ nonce, record });
    });
  }
  if (!input.realPreviewDelivery) {
    deps.deliverPreview = mock(async (_interaction, _locale, payload) => {
      calls.previews.push(payload);
      return undefined;
    });
  }

  return { deps, calls };
}

function makeImportInteraction(options: {
  inGuild: boolean;
  canManageGuild: boolean;
  contents?: string;
}): FakeInteraction {
  return makeFakeInteraction({
    guildId: options.inGuild ? GUILD_ID : null,
    guild: options.inGuild ? { id: GUILD_ID } : null,
    user: ACTOR,
    memberPermissions: { has: (flag: unknown) => flag === "ManageGuild" && options.canManageGuild },
    options: {
      getString: () => null,
      getBoolean: () => null,
      getAttachment: () => makeAttachment("memories.json", options.contents ?? WORKSPACE_MEMORIES_JSON),
    } as FakeInteraction["options"],
  }).interaction;
}

function collectCustomIds(payload: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    // The panel builders hand raw component objects straight to Discord, so the identifier is still camelCase here.
    if (typeof record.custom_id === "string") found.push(record.custom_id);
    if (typeof record.customId === "string") found.push(record.customId);
    for (const value of Object.values(record)) walk(value);
  };
  walk(payload);
  return found;
}

function findTransferAction(payload: unknown, action: TransferPanelRoute["action"]): TransferPanelRoute | null {
  for (const customId of collectCustomIds(payload)) {
    const parsed = parseInteractionRoute(customId);
    if (!parsed) continue;
    const route = parseTransferPanelRoute(parsed);
    if (route?.action === action) return route;
  }
  return null;
}

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

afterEach(() => {
  resetTransferSnapshots();
});

beforeAll(async () => {
  await initializeLocalizer();
});

describe("memory import operation", () => {
  it("classifies every memory format as the leaf's own, the other ownership's, or unsupported", async () => {
    const { classifyMemoryImportSource, isMemoryImportSourceTypeForKind } = await import(
      "@/commands/import/memoriesImportOperation"
    );

    expect(classifyMemoryImportSource("workspace_memories", "workspace_memories")).toBe("same-ownership");
    expect(classifyMemoryImportSource("workspace_memories", "server_memories")).toBe("same-ownership");
    expect(classifyMemoryImportSource("personal_memories", "personal_memories")).toBe("same-ownership");
    expect(classifyMemoryImportSource("personal_memories", "global_personal_memories")).toBe("same-ownership");

    // A memory file from the other ownership is importable once the reader has been told about the change.
    expect(classifyMemoryImportSource("workspace_memories", "personal_memories")).toBe("cross-ownership");
    expect(classifyMemoryImportSource("workspace_memories", "global_personal_memories")).toBe("cross-ownership");
    expect(classifyMemoryImportSource("personal_memories", "workspace_memories")).toBe("cross-ownership");
    expect(classifyMemoryImportSource("personal_memories", "server_memories")).toBe("cross-ownership");

    expect(classifyMemoryImportSource("workspace_memories", "workspace_config")).toBe("unsupported");
    // A v1 combined export carries configuration beside its memories, so it is not a memory file for either leaf.
    expect(classifyMemoryImportSource("workspace_memories", "server")).toBe("unsupported");
    expect(classifyMemoryImportSource("personal_memories", "personal")).toBe("unsupported");
    expect(classifyMemoryImportSource("personal_memories", "unknown")).toBe("unsupported");

    expect(isMemoryImportSourceTypeForKind("workspace_memories", "personal_memories")).toBe(true);
    expect(isMemoryImportSourceTypeForKind("workspace_memories", "server")).toBe(false);
  });

  it("refuses a workspace import without Manage Server before downloading anything", async () => {
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: false });
    const { deps, calls } = makeDependencies();

    await startMemoryImport(interaction as never, LOCALE, "workspace_memories", deps);

    expect(calls.downloads).toBe(0);
    expect(calls.snapshots).toEqual([]);
    expect(calls.previews).toEqual([]);
    expect(calls.replies[0]).toMatchObject({
      titleKey: "commands.data.import.no_permission_title",
      descriptionKey: "commands.data.import.no_permission_description",
    });
    expect(interaction.deferred).toBe(false);
  });

  it("still refuses when the guild is absent from the client cache", async () => {
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: false });
    interaction.guild = null;
    const { deps, calls } = makeDependencies();

    await startMemoryImport(interaction as never, LOCALE, "workspace_memories", deps);

    expect(calls.downloads).toBe(0);
    expect(calls.replies[0]).toMatchObject({ titleKey: "commands.data.import.no_permission_title" });
  });

  it("acknowledges the interaction before downloading the attachment", async () => {
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const acknowledged: boolean[] = [];
    const { deps } = makeDependencies();
    deps.downloadAttachment = mock(async () => {
      acknowledged.push(interaction.deferred || interaction.replied);
      return { success: true, buffer: Buffer.from(WORKSPACE_MEMORIES_JSON, "utf8") };
    });

    await startMemoryImport(interaction as never, LOCALE, "workspace_memories", deps);

    expect(acknowledged).toEqual([true]);
  });

  it("stores an actor-bound workspace snapshot and offers Merge, Replace, and Cancel carrying its nonce", async () => {
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const { deps, calls } = makeDependencies();

    await startMemoryImport(interaction as never, LOCALE, "workspace_memories", deps);

    expect(calls.snapshots).toHaveLength(1);
    const stored = calls.snapshots[0];
    expect(stored?.nonce).toBe(NONCE);
    expect(stored?.record).toMatchObject({
      actorDiscId: ACTOR_ID,
      kind: "workspace_memories",
      ownership: "workspace",
      destinationKey: GUILD_ID,
    });
    expect(stored?.record.exportResult.detectedSections).toEqual(["main"]);
    expect(stored?.record.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The strategy is chosen on the preview, so no route action can reach the mapping surface before it is set.
    expect(stored?.record.strategy).toBeUndefined();

    expect(calls.previews).toHaveLength(1);
    expect(findTransferAction(calls.previews[0], "memory-strategy")).toMatchObject({
      action: "memory-strategy",
      locale: LOCALE,
      nonce: NONCE,
      strategy: "merge",
    });
    expect(findTransferAction(calls.previews[0], "cancel")).toMatchObject({ action: "cancel", nonce: NONCE });
    expect(collectText(calls.previews[0])).toContain(localizer("en-US", "commands.transfer.memory_preview_title"));
  });

  it("binds the real snapshot store so the routed continuation can find it", async () => {
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const { deps } = makeDependencies({ realSnapshotStore: true });

    await startMemoryImport(interaction as never, LOCALE, "workspace_memories", deps);

    expect(readTransferSnapshot(NONCE, ACTOR_ID, "workspace", GUILD_ID).status).toBe("ok");
    expect(readTransferSnapshot(NONCE, ACTOR_ID, "personal", ACTOR_ID).status).toBe("forbidden");
    expect(readTransferSnapshot(NONCE, "other-actor", "workspace", GUILD_ID).status).toBe("forbidden");
    expect(readTransferSnapshot(NONCE, ACTOR_ID, "workspace", "other-guild").status).toBe("forbidden");
  });

  it("drives the real preview delivery seam after deferring", async () => {
    const { interaction, calls } = makeFakeInteraction({
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      user: ACTOR,
      memberPermissions: { has: () => true },
      options: {
        getString: () => null,
        getBoolean: () => null,
        getAttachment: () => makeAttachment("memories.json", WORKSPACE_MEMORIES_JSON),
      } as FakeInteraction["options"],
    });
    const { deps } = makeDependencies({ realPreviewDelivery: true, realSnapshotStore: true });

    await startMemoryImport(interaction as never, LOCALE, "workspace_memories", deps);

    expect(callMethods(calls)).toEqual(["deferReply", "editReply"]);
    const editPayload = calls[1]?.args[0] as { components?: unknown[] } | undefined;
    expect(findTransferAction(editPayload, "memory-strategy")).toMatchObject({ nonce: NONCE });
  });

  it("keys a personal import on the account even inside a guild", async () => {
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: false });
    const { deps, calls } = makeDependencies({ contents: PERSONAL_MEMORIES_JSON });

    await startMemoryImport(interaction as never, LOCALE, "personal_memories", deps);

    expect(calls.replies).toEqual([]);
    expect(calls.snapshots[0]?.record).toMatchObject({
      kind: "personal_memories",
      ownership: "personal",
      destinationKey: ACTOR_ID,
    });
  });

  it("accepts every v1 single-scope memory export through the compatibility adapter", async () => {
    const cases: Array<{ contents: string; kind: "workspace_memories" | "personal_memories" }> = [
      { contents: V1_SERVER_MEMORIES_JSON, kind: "workspace_memories" },
      { contents: V1_PERSONAL_MEMORIES_JSON, kind: "personal_memories" },
      { contents: V1_GLOBAL_PERSONAL_MEMORIES_JSON, kind: "personal_memories" },
    ];

    for (const testCase of cases) {
      const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });
      const { deps, calls } = makeDependencies({ contents: testCase.contents });

      await startMemoryImport(interaction as never, LOCALE, testCase.kind, deps);

      expect({ case: testCase.kind, snapshots: calls.snapshots.length }).toEqual({
        case: testCase.kind,
        snapshots: 1,
      });
      expect({ case: testCase.kind, version: calls.snapshots[0]?.record.exportResult.sourceVersion }).toEqual({
        case: testCase.kind,
        version: "1.0",
      });
    }
  });

  it("refuses every unusable file without storing a snapshot", async () => {
    const cases: Array<{ name: string; contents: string; titleKey: string; downloadFails?: boolean }> = [
      {
        name: "a download failure",
        contents: WORKSPACE_MEMORIES_JSON,
        titleKey: "commands.data.import.invalid_file_title",
        downloadFails: true,
      },
      { name: "malformed JSON", contents: "{not json", titleKey: "commands.data.import.invalid_file_title" },
      { name: "a JSON array", contents: "[1,2,3]", titleKey: "commands.data.import.invalid_file_title" },
      {
        name: "an unsupported version",
        contents: JSON.stringify({ version: "3.0", type: "workspace_memories", data: {} }),
        titleKey: "commands.data.import.invalid_file_title",
      },
      {
        name: "a configuration file",
        contents: WORKSPACE_CONFIG_JSON,
        titleKey: "commands.transfer.memories_wrong_file_title",
      },
      {
        name: "a v1 combined export",
        contents: V1_COMBINED_SERVER_JSON,
        titleKey: "commands.data.import.invalid_file_title",
      },
    ];

    for (const testCase of cases) {
      resetTransferSnapshots();
      const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });
      const { deps, calls } = makeDependencies({
        contents: testCase.contents,
        downloadFails: testCase.downloadFails,
      });

      await startMemoryImport(interaction as never, LOCALE, "workspace_memories", deps);

      expect({ case: testCase.name, previews: calls.previews.length, snapshots: calls.snapshots.length }).toEqual({
        case: testCase.name,
        previews: 0,
        snapshots: 0,
      });
      expect({ case: testCase.name, titleKey: calls.replies[0]?.titleKey }).toEqual({
        case: testCase.name,
        titleKey: testCase.titleKey,
      });
    }
  });

  it("accepts a single-group file from the other ownership and discloses the ownership change", async () => {
    // The workspace leaf reading a personal memory file: one bucket, so it is importable here after disclosure.
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const { deps, calls } = makeDependencies({ contents: PERSONAL_MEMORIES_JSON });

    await startMemoryImport(interaction as never, LOCALE, "workspace_memories", deps);

    expect(calls.snapshots).toHaveLength(1);
    expect(calls.snapshots[0]?.record).toMatchObject({
      kind: "workspace_memories",
      ownership: "workspace",
      destinationKey: GUILD_ID,
    });
    const previewText = collectText(calls.previews[0]);
    expect(previewText).toContain(localizer(LOCALE, "commands.transfer.memory_cross_ownership_heading"));
    expect(previewText).toContain(
      localizer(LOCALE, "commands.transfer.memory_cross_ownership_source_line", {
        source: localizer(LOCALE, "commands.transfer.personal_memories_label"),
      }),
    );
    expect(previewText).toContain(
      localizer(LOCALE, "commands.transfer.memory_cross_ownership_destination_line", {
        destination: localizer(LOCALE, "commands.transfer.workspace_memories_label"),
      }),
    );

    // The mirror direction: the personal leaf reading a workspace memory file.
    const personalInteraction = makeImportInteraction({ inGuild: true, canManageGuild: false });
    const personalDeps = makeDependencies({ contents: WORKSPACE_MEMORIES_JSON });
    await startMemoryImport(personalInteraction as never, LOCALE, "personal_memories", personalDeps.deps);

    expect(personalDeps.calls.snapshots[0]?.record).toMatchObject({
      kind: "personal_memories",
      ownership: "personal",
      destinationKey: ACTOR_ID,
    });
    const personalPreviewText = collectText(personalDeps.calls.previews[0]);
    expect(personalPreviewText).toContain(
      localizer(LOCALE, "commands.transfer.memory_cross_ownership_source_line", {
        source: localizer(LOCALE, "commands.transfer.workspace_memories_label"),
      }),
    );
    expect(personalPreviewText).toContain(
      localizer(LOCALE, "commands.transfer.memory_cross_ownership_destination_line", {
        destination: localizer(LOCALE, "commands.transfer.personal_memories_label"),
      }),
    );
  });

  it("refuses a multi-group file from the other ownership without storing a snapshot", async () => {
    const multiBucketPersonalFile = JSON.stringify(
      getPersonalMemoriesV2ExportSchema().parse({
        version: EXPORT_V2_VERSION,
        type: "personal_memories",
        exported_at: "2026-01-01T00:00:00.000Z",
        data: {
          buckets: [
            { name: "global", label: "Global", memories: [{ content: "A memory", tags: [] }] },
            { name: "persona-1", label: "Sparrow", memories: [{ content: "Another memory", tags: [] }] },
          ],
        },
      }),
    );
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const { deps, calls } = makeDependencies({ contents: multiBucketPersonalFile });

    await startMemoryImport(interaction as never, LOCALE, "workspace_memories", deps);

    expect(calls.previews).toEqual([]);
    expect(calls.snapshots).toEqual([]);
    expect(calls.replies[0]).toMatchObject({
      titleKey: "commands.transfer.memories_cross_ownership_multiple_buckets_title",
      descriptionKey: "commands.transfer.memories_cross_ownership_multiple_buckets_description",
    });

    // The same file through its own leaf is an ordinary multi-bucket import, which the mapping surface handles.
    const ownLeafDeps = makeDependencies({ contents: multiBucketPersonalFile });
    await startMemoryImport(
      makeImportInteraction({ inGuild: true, canManageGuild: true }) as never,
      LOCALE,
      "personal_memories",
      ownLeafDeps.deps,
    );
    expect(ownLeafDeps.calls.snapshots).toHaveLength(1);
    expect(collectText(ownLeafDeps.calls.previews[0])).not.toContain(
      localizer(LOCALE, "commands.transfer.memory_cross_ownership_notice", {
        source: localizer(LOCALE, "commands.transfer.workspace_memories_label"),
        destination: localizer(LOCALE, "commands.transfer.personal_memories_label"),
      }),
    );
  });

  it("fingerprints the uploaded bytes rather than a constant", async () => {
    const first = makeDependencies({});
    const other = makeDependencies({ contents: PERSONAL_MEMORIES_JSON });
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });

    await startMemoryImport(interaction as never, LOCALE, "workspace_memories", first.deps);
    const secondInteraction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    await startMemoryImport(secondInteraction as never, LOCALE, "workspace_memories", other.deps);

    const firstFingerprint = first.calls.snapshots[0]?.record.fingerprint;
    const secondFingerprint = other.calls.snapshots[0]?.record.fingerprint;
    expect(firstFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(secondFingerprint).not.toBe(firstFingerprint);
  });

  it("routes each leaf to its own format", async () => {
    const workspaceInteraction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const personalInteraction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const workspaceDeps = makeDependencies({});
    const personalDeps = makeDependencies({ contents: PERSONAL_MEMORIES_JSON });

    await executeImportMemories({} as Client, workspaceInteraction as never, USER_DATA, LOCALE, workspaceDeps.deps);
    await executeImportPersonalMemories(
      {} as Client,
      personalInteraction as never,
      USER_DATA,
      LOCALE,
      personalDeps.deps,
    );

    expect(workspaceDeps.calls.snapshots[0]?.record.kind).toBe("workspace_memories");
    expect(personalDeps.calls.snapshots[0]?.record.kind).toBe("personal_memories");

    // The same single-group workspace file through the personal leaf is a cross-ownership import, not a silent
    // scope change: the snapshot is stored under the personal kind and the preview carries the ownership notice.
    const crossScopeInteraction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const crossScopeDeps = makeDependencies({});
    await executeImportPersonalMemories(
      {} as Client,
      crossScopeInteraction as never,
      USER_DATA,
      LOCALE,
      crossScopeDeps.deps,
    );
    expect(crossScopeDeps.calls.snapshots[0]?.record).toMatchObject({
      kind: "personal_memories",
      ownership: "personal",
    });
    expect(collectText(crossScopeDeps.calls.previews[0])).toContain(
      localizer(LOCALE, "commands.transfer.memory_cross_ownership_source_line", {
        source: localizer(LOCALE, "commands.transfer.workspace_memories_label"),
      }),
    );

    // A configuration file through a memory leaf stays a wrong-file refusal, so the widened acceptance is bounded
    // to memory formats the importer understands.
    const configInteraction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const configDeps = makeDependencies({ contents: WORKSPACE_CONFIG_JSON });
    await executeImportPersonalMemories({} as Client, configInteraction as never, USER_DATA, LOCALE, configDeps.deps);
    expect(configDeps.calls.snapshots).toEqual([]);
    expect(configDeps.calls.replies[0]).toMatchObject({
      titleKey: "commands.transfer.memories_wrong_file_title",
    });
  });
});
