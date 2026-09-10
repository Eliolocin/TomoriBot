import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { Attachment, Client } from "discord.js";
import { execute as executeImportConfig } from "@/commands/import/config";
import { startConfigImport, type ConfigImportDependencies } from "@/commands/import/configImportOperation";
import { execute as executeImportPersonalConfig } from "@/commands/import/personal/config";
import {
  EXPORT_V2_VERSION,
  getPersonalMemoriesV2ExportSchema,
  getWorkspaceMemoriesExportSchema,
  personalConfigExportSchema,
  personalSettingsExportSchema,
  serverConfigOnlyExportSchema,
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
import { initializeLocalizer } from "@/utils/text/localizer";
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

const PERSONAL_CONFIG_JSON = JSON.stringify(
  personalConfigExportSchema.parse({
    version: EXPORT_V2_VERSION,
    type: "personal_config",
    exported_at: "2026-01-01T00:00:00.000Z",
    data: { profile: { user_nickname: null, language_pref: "en-US" } },
  }),
);

const V1_WORKSPACE_CONFIG_JSON = JSON.stringify(
  serverConfigOnlyExportSchema.parse({
    version: "1.0",
    type: "server_config",
    exported_at: "2026-01-01T00:00:00.000Z",
    data: {
      config: { llm_temperature: 1, humanizer_degree: 1, timezone_offset: 0, llm_logit_biases: [] },
    },
  }),
);

const V1_PERSONAL_SETTINGS_JSON = JSON.stringify(
  personalSettingsExportSchema.parse({
    version: "1.0",
    type: "personal_settings",
    exported_at: "2026-01-01T00:00:00.000Z",
    data: { user_nickname: null, language_pref: "en-US" },
  }),
);

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
  deps: Partial<ConfigImportDependencies>;
  calls: DependencyCalls;
} {
  const calls: DependencyCalls = { downloads: 0, snapshots: [], previews: [], replies: [] };
  const contents = input.contents ?? WORKSPACE_CONFIG_JSON;

  const deps: Partial<ConfigImportDependencies> = {
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
      getAttachment: () => makeAttachment("config.json", options.contents ?? WORKSPACE_CONFIG_JSON),
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

afterEach(() => {
  resetTransferSnapshots();
});

beforeAll(async () => {
  await initializeLocalizer();
});

describe("config import operation", () => {
  it("accepts only the configuration formats each leaf owns", async () => {
    const { isConfigImportSourceTypeForKind } = await import("@/commands/import/configImportOperation");

    expect(isConfigImportSourceTypeForKind("workspace_config", "workspace_config")).toBe(true);
    expect(isConfigImportSourceTypeForKind("workspace_config", "server_config")).toBe(true);
    expect(isConfigImportSourceTypeForKind("personal_config", "personal_config")).toBe(true);
    expect(isConfigImportSourceTypeForKind("personal_config", "personal_settings")).toBe(true);

    expect(isConfigImportSourceTypeForKind("workspace_config", "personal_config")).toBe(false);
    expect(isConfigImportSourceTypeForKind("workspace_config", "workspace_memories")).toBe(false);
    expect(isConfigImportSourceTypeForKind("personal_config", "personal_memories")).toBe(false);
    // A v1 combined export carries memories beside its config, so it is not a config file for this entry point.
    expect(isConfigImportSourceTypeForKind("workspace_config", "server")).toBe(false);
    expect(isConfigImportSourceTypeForKind("personal_config", "personal")).toBe(false);
  });

  it("refuses a workspace import without Manage Server before downloading anything", async () => {
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: false });
    const { deps, calls } = makeDependencies({});

    await startConfigImport(interaction as never, LOCALE, "workspace_config", deps);

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
    const { deps, calls } = makeDependencies({});

    await startConfigImport(interaction as never, LOCALE, "workspace_config", deps);

    expect(calls.downloads).toBe(0);
    expect(calls.replies[0]).toMatchObject({ titleKey: "commands.data.import.no_permission_title" });
  });

  it("acknowledges the interaction before downloading the attachment", async () => {
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const acknowledged: boolean[] = [];
    const { deps } = makeDependencies({});
    deps.downloadAttachment = mock(async () => {
      acknowledged.push(interaction.deferred || interaction.replied);
      return { success: true, buffer: Buffer.from(WORKSPACE_CONFIG_JSON, "utf8") };
    });

    await startConfigImport(interaction as never, LOCALE, "workspace_config", deps);

    expect(acknowledged).toEqual([true]);
  });

  it("stores an actor-bound workspace snapshot and offers a Continue control carrying its nonce", async () => {
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const { deps, calls } = makeDependencies({});

    await startConfigImport(interaction as never, LOCALE, "workspace_config", deps);

    expect(calls.snapshots).toHaveLength(1);
    const stored = calls.snapshots[0];
    expect(stored?.nonce).toBe(NONCE);
    expect(stored?.record).toMatchObject({
      actorDiscId: ACTOR_ID,
      kind: "workspace_config",
      ownership: "workspace",
      destinationKey: GUILD_ID,
    });
    expect(stored?.record.exportResult.detectedSections).toEqual(["chat"]);
    expect(stored?.record.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    expect(calls.previews).toHaveLength(1);
    expect(findTransferAction(calls.previews[0], "config-continue")).toMatchObject({
      action: "config-continue",
      locale: LOCALE,
      nonce: NONCE,
    });
    expect(findTransferAction(calls.previews[0], "cancel")).toMatchObject({ action: "cancel", nonce: NONCE });
  });

  it("binds the real snapshot store so the routed continuation can find it", async () => {
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const { deps } = makeDependencies({ realSnapshotStore: true });

    await startConfigImport(interaction as never, LOCALE, "workspace_config", deps);

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
        getAttachment: () => makeAttachment("config.json", WORKSPACE_CONFIG_JSON),
      } as FakeInteraction["options"],
    });
    const { deps } = makeDependencies({ realPreviewDelivery: true, realSnapshotStore: true });

    await startConfigImport(interaction as never, LOCALE, "workspace_config", deps);

    expect(callMethods(calls)).toEqual(["deferReply", "editReply"]);
    const editPayload = calls[1]?.args[0] as { components?: unknown[] } | undefined;
    expect(findTransferAction(editPayload, "config-continue")).toMatchObject({ nonce: NONCE });
  });

  it("keys a personal import on the account even inside a guild", async () => {
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: false });
    const { deps, calls } = makeDependencies({ contents: PERSONAL_CONFIG_JSON });

    await startConfigImport(interaction as never, LOCALE, "personal_config", deps);

    expect(calls.replies).toEqual([]);
    expect(calls.snapshots[0]?.record).toMatchObject({
      kind: "personal_config",
      ownership: "personal",
      destinationKey: ACTOR_ID,
    });
  });

  it("accepts the v1 configuration exports through the compatibility adapter", async () => {
    const workspaceInteraction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const workspaceDeps = makeDependencies({ contents: V1_WORKSPACE_CONFIG_JSON });
    await startConfigImport(workspaceInteraction as never, LOCALE, "workspace_config", workspaceDeps.deps);
    expect(workspaceDeps.calls.snapshots[0]?.record).toMatchObject({
      kind: "workspace_config",
      ownership: "workspace",
    });
    expect(workspaceDeps.calls.snapshots[0]?.record.exportResult.sourceVersion).toBe("1.0");

    const personalInteraction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const personalDeps = makeDependencies({ contents: V1_PERSONAL_SETTINGS_JSON });
    await startConfigImport(personalInteraction as never, LOCALE, "personal_config", personalDeps.deps);
    expect(personalDeps.calls.snapshots[0]?.record).toMatchObject({
      kind: "personal_config",
      ownership: "personal",
    });
  });

  it("refuses every unusable file without storing a snapshot", async () => {
    const cases: Array<{ name: string; contents: string; titleKey: string; downloadFails?: boolean }> = [
      {
        name: "a download failure",
        contents: WORKSPACE_CONFIG_JSON,
        titleKey: "commands.data.import.invalid_file_title",
        downloadFails: true,
      },
      { name: "malformed JSON", contents: "{not json", titleKey: "commands.data.import.invalid_file_title" },
      { name: "a JSON array", contents: "[1,2,3]", titleKey: "commands.data.import.invalid_file_title" },
      {
        name: "an unsupported version",
        contents: JSON.stringify({ version: "3.0", type: "workspace_config", data: {} }),
        titleKey: "commands.data.import.invalid_file_title",
      },
      {
        name: "a workspace memory bundle",
        contents: WORKSPACE_MEMORIES_JSON,
        titleKey: "commands.transfer.config_wrong_file_title",
      },
      {
        name: "a personal memory bundle",
        contents: PERSONAL_MEMORIES_JSON,
        titleKey: "commands.transfer.config_wrong_file_title",
      },
      {
        name: "the other configuration scope",
        contents: PERSONAL_CONFIG_JSON,
        titleKey: "commands.transfer.config_wrong_file_title",
      },
      {
        name: "an empty configuration",
        contents: JSON.stringify({
          version: EXPORT_V2_VERSION,
          type: "workspace_config",
          exported_at: "2026-01-01T00:00:00.000Z",
          data: {},
        }),
        titleKey: "commands.transfer.config_no_importable_sections_title",
      },
    ];

    for (const testCase of cases) {
      resetTransferSnapshots();
      const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });
      const { deps, calls } = makeDependencies({
        contents: testCase.contents,
        downloadFails: testCase.downloadFails,
      });

      await startConfigImport(interaction as never, LOCALE, "workspace_config", deps);

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

  it("fingerprints the uploaded bytes rather than a constant", async () => {
    const first = makeDependencies({});
    const other = makeDependencies({ contents: PERSONAL_CONFIG_JSON });
    const interaction = makeImportInteraction({ inGuild: true, canManageGuild: true });

    await startConfigImport(interaction as never, LOCALE, "workspace_config", first.deps);
    const secondInteraction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    await startConfigImport(secondInteraction as never, LOCALE, "workspace_config", other.deps);

    const firstFingerprint = first.calls.snapshots[0]?.record.fingerprint;
    const secondFingerprint = other.calls.snapshots[0]?.record.fingerprint;
    expect(firstFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(secondFingerprint).not.toBe(firstFingerprint);
  });

  it("routes each leaf to its own format", async () => {
    const workspaceInteraction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const personalInteraction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const workspaceDeps = makeDependencies({});
    const personalDeps = makeDependencies({ contents: PERSONAL_CONFIG_JSON });

    await executeImportConfig({} as Client, workspaceInteraction as never, USER_DATA, LOCALE, workspaceDeps.deps);
    await executeImportPersonalConfig({} as Client, personalInteraction as never, USER_DATA, LOCALE, personalDeps.deps);

    expect(workspaceDeps.calls.snapshots[0]?.record.kind).toBe("workspace_config");
    expect(personalDeps.calls.snapshots[0]?.record.kind).toBe("personal_config");

    // The same workspace file through the personal leaf is a wrong-scope refusal, not a silent cross-scope import.
    const crossScopeInteraction = makeImportInteraction({ inGuild: true, canManageGuild: true });
    const crossScopeDeps = makeDependencies({});
    await executeImportPersonalConfig(
      {} as Client,
      crossScopeInteraction as never,
      USER_DATA,
      LOCALE,
      crossScopeDeps.deps,
    );
    expect(crossScopeDeps.calls.snapshots).toEqual([]);
    expect(crossScopeDeps.calls.replies[0]).toMatchObject({
      titleKey: "commands.transfer.config_wrong_file_title",
    });
  });
});
