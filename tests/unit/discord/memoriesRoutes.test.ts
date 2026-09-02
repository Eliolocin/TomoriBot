import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import {
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { ServerMemoryRow, TomoriState } from "@/types/db/schema";
import {
  buildMemoriesRouteId,
  computeServerStmFingerprint,
  listMemoriesPanelActions,
  parseMemoriesPanelRoute,
  type MemoriesPanelRoute,
} from "@/utils/discord/memoriesPanelCatalog";
import {
  buildInitialMemoriesPanel,
  createMemoriesInteractionRoute,
  DOCUMENT_RESULT_RECEIPT_KEYS,
  MEMORIES_RECEIPT_KEYS,
  serverMemoriesOperations,
  type MemoriesRouteDependencies,
} from "@/utils/discord/interactions/memoriesRoutes";
import { parseInteractionRoute, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildAddServerMemoryModal,
  buildAddDocumentModal,
  buildEditDocumentChunkModal,
  buildEditServerMemoryModal,
  buildMemoriesPanelPayload,
  buildServerStmModal,
  buildServerMemoryModalFieldId,
  parseServerMemoryTags,
} from "@/utils/discord/ui/memoriesPanel";
import * as tomoriStateCache from "@/utils/cache/tomoriStateCache";
import { llmModelRepo, ragRepository, serverMemoryRepository } from "@/utils/db/repositories";
import { serverDocumentsOperations } from "@/utils/discord/interactions/memoriesDocumentOperations";
import * as ragAvailability from "@/utils/db/ragAvailability";
import * as documentService from "@/utils/documents/documentService";
import * as textExtractor from "@/utils/documents/textExtractor";
import * as embeddingProvider from "@/utils/embeddings/embeddingProvider";
import * as credentialResolver from "@/utils/provider/credentialResolver";
import * as rateLimiter from "@/utils/security/rateLimiter";
import * as safeDownloadModule from "@/utils/security/safeDownload";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function requireRoute(customId: string): ParsedInteractionRoute {
  const parsed = parseInteractionRoute(customId);
  if (!parsed) throw new Error(`Failed to parse route for customId: ${customId}`);
  return parsed;
}

function makeMemory(id: number, overrides: Partial<ServerMemoryRow> = {}): ServerMemoryRow {
  return {
    server_memory_id: id,
    server_id: 1,
    persona_id: 10,
    persona_lineage_id: 1770,
    user_id: 42,
    content: `Server memory content ${id}`,
    tags: ["general", "lore"],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makePersona(id: number, lineageId: number, name: string, isAlter = false): TomoriState {
  return {
    persona_id: id,
    persona_lineage_id: lineageId,
    persona_nickname: name,
    is_alter: isAlter,
    is_active: true,
  } as unknown as TomoriState;
}

function collectSelects(
  value: unknown,
): Array<{ customId?: string; options?: Array<{ value?: string; label?: string; description?: string }> }> {
  if (Array.isArray(value)) return value.flatMap(collectSelects);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const self = record.type === ComponentType.StringSelect ? [record as never] : [];
  return [...self, ...Object.values(record).flatMap(collectSelects)];
}

function collectButtons(
  value: unknown,
): Array<{ customId?: string; label?: string; style?: ButtonStyle; disabled?: boolean }> {
  if (Array.isArray(value)) return value.flatMap(collectButtons);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const self = record.type === ComponentType.Button ? [record as never] : [];
  return [...self, ...Object.values(record).flatMap(collectButtons)];
}

function collectTextDisplays(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectTextDisplays);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const self = record.type === ComponentType.TextDisplay && typeof record.content === "string" ? [record.content] : [];
  return [...self, ...Object.values(record).flatMap(collectTextDisplays)];
}

describe("memories panel route catalog", () => {
  const WIRE_CONTRACT_V1: ReadonlyArray<readonly [string, MemoriesPanelRoute]> = [
    ["memories:v1:category:en-US:memories", { action: "category", locale: "en-US", category: "memories" }],
    ["memories:v1:category:en-US:documents", { action: "category", locale: "en-US", category: "documents" }],
    ["memories:v1:category:en-US:stm", { action: "category", locale: "en-US", category: "stm" }],
    ["memories:v1:persona-select:en-US:1770", { action: "persona-select", locale: "en-US", lineageId: 1770 }],
    [
      "memories:v1:persona-page:en-US:1770:1",
      { action: "persona-page", locale: "en-US", lineageId: 1770, rangeIndex: 1 },
    ],
    ["memories:v1:select:en-US:1770:1", { action: "select", locale: "en-US", lineageId: 1770, rangeIndex: 1 }],
    ["memories:v1:select:en-US:1770", { action: "select", locale: "en-US", lineageId: 1770 }],
    ["memories:v1:range:en-US:1770:2", { action: "range", locale: "en-US", lineageId: 1770, rangeIndex: 2 }],
    ["memories:v1:range-open:en-US:1770", { action: "range-open", locale: "en-US", lineageId: 1770 }],
    ["memories:v1:range-page:en-US:1770:3", { action: "range-page", locale: "en-US", lineageId: 1770, chooserPage: 3 }],
    ["memories:v1:range-cancel:en-US:1770", { action: "range-cancel", locale: "en-US", lineageId: 1770 }],
    [
      "memories:v1:add-submit:en-US:1770:nonce123",
      { action: "add-submit", locale: "en-US", lineageId: 1770, nonce: "nonce123" },
    ],
    ["memories:v1:edit-open:en-US:1770:42", { action: "edit-open", locale: "en-US", lineageId: 1770, memoryId: 42 }],
    [
      "memories:v1:edit-submit:en-US:1770:42:nonce123",
      { action: "edit-submit", locale: "en-US", lineageId: 1770, memoryId: 42, nonce: "nonce123" },
    ],
    [
      "memories:v1:remove-prompt:en-US:1770:42",
      { action: "remove-prompt", locale: "en-US", lineageId: 1770, memoryId: 42 },
    ],
    [
      "memories:v1:remove-confirm:en-US:1770:42",
      { action: "remove-confirm", locale: "en-US", lineageId: 1770, memoryId: 42 },
    ],
    [
      "memories:v1:remove-cancel:en-US:1770:42",
      { action: "remove-cancel", locale: "en-US", lineageId: 1770, memoryId: 42 },
    ],
    [
      "memories:v1:vectorize-prompt:en-US:1770:10:42",
      { action: "vectorize-prompt", locale: "en-US", lineageId: 1770, personaId: 10, memoryId: 42 },
    ],
    [
      "memories:v1:vectorize-confirm:en-US:1770:10:42",
      { action: "vectorize-confirm", locale: "en-US", lineageId: 1770, personaId: 10, memoryId: 42 },
    ],
    [
      "memories:v1:vectorize-submit:en-US:1770:10:42:nonce123",
      {
        action: "vectorize-submit",
        locale: "en-US",
        lineageId: 1770,
        personaId: 10,
        memoryId: 42,
        nonce: "nonce123",
      },
    ],
    [
      "memories:v1:vectorize-cancel:en-US:1770:10:42",
      { action: "vectorize-cancel", locale: "en-US", lineageId: 1770, personaId: 10, memoryId: 42 },
    ],
    ["memories:v1:document-scope:en-US:0", { action: "document-scope", locale: "en-US", personaId: 0 }],
    [
      "memories:v1:document-persona-select:en-US:10",
      { action: "document-persona-select", locale: "en-US", personaId: 10 },
    ],
    [
      "memories:v1:document-persona-page:en-US:10:1",
      { action: "document-persona-page", locale: "en-US", personaId: 10, rangeIndex: 1 },
    ],
    [
      "memories:v1:document-select:en-US:10:2",
      { action: "document-select", locale: "en-US", personaId: 10, rangeIndex: 2 },
    ],
    [
      "memories:v1:document-range:en-US:10:2",
      { action: "document-range", locale: "en-US", personaId: 10, rangeIndex: 2 },
    ],
    ["memories:v1:document-range-open:en-US:10", { action: "document-range-open", locale: "en-US", personaId: 10 }],
    [
      "memories:v1:document-range-page:en-US:10:3",
      { action: "document-range-page", locale: "en-US", personaId: 10, chooserPage: 3 },
    ],
    ["memories:v1:document-range-cancel:en-US:10", { action: "document-range-cancel", locale: "en-US", personaId: 10 }],
    [
      "memories:v1:document-add-submit:en-US:0:nonce123",
      { action: "document-add-submit", locale: "en-US", personaId: 0, nonce: "nonce123" },
    ],
    [
      "memories:v1:document-remove-prompt:en-US:10:77",
      { action: "document-remove-prompt", locale: "en-US", personaId: 10, documentId: 77 },
    ],
    [
      "memories:v1:document-remove-confirm:en-US:10:77",
      { action: "document-remove-confirm", locale: "en-US", personaId: 10, documentId: 77 },
    ],
    [
      "memories:v1:document-remove-cancel:en-US:10:77",
      { action: "document-remove-cancel", locale: "en-US", personaId: 10, documentId: 77 },
    ],
    [
      "memories:v1:history-remove-prompt:en-US:10:77",
      { action: "history-remove-prompt", locale: "en-US", personaId: 10, documentId: 77 },
    ],
    [
      "memories:v1:history-remove-confirm:en-US:10:77",
      { action: "history-remove-confirm", locale: "en-US", personaId: 10, documentId: 77 },
    ],
    [
      "memories:v1:history-remove-cancel:en-US:10:77",
      { action: "history-remove-cancel", locale: "en-US", personaId: 10, documentId: 77 },
    ],
    [
      "memories:v1:document-chunk-prev:en-US:10:77:3",
      { action: "document-chunk-prev", locale: "en-US", personaId: 10, documentId: 77, chunkIdx: 3 },
    ],
    [
      "memories:v1:document-chunk-next:en-US:10:77:3",
      { action: "document-chunk-next", locale: "en-US", personaId: 10, documentId: 77, chunkIdx: 3 },
    ],
    [
      "memories:v1:document-chunk-edit-open:en-US:10:77:3",
      { action: "document-chunk-edit-open", locale: "en-US", personaId: 10, documentId: 77, chunkIdx: 3 },
    ],
    [
      "memories:v1:document-chunk-remove-prompt:en-US:10:77:3",
      { action: "document-chunk-remove-prompt", locale: "en-US", personaId: 10, documentId: 77, chunkIdx: 3 },
    ],
    [
      "memories:v1:document-chunk-remove-confirm:en-US:10:77:3",
      { action: "document-chunk-remove-confirm", locale: "en-US", personaId: 10, documentId: 77, chunkIdx: 3 },
    ],
    [
      "memories:v1:document-chunk-remove-cancel:en-US:10:77:3",
      { action: "document-chunk-remove-cancel", locale: "en-US", personaId: 10, documentId: 77, chunkIdx: 3 },
    ],
    [
      "memories:v1:document-chunk-edit-submit:en-US:10:77:3:nonce123",
      {
        action: "document-chunk-edit-submit",
        locale: "en-US",
        personaId: 10,
        documentId: 77,
        chunkIdx: 3,
        nonce: "nonce123",
      },
    ],
    ["memories:v1:stm-open:en-US", { action: "stm-open", locale: "en-US" }],
    ["memories:v1:stm-submit:en-US:nonce123", { action: "stm-submit", locale: "en-US", nonce: "nonce123" }],
    [
      "memories:v1:stm-entry:en-US:12345678901234567:0",
      { action: "stm-entry", locale: "en-US", channelId: "12345678901234567", personaId: 0 },
    ],
    [
      "memories:v1:retry:en-US:memories:1770",
      { action: "retry", locale: "en-US", category: "memories", lineageId: 1770 },
    ],
    ["memories:v1:retry:en-US:documents", { action: "retry", locale: "en-US", category: "documents" }],
    ["memories:v1:refresh:en-US:stm", { action: "refresh", locale: "en-US", category: "stm" }],
  ];

  it("decodes literal custom ID strings to exact typed routes", () => {
    for (const [customId, expectedRoute] of WIRE_CONTRACT_V1) {
      const parsed = requireRoute(customId);
      const decoded = parseMemoriesPanelRoute(parsed);
      expect(decoded).toEqual(expectedRoute);
    }
  });

  it("ensures optional properties are absent rather than undefined in parsed routes", () => {
    const parsedSelectWithoutRange = parseMemoriesPanelRoute(requireRoute("memories:v1:select:en-US:1770"));
    expect(parsedSelectWithoutRange).toBeDefined();
    if (parsedSelectWithoutRange) {
      expect("rangeIndex" in parsedSelectWithoutRange).toBe(false);
    }

    const parsedRetryWithoutLineage = parseMemoriesPanelRoute(requireRoute("memories:v1:retry:en-US:documents"));
    expect(parsedRetryWithoutLineage).toBeDefined();
    if (parsedRetryWithoutLineage) {
      expect("lineageId" in parsedRetryWithoutLineage).toBe(false);
    }
  });

  it("round trips every action through buildMemoriesRouteId and parseMemoriesPanelRoute", () => {
    const catalogActions = listMemoriesPanelActions().sort();
    const wireActions = [...new Set(WIRE_CONTRACT_V1.map(([, route]) => route.action))].sort();
    expect(wireActions).toEqual(catalogActions);

    for (const [customId, expectedRoute] of WIRE_CONTRACT_V1) {
      const encoded = buildMemoriesRouteId(expectedRoute);
      expect(encoded).toBe(customId);
      const parsed = requireRoute(encoded);
      const decoded = parseMemoriesPanelRoute(parsed);
      expect(decoded).toEqual(expectedRoute);
    }
  });

  it("keeps custom IDs within Discord's 100 character limit", () => {
    for (const [customId] of WIRE_CONTRACT_V1) {
      expect(customId.length).toBeLessThanOrEqual(100);
    }
  });

  it("rejects invalid namespaces and versions", () => {
    expect(
      parseMemoriesPanelRoute({ namespace: "other", version: "v1", segments: ["category", "en-US", "memories"] }),
    ).toBeNull();
    expect(
      parseMemoriesPanelRoute({ namespace: "memories", version: "v99", segments: ["category", "en-US", "memories"] }),
    ).toBeNull();
  });
});

describe("memories modals and tag parser", () => {
  it("pins raw modal component type 19 for file upload in add modal", () => {
    const modal = buildAddServerMemoryModal("en-US", 1770, "nonce123");
    const fileContainer = modal.components.find((c) => c.component?.custom_id?.startsWith("file_"));
    expect(fileContainer).toBeDefined();
    expect(fileContainer?.component?.type).toBe(19);
  });

  it("pins document uploads to type 19 and STM groups to type 22", () => {
    const documentModal = buildAddDocumentModal("en-US", 0, "nonce123");
    const file = documentModal.components.find((component) => component.component?.custom_id?.startsWith("file_"));
    expect(file?.component?.type).toBe(19);

    const stmModal = buildServerStmModal(
      "en-US",
      [
        {
          channelId: "12345678901234567",
          personaId: null,
          personaName: "Unscoped",
          lastUpdated: 1,
        },
      ],
      "nonce123",
    );
    expect(stmModal.components[0]?.component?.type).toBe(22);
    expect(stmModal.components[0]?.component?.options).toHaveLength(1);
  });

  it("prefills document channel filters when editing a chunk", () => {
    const modal = buildEditDocumentChunkModal("en-US", 10, 77, 0, "Stored chunk", ["#general", "#lore"], "nonce123");
    const channels = modal.components.find((component) => component.component?.custom_id?.startsWith("channels_"));
    expect(channels?.component?.value).toBe("#general, #lore");
  });

  it("builds field IDs with nonce suffix", () => {
    expect(buildServerMemoryModalFieldId("content", "abc")).toBe("content_abc");
    expect(buildServerMemoryModalFieldId("tags", "abc")).toBe("tags_abc");
    expect(buildServerMemoryModalFieldId("file", "abc")).toBe("file_abc");
  });

  it("parses and deduplicates tags up to 5 items", () => {
    expect(parseServerMemoryTags("lore, rules, #general, lore, event, extra, ignored")).toEqual([
      "lore",
      "rules",
      "#general",
      "event",
      "extra",
    ]);
    expect(parseServerMemoryTags("")).toEqual([]);
    expect(parseServerMemoryTags(" \"quoted\" , 'single' ")).toEqual(["quoted", "single"]);
  });

  it("builds edit modal with prefilled values", () => {
    const modal = buildEditServerMemoryModal("en-US", 1770, 42, "Existing content", ["tag1", "tag2"], "nonce123");
    expect(modal.title).toBe("Edit Server Memory");
    const contentField = modal.components.find((c) => c.component?.custom_id?.startsWith("content_"));
    expect(contentField?.component?.value).toBe("Existing content");
    const tagsField = modal.components.find((c) => c.component?.custom_id?.startsWith("tags_"));
    expect(tagsField?.component?.value).toBe("tag1, tag2");
  });
});

describe("memories permissions and scoping", () => {
  function createTestDependencies(overrides: Partial<MemoriesRouteDependencies> = {}) {
    const calls: string[] = [];
    const memories = [
      makeMemory(1, { user_id: 42, persona_lineage_id: 1770, content: "Memory 1" }),
      makeMemory(2, { user_id: 99, persona_lineage_id: 1770, content: "Memory 2" }),
    ];

    const dependencies: MemoriesRouteDependencies = {
      resolveScope: async (interaction) => {
        calls.push("resolveScope");
        const isManager = !interaction.guildId || (interaction.memberPermissions?.has("ManageGuild") ?? false);
        return {
          serverId: 1,
          workspaceId: "guild-123",
          guildId: "guild-123",
          userDiscId: interaction.user.id,
          userId: 42,
          canManage: isManager,
          isBlacklisted: false,
          memteachingEnabled: false,
          configuredEmbeddingModelId: null,
          personas: [makePersona(10, 1770, "Tomori"), makePersona(20, 1880, "Anon")],
          readStatus: "fresh",
        };
      },
      loadMemories: async (serverId, lineageId, userId) => {
        calls.push(`loadMemories:${serverId}:${lineageId}:${userId ?? "undefined"}`);
        if (userId !== undefined) {
          return memories.filter((m) => m.persona_lineage_id === lineageId && m.user_id === userId);
        }
        return memories.filter((m) => m.persona_lineage_id === lineageId);
      },
      getMemoryCountsByLineage: async (serverId, userId) => {
        calls.push(`getMemoryCountsByLineage:${serverId}:${userId ?? "undefined"}`);
        return new Map([
          [1770, userId === undefined ? 2 : 1],
          [1880, 4],
        ]);
      },
      getPersonaAvatarData: async (_interaction, persona) => {
        calls.push(`getPersonaAvatarData:${persona.persona_id}`);
        return { url: `https://cdn.example.invalid/${persona.persona_id}.png`, files: [] };
      },
      loadDocuments: async (serverId, personaId) => {
        calls.push(`loadDocuments:${serverId}:${personaId ?? "serverwide"}`);
        return [];
      },
      loadDocumentMeta: async (serverId, personaId, documentId) => {
        calls.push(`loadDocumentMeta:${serverId}:${personaId ?? "serverwide"}:${documentId}`);
        return null;
      },
      loadDocumentChunks: async (serverId, personaId, documentId) => {
        calls.push(`loadDocumentChunks:${serverId}:${personaId ?? "serverwide"}:${documentId}`);
        return [];
      },
      getDocumentCounts: async (serverId, personaId) => {
        calls.push(`getDocumentCounts:${serverId}:${personaId ?? "serverwide"}`);
        return { documents: 0, chunks: 0 };
      },
      getDocumentCountsByPersona: async () => ({ byPersona: new Map([[10, 3]]), serverwide: 1 }),
      getEligibleHistoryPersonaIds: async () => new Set(),
      getStmEntries: async (workspaceId) => {
        calls.push(`getStmEntries:${workspaceId}`);
        return [
          { channelId: "12345678901234567", personaId: 10, personaName: "Tomori", lastUpdated: 3 },
          { channelId: "12345678901234568", personaId: 10, personaName: "Tomori", lastUpdated: 2 },
          { channelId: "12345678901234569", personaId: null, personaName: "Unscoped", lastUpdated: 1 },
        ];
      },
      preWarmServerStm: async (workspaceId) => {
        calls.push(`preWarmServerStm:${workspaceId}`);
      },
      operations: serverMemoriesOperations,
      documentOperations: serverDocumentsOperations,
      recordAction: () => {
        calls.push("recordAction");
      },
      createNonce: () => "test-nonce",
      showAddModal: async () => {
        calls.push("showAddModal");
      },
      takeFileUpload: () => null,
      takeDocumentFileUpload: () => null,
      readUploadedText: async () => ({ isValid: true, text: "" }),
      showEditModal: async () => {
        calls.push("showEditModal");
      },
      showAddDocumentModal: async () => {
        calls.push("showAddDocumentModal");
      },
      showEditChunkModal: async () => {
        calls.push("showEditChunkModal");
      },
      showVectorizeModal: async () => {
        calls.push("showVectorizeModal");
      },
      showStmModal: async () => {
        calls.push("showStmModal");
      },
      takeCheckboxValues: () => [],
      clearStm: () => {
        calls.push("clearStm");
      },
      ...overrides,
    };

    return { dependencies, calls, memories };
  }

  it("passes actor userId as owner filter for non-managers and undefined for managers", async () => {
    // Non-manager interaction
    const nonManagerInteraction = {
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => false },
    } as unknown as ChatInputCommandInteraction;

    const { dependencies: depNonManager, calls: callsNonManager } = createTestDependencies();
    const panelNonManager = await buildInitialMemoriesPanel(nonManagerInteraction, "en-US", depNonManager);

    expect(callsNonManager).toContain("loadMemories:1:1770:42");
    expect(callsNonManager).toContain("getMemoryCountsByLineage:1:42");
    expect(panelNonManager.components.length).toBeGreaterThan(0);

    // Manager interaction
    const managerInteraction = {
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: (perm: string) => perm === "ManageGuild" },
    } as unknown as ChatInputCommandInteraction;

    const { dependencies: depManager, calls: callsManager } = createTestDependencies();
    const panelManager = await buildInitialMemoriesPanel(managerInteraction, "en-US", depManager);

    expect(callsManager).toContain("loadMemories:1:1770:undefined");
    expect(callsManager).toContain("getMemoryCountsByLineage:1:undefined");
    expect(panelManager.components.length).toBeGreaterThan(0);
  });

  it("gates STM active entry reads to managers only", async () => {
    const { dependencies, calls } = createTestDependencies();
    const route = createMemoriesInteractionRoute(dependencies);

    let editedReply: unknown = null;
    const nonManagerInteraction = {
      id: "int-stm-nonmanager",
      customId: "memories:v1:category:en-US:stm",
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => false },
      deferred: false,
      replied: false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async function (this: { deferred: boolean }) {
        this.deferred = true;
      },
      editReply: async (payload: unknown) => {
        editedReply = payload;
      },
    };

    await route.execute(
      {} as Client,
      nonManagerInteraction as unknown as StringSelectMenuInteraction,
      requireRoute(nonManagerInteraction.customId),
    );

    // Non-manager must NOT trigger getStmEntries or preWarmServerStm
    expect(calls.some((c) => c.startsWith("getStmEntries"))).toBe(false);
    expect(calls.some((c) => c.startsWith("preWarmServerStm"))).toBe(false);

    // Non-manager receives the explanatory notice
    const textDisplays = collectTextDisplays(editedReply);
    expect(textDisplays.some((t) => t.includes("You need Manage Server permission to view"))).toBe(true);

    // Now test manager in guild
    calls.length = 0;
    const managerInteraction = {
      id: "int-stm-manager",
      customId: "memories:v1:category:en-US:stm",
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: (perm: string) => perm === "ManageGuild" },
      deferred: false,
      replied: false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async function (this: { deferred: boolean }) {
        this.deferred = true;
      },
      editReply: async (payload: unknown) => {
        editedReply = payload;
      },
    };

    await route.execute(
      {} as Client,
      managerInteraction as unknown as StringSelectMenuInteraction,
      requireRoute(managerInteraction.customId),
    );

    expect(calls).toContain("preWarmServerStm:guild-123");
    expect(calls).toContain("getStmEntries:guild-123");
    const managerTextDisplays = collectTextDisplays(editedReply);
    expect(managerTextDisplays.some((t) => t.includes("3 active short-term memory entries."))).toBe(true);
  });

  it("blocks document reads when teaching is disabled and keeps persona and serverwide scopes distinct", async () => {
    const { dependencies, calls } = createTestDependencies();
    const route = createMemoriesInteractionRoute(dependencies);
    const interaction = {
      id: "int-documents",
      customId: "memories:v1:category:en-US:documents",
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => false },
      deferred: false,
      replied: false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async function (this: { deferred: boolean }) {
        this.deferred = true;
      },
      editReply: async () => {},
    };

    await route.execute(
      {} as Client,
      interaction as unknown as StringSelectMenuInteraction,
      requireRoute(interaction.customId),
    );
    expect(calls.some((call) => call.startsWith("loadDocuments"))).toBe(false);
    expect(calls.some((call) => call.startsWith("getDocumentCounts"))).toBe(false);

    calls.length = 0;
    interaction.memberPermissions.has = () => true;
    await route.execute(
      {} as Client,
      interaction as unknown as StringSelectMenuInteraction,
      requireRoute(interaction.customId),
    );
    // The category opens on the serverwide scope, never on whichever persona sorts first.
    expect(calls).toContain("loadDocuments:1:serverwide");
    expect(calls.some((call) => call.includes("1770"))).toBe(false);

    calls.length = 0;
    interaction.customId = "memories:v1:document-scope:en-US:10";
    await route.execute(
      {} as Client,
      interaction as unknown as StringSelectMenuInteraction,
      requireRoute(interaction.customId),
    );
    expect(calls).toContain("loadDocuments:1:10");
  });

  it("never clears server STM for a guild non-manager and clears only unchecked composite identities", async () => {
    const entries = [
      { channelId: "12345678901234567", personaId: 10, personaName: "Tomori", lastUpdated: 2 },
      { channelId: "12345678901234567", personaId: null, personaName: "Unscoped", lastUpdated: 1 },
    ];
    const fingerprint = computeServerStmFingerprint("guild-123", "user-42", entries);
    let clearCalls: Array<[string, string, number | null]> = [];
    const { dependencies } = createTestDependencies({
      getStmEntries: async () => entries,
      takeCheckboxValues: () => [
        buildMemoriesRouteId({
          action: "stm-entry",
          locale: "en-US",
          channelId: "12345678901234567",
          personaId: 10,
        }),
      ],
      clearStm: (workspaceId, channelId, personaId) => {
        clearCalls.push([workspaceId, channelId, personaId]);
      },
    });
    const route = createMemoriesInteractionRoute(dependencies);
    const interaction = {
      id: "int-stm-submit",
      customId: `memories:v1:stm-submit:en-US:${fingerprint}`,
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => false },
      deferred: false,
      replied: false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async function (this: { deferred: boolean }) {
        this.deferred = true;
      },
      editReply: async () => {},
    };

    await route.execute(
      {} as Client,
      interaction as unknown as ModalSubmitInteraction,
      requireRoute(interaction.customId),
    );
    expect(clearCalls).toEqual([]);

    clearCalls = [];
    interaction.memberPermissions.has = () => true;
    await route.execute(
      {} as Client,
      interaction as unknown as ModalSubmitInteraction,
      requireRoute(interaction.customId),
    );
    expect(clearCalls).toEqual([["guild-123", "12345678901234567", null]]);

    clearCalls = [];
    const driftRoute = createMemoriesInteractionRoute({
      ...dependencies,
      getStmEntries: async () => [
        ...entries,
        { channelId: "12345678901234568", personaId: 10, personaName: "Tomori", lastUpdated: 3 },
      ],
    });
    await driftRoute.execute(
      {} as Client,
      interaction as unknown as ModalSubmitInteraction,
      requireRoute(interaction.customId),
    );
    expect(clearCalls).toEqual([]);
  });

  it("deduplicates persona options by lineage without repeating option values", () => {
    const personas = [
      makePersona(1, 100, "Main Persona", false),
      makePersona(2, 100, "Alter Persona 1", true),
      makePersona(3, 100, "Alter Persona 2", true),
      makePersona(4, 200, "Second Persona", false),
    ];

    const payload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "memories",
      selectedLineageId: 100,
      personas,
      memories: [makeMemory(1, { persona_lineage_id: 100 })],
      canManage: true,
      readStatus: "fresh",
      page: { kind: "main" },
    });

    const selects = collectSelects(payload.components);
    const personaSelect = selects.find((s) => s.customId?.includes("persona-select"));
    expect(personaSelect).toBeDefined();

    const values = personaSelect?.options?.map((o) => o.value) ?? [];
    expect(values).toEqual(["100", "200"]);
    // Option label uses the representative (main persona)
    expect(personaSelect?.options?.[0]?.label).toBe("Main Persona");

    const components = (JSON.parse(JSON.stringify(payload)).components[0].components ?? []) as unknown[];
    const personaSelectorIndex = components.findIndex((component) =>
      JSON.stringify(component).includes(":persona-select:"),
    );
    const personaHeadingIndex = components.findIndex((component) =>
      JSON.stringify(component).includes("Server Memories"),
    );
    expect(personaSelectorIndex).toBeLessThan(personaHeadingIndex);
  });

  it("renders the shared pagination row for memory and document selectors", () => {
    const personas = [makePersona(1, 100, "Main Persona", false)];

    // 48 memories = 2 pages (page size 24) -> one pagination row.
    const smallMemories = Array.from({ length: 48 }, (_, i) =>
      makeMemory(i + 1, { persona_lineage_id: 100, content: `Memory ${i + 1}` }),
    );

    const smallPayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "memories",
      selectedLineageId: 100,
      personas,
      memories: smallMemories,
      canManage: true,
      readStatus: "fresh",
      page: { kind: "main" },
    });

    const smallButtons = collectButtons(smallPayload.components);
    const rangeButtons = smallButtons.filter(
      (button) => button.label === "← Previous" || button.label?.startsWith("Page ") || button.label === "Next →",
    );
    expect(rangeButtons.map((button) => button.label)).toEqual(["← Previous", "Page 1 of 2", "Next →"]);
    expect(rangeButtons.map((button) => button.disabled)).toEqual([true, true, false]);

    // 150 memories = 7 pages (page size 24) -> still one in-place pagination row.
    const largeMemories = Array.from({ length: 150 }, (_, i) =>
      makeMemory(i + 1, { persona_lineage_id: 100, content: `Memory ${i + 1}` }),
    );

    const largePayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "memories",
      selectedLineageId: 100,
      personas,
      memories: largeMemories,
      canManage: true,
      readStatus: "fresh",
      page: { kind: "main" },
    });

    const largeButtons = collectButtons(largePayload.components);
    expect(largeButtons.some((b) => b.customId?.includes(":range-open:"))).toBe(false);
    expect(largeButtons.some((b) => b.label === "Page 1 of 7")).toBe(true);

    const largeDocumentPayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "documents",
      selectedLineageId: 100,
      selectedDocumentPersonaId: 1,
      personas,
      memories: [],
      documents: Array.from({ length: 150 }, (_, index) => ({
        document_id: index + 1,
        document_name: `Document ${index + 1}`,
        first_chunk: null,
        isHistory: false,
      })),
      canManage: true,
      memteachingEnabled: true,
      readStatus: "fresh",
      page: { kind: "documents" },
    });
    const documentButtons = collectButtons(largeDocumentPayload.components);
    expect(documentButtons.some((button) => button.customId?.includes(":document-range-open:"))).toBe(false);
    expect(documentButtons.some((button) => button.label === "Page 1 of 7")).toBe(true);
    const documentComponents = (JSON.parse(JSON.stringify(largeDocumentPayload)).components[0].components ??
      []) as unknown[];
    const documentPersonaSelectorIndex = documentComponents.findIndex((component) =>
      JSON.stringify(component).includes(":document-persona-select:"),
    );
    const documentsHeadingIndex = documentComponents.findIndex((component) =>
      JSON.stringify(component).includes("### [Documents]"),
    );
    expect(documentPersonaSelectorIndex).toBeLessThan(documentsHeadingIndex);

    const documentSecondPagePayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "documents",
      selectedLineageId: 100,
      selectedDocumentPersonaId: 1,
      personas,
      memories: [],
      documents: Array.from({ length: 150 }, (_, index) => ({
        document_id: index + 1,
        document_name: `Document ${index + 1}`,
        first_chunk: null,
        isHistory: false,
      })),
      canManage: true,
      memteachingEnabled: true,
      readStatus: "fresh",
      page: { kind: "documents", rangeIndex: 1 },
    });
    expect(collectButtons(documentSecondPagePayload.components)).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Page 2 of 7", disabled: true })]),
    );
  });

  it("disables every server pagination button while stale and keeps fresh forward navigation usable", () => {
    const personas = Array.from({ length: 30 }, (_, index) =>
      makePersona(index + 1, 100 + index, `Persona ${index + 1}`),
    );
    const memories = Array.from({ length: 50 }, (_, index) =>
      makeMemory(index + 1, { persona_lineage_id: 100, content: `Memory ${index + 1}` }),
    );
    const documents = Array.from({ length: 50 }, (_, index) => ({
      document_id: index + 1,
      document_name: `Document ${index + 1}`,
      first_chunk: null,
      isHistory: false,
    }));
    const isPaginationButton = (button: { label?: string }) =>
      button.label === "← Previous" || button.label === "Next →" || button.label?.startsWith("Page ") === true;

    const staleMemoriesPayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "memories",
      selectedLineageId: 100,
      personas,
      memories,
      canManage: true,
      readStatus: "stale",
      page: { kind: "main" },
    });
    const staleMemoryButtons = collectButtons(staleMemoriesPayload.components).filter(isPaginationButton);
    expect(staleMemoryButtons).toHaveLength(6);
    expect(staleMemoryButtons.every((button) => button.disabled === true)).toBe(true);

    const freshMemoriesPayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "memories",
      selectedLineageId: 100,
      personas,
      memories,
      canManage: true,
      readStatus: "fresh",
      page: { kind: "main" },
    });
    const freshMemoryNextButtons = collectButtons(freshMemoriesPayload.components).filter(
      (button) => button.label === "Next →",
    );
    expect(freshMemoryNextButtons).toHaveLength(2);
    expect(freshMemoryNextButtons.every((button) => button.disabled === false)).toBe(true);

    const staleDocumentsPayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "documents",
      selectedLineageId: 100,
      selectedDocumentPersonaId: 1,
      personas,
      memories: [],
      documents,
      canManage: true,
      memteachingEnabled: true,
      readStatus: "stale",
      page: { kind: "documents" },
    });
    const staleDocumentButtons = collectButtons(staleDocumentsPayload.components).filter(isPaginationButton);
    expect(staleDocumentButtons).toHaveLength(6);
    expect(staleDocumentButtons.every((button) => button.disabled === true)).toBe(true);

    const freshDocumentsPayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "documents",
      selectedLineageId: 100,
      selectedDocumentPersonaId: 1,
      personas,
      memories: [],
      documents,
      canManage: true,
      memteachingEnabled: true,
      readStatus: "fresh",
      page: { kind: "documents" },
    });
    const freshDocumentNextButtons = collectButtons(freshDocumentsPayload.components).filter(
      (button) => button.label === "Next →",
    );
    expect(freshDocumentNextButtons).toHaveLength(2);
    expect(freshDocumentNextButtons.every((button) => button.disabled === false)).toBe(true);
  });

  it("clamps a stale memory page after deletion instead of rendering an empty slice", () => {
    const payload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "memories",
      selectedLineageId: 100,
      personas: [makePersona(1, 100, "Main Persona")],
      memories: Array.from({ length: 25 }, (_, index) =>
        makeMemory(index + 1, { persona_lineage_id: 100, content: `Memory ${index + 1}` }),
      ),
      canManage: true,
      readStatus: "fresh",
      page: { kind: "main", rangeIndex: 3 },
    });
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain("Page 2 of 2");
    expect(serialized).toContain("Memory 25");
    expect(serialized).not.toContain("No server memories taught for this persona yet.");
  });

  it("keeps the final server-memory page populated after the confirmed deletion", async () => {
    const memories = Array.from({ length: 49 }, (_, index) =>
      makeMemory(index + 1, { persona_lineage_id: 1770, content: `Memory ${index + 1}` }),
    );
    const { dependencies } = createTestDependencies({
      loadMemories: async () => memories,
      operations: {
        ...serverMemoriesOperations,
        remove: async ({ memoryId }) => {
          const index = memories.findIndex((memory) => memory.server_memory_id === memoryId);
          const row = index >= 0 ? memories.splice(index, 1)[0] : undefined;
          return row ? { status: "success" as const, row } : { status: "not-found" as const };
        },
      },
    });
    const route = createMemoriesInteractionRoute(dependencies);
    let payload: unknown;
    let deferred = false;
    const interaction = {
      id: "remove-last-memory",
      customId: "memories:v1:remove-confirm:en-US:1770:49",
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => true },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async (value: unknown) => {
        payload = value;
      },
    };

    await route.execute({} as Client, interaction as never, requireRoute(interaction.customId));

    expect(deferred).toBe(true);
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Page 2 of 2");
    expect(serialized).toContain("Memory 48");
    const memorySelect = collectSelects(payload).find((select) => select.customId?.includes(":select:"));
    expect(memorySelect?.options?.some((option) => option.label === "Memory 49")).toBe(false);
    expect(serialized).not.toContain("No server memories taught for this persona yet.");
  });

  it("keeps the final document page populated after the confirmed deletion", async () => {
    const documents = Array.from({ length: 49 }, (_, index) => ({
      document_id: index + 1,
      document_name: `Document ${index + 1}`,
      first_chunk: null,
      isHistory: false,
    }));
    const { dependencies } = createTestDependencies({
      loadDocuments: async () => documents,
      getDocumentCounts: async () => ({ documents: documents.length, chunks: 0 }),
      documentOperations: {
        ...serverDocumentsOperations,
        remove: async ({ documentId }) => {
          const index = documents.findIndex((document) => document.document_id === documentId);
          const row = index >= 0 ? documents.splice(index, 1)[0] : undefined;
          return row
            ? { status: "success" as const, documentName: row.document_name }
            : { status: "not-found" as const };
        },
      },
    });
    const route = createMemoriesInteractionRoute(dependencies);
    let payload: unknown;
    let deferred = false;
    const interaction = {
      id: "remove-last-document",
      customId: "memories:v1:document-remove-confirm:en-US:10:49",
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => true },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async (value: unknown) => {
        payload = value;
      },
    };

    await route.execute({} as Client, interaction as never, requireRoute(interaction.customId));

    expect(deferred).toBe(true);
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Page 2 of 2");
    expect(serialized).toContain("Document 48");
    const documentSelect = collectSelects(payload).find((select) => select.customId?.includes(":document-select:"));
    expect(documentSelect?.options?.some((option) => option.label === "Document 49")).toBe(false);
  });

  it("routes memory, document, and persona page actions to their live slices", async () => {
    const manyMemories = Array.from({ length: 50 }, (_, index) =>
      makeMemory(index + 1, { persona_lineage_id: 1770, content: `Memory ${index + 1}` }),
    );
    const manyPersonas = Array.from({ length: 30 }, (_, index) =>
      makePersona(index + 1, 1770 + index, `Persona ${index + 1}`),
    );
    const documents = Array.from({ length: 50 }, (_, index) => ({
      document_id: index + 1,
      document_name: `Document ${index + 1}`,
      first_chunk: null,
      isHistory: false,
    }));
    const { dependencies } = createTestDependencies({
      resolveScope: async () => ({
        serverId: 1,
        workspaceId: "guild-123",
        guildId: "guild-123",
        userDiscId: "user-42",
        userId: 42,
        canManage: true,
        isBlacklisted: false,
        memteachingEnabled: true,
        configuredEmbeddingModelId: null,
        personas: manyPersonas,
        readStatus: "fresh",
      }),
      loadMemories: async () => manyMemories,
      loadDocuments: async () => documents,
      getDocumentCounts: async () => ({ documents: documents.length, chunks: 0 }),
      getDocumentCountsByPersona: async () => ({ byPersona: new Map(), serverwide: 0 }),
    });
    const route = createMemoriesInteractionRoute(dependencies);
    const scenarios = [
      {
        customId: "memories:v1:range:en-US:1770:1",
        expected: ["Memory 25", "Page 2 of 3"],
      },
      {
        customId: "memories:v1:document-range:en-US:0:1",
        expected: ["Document 25", "Page 2 of 3"],
      },
      {
        customId: "memories:v1:persona-page:en-US:1770:1",
        expected: ["Persona 26", "Page 2 of 2"],
      },
      {
        customId: "memories:v1:document-persona-page:en-US:1:1",
        expected: ["Persona 26", "Page 2 of 2"],
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      let payload: unknown;
      let deferred = false;
      const interaction = {
        id: `page-${index}`,
        customId: scenario.customId,
        user: { id: "user-42", username: "user42" },
        guildId: "guild-123",
        memberPermissions: { has: () => true },
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        deferUpdate: async () => {
          deferred = true;
        },
        editReply: async (value: unknown) => {
          payload = value;
        },
      };

      await route.execute({} as Client, interaction as never, requireRoute(scenario.customId));

      expect(deferred).toBe(true);
      const serialized = JSON.stringify(payload);
      for (const expected of scenario.expected) expect(serialized).toContain(expected);
    }
  });

  it("renders document scope as a state-control row across serverwide, persona, and no-persona states", () => {
    const personas = [makePersona(10, 100, "Tomori"), makePersona(20, 200, "Anon")];

    // Serverwide scope selected (selectedDocumentPersonaId: 0)
    const serverwidePayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "documents",
      selectedLineageId: 100,
      selectedDocumentPersonaId: 0,
      personas,
      memories: [],
      documents: [],
      canManage: true,
      memteachingEnabled: true,
      readStatus: "fresh",
      page: { kind: "documents" },
    });

    const serverwideButtons = collectButtons(serverwidePayload.components).filter((b) =>
      b.customId?.includes(":document-scope:"),
    );
    expect(serverwideButtons).toHaveLength(2);
    const [swBtn1, personaBtn1] = serverwideButtons;

    expect(swBtn1.customId).toBe("memories:v1:document-scope:en-US:0");
    expect(swBtn1.label).toBe("Serverwide Scope");
    expect(swBtn1.style).toBe(ButtonStyle.Primary);
    expect(swBtn1.disabled).toBe(true);

    expect(personaBtn1.customId).toBe("memories:v1:document-scope:en-US:10");
    expect(personaBtn1.label).toBe("Persona Scope");
    expect(personaBtn1.style).toBe(ButtonStyle.Secondary);
    expect(personaBtn1.disabled).toBe(false);

    // Persona scope selected (selectedDocumentPersonaId: 10)
    const personaPayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "documents",
      selectedLineageId: 100,
      selectedDocumentPersonaId: 10,
      personas,
      memories: [],
      documents: [],
      canManage: true,
      memteachingEnabled: true,
      readStatus: "fresh",
      page: { kind: "documents" },
    });

    const personaButtons = collectButtons(personaPayload.components).filter((b) =>
      b.customId?.includes(":document-scope:"),
    );
    expect(personaButtons).toHaveLength(2);
    const [swBtn2, personaBtn2] = personaButtons;

    expect(swBtn2.style).toBe(ButtonStyle.Secondary);
    expect(swBtn2.disabled).toBe(false);

    expect(personaBtn2.style).toBe(ButtonStyle.Primary);
    expect(personaBtn2.disabled).toBe(true);

    // No persona carries a persona_id (firstPersonaId resolves to 0), so Persona choice is an unavailable alternative
    const noPersonaPayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "documents",
      selectedLineageId: 0,
      selectedDocumentPersonaId: 0,
      personas: [{ persona_id: 0, persona_lineage_id: 0, persona_nickname: "None" } as unknown as TomoriState],
      memories: [],
      documents: [],
      canManage: true,
      memteachingEnabled: true,
      readStatus: "fresh",
      page: { kind: "documents" },
    });

    const noPersonaButtons = collectButtons(noPersonaPayload.components).filter((b) =>
      b.customId?.includes(":document-scope:"),
    );
    expect(noPersonaButtons).toHaveLength(2);
    const [swBtn3, personaBtn3] = noPersonaButtons;

    expect(swBtn3.style).toBe(ButtonStyle.Primary);
    expect(swBtn3.disabled).toBe(true);

    expect(personaBtn3.style).toBe(ButtonStyle.Secondary);
    expect(personaBtn3.disabled).toBe(true);

    // Writes disabled (readStatus === "stale")
    const stalePayload = buildMemoriesPanelPayload({
      locale: "en-US",
      category: "documents",
      selectedLineageId: 100,
      selectedDocumentPersonaId: 0,
      personas,
      memories: [],
      documents: [],
      canManage: true,
      memteachingEnabled: true,
      readStatus: "stale",
      page: { kind: "documents" },
    });

    const staleButtons = collectButtons(stalePayload.components).filter((b) =>
      b.customId?.includes(":document-scope:"),
    );
    expect(staleButtons).toHaveLength(2);
    const [swBtn4, personaBtn4] = staleButtons;

    expect(swBtn4.style).toBe(ButtonStyle.Primary);
    expect(swBtn4.disabled).toBe(true);

    expect(personaBtn4.style).toBe(ButtonStyle.Secondary);
    expect(personaBtn4.disabled).toBe(true);
  });

  it("acknowledges via deferUpdate before executing write operations", async () => {
    let acknowledgedDuringWrite = false;
    let writeInvoked = false;
    let deferred = false;
    let replied = false;

    const fakeInteraction = {
      id: "int-add-order",
      customId: "memories:v1:add-submit:en-US:1770:nonce123",
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => true },
      get deferred() {
        return deferred;
      },
      get replied() {
        return replied;
      },
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {
        replied = true;
      },
      fields: {
        getTextInputValue: (id: string) => (id.startsWith("content_") ? "Test memory" : ""),
      },
    };

    const { dependencies } = createTestDependencies({
      operations: {
        ...serverMemoriesOperations,
        add: async (input) => {
          writeInvoked = true;
          acknowledgedDuringWrite = fakeInteraction.deferred || fakeInteraction.replied;
          return { status: "success", row: makeMemory(1, { content: input.content }) };
        },
      },
    });

    const route = createMemoriesInteractionRoute(dependencies);
    await route.execute(
      {} as Client,
      fakeInteraction as unknown as StringSelectMenuInteraction,
      requireRoute(fakeInteraction.customId),
    );

    expect(writeInvoked).toBe(true);
    expect(acknowledgedDuringWrite).toBe(true);
  });

  it("acknowledges every document and vectorize write before the operation starts", async () => {
    const acknowledged: boolean[] = [];
    let activeInteraction: { deferred: boolean; replied: boolean } | null = null;
    const { dependencies } = createTestDependencies({
      documentOperations: {
        ...serverDocumentsOperations,
        add: async () => {
          acknowledged.push(Boolean(activeInteraction?.deferred || activeInteraction?.replied));
          return { status: "success" as const, documentId: 77, documentName: "Guide", chunkCount: 1 };
        },
        remove: async () => {
          acknowledged.push(Boolean(activeInteraction?.deferred || activeInteraction?.replied));
          return { status: "success" as const, documentName: "Guide" };
        },
        editChunk: async () => {
          acknowledged.push(Boolean(activeInteraction?.deferred || activeInteraction?.replied));
          return { status: "success" as const };
        },
        removeChunk: async () => {
          acknowledged.push(Boolean(activeInteraction?.deferred || activeInteraction?.replied));
          return { status: "success" as const, removedDocument: false };
        },
        vectorize: async () => {
          acknowledged.push(Boolean(activeInteraction?.deferred || activeInteraction?.replied));
          return { status: "success" as const, documentId: 78, documentName: "Memory Guide", chunkCount: 1 };
        },
      },
    });
    const route = createMemoriesInteractionRoute(dependencies);
    const customIds = [
      "memories:v1:document-add-submit:en-US:10:nonce123",
      "memories:v1:document-remove-confirm:en-US:10:77",
      "memories:v1:document-chunk-edit-submit:en-US:10:77:0:nonce123",
      "memories:v1:document-chunk-remove-confirm:en-US:10:77:0",
      "memories:v1:vectorize-submit:en-US:1770:10:1:nonce123",
    ];
    for (const customId of customIds) {
      const interaction = {
        id: `int-${acknowledged.length}`,
        customId,
        user: { id: "user-42", username: "user42" },
        guildId: "guild-123",
        memberPermissions: { has: () => true },
        deferred: false,
        replied: false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        deferUpdate: async function (this: { deferred: boolean }) {
          this.deferred = true;
        },
        editReply: async function (this: { replied: boolean }) {
          this.replied = true;
        },
        fields: {
          getTextInputValue: (fieldId: string) =>
            fieldId.startsWith("name_") ? "Guide" : fieldId.startsWith("content_") ? "Updated content" : "",
        },
      };
      activeInteraction = interaction;
      await route.execute({} as Client, interaction as unknown as ModalSubmitInteraction, requireRoute(customId));
    }
    expect(acknowledged).toEqual([true, true, true, true, true]);
  });

  it("opens add modal without deferUpdate on select action:add", async () => {
    let modalShown = false;
    let deferred = false;

    const fakeInteraction = {
      id: "int-select-add",
      customId: "memories:v1:select:en-US:1770",
      values: ["action:add"],
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => true },
      get deferred() {
        return deferred;
      },
      isButton: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      deferUpdate: async () => {
        deferred = true;
      },
    };

    const { dependencies } = createTestDependencies({
      showAddModal: async () => {
        modalShown = true;
      },
    });

    const route = createMemoriesInteractionRoute(dependencies);
    await route.execute(
      {} as Client,
      fakeInteraction as unknown as StringSelectMenuInteraction,
      requireRoute(fakeInteraction.customId),
    );

    expect(modalShown).toBe(true);
    expect(deferred).toBe(false);
  });

  it("opens edit modal without deferUpdate on edit-open button", async () => {
    let modalShown = false;
    let deferred = false;

    const fakeInteraction = {
      id: "int-edit-open",
      customId: "memories:v1:edit-open:en-US:1770:1",
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => true },
      get deferred() {
        return deferred;
      },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => {
        deferred = true;
      },
    };

    const { dependencies } = createTestDependencies({
      showEditModal: async () => {
        modalShown = true;
      },
    });

    const route = createMemoriesInteractionRoute(dependencies);
    await route.execute(
      {} as Client,
      fakeInteraction as unknown as StringSelectMenuInteraction,
      requireRoute(fakeInteraction.customId),
    );

    expect(modalShown).toBe(true);
    expect(deferred).toBe(false);
  });

  it("loads document metadata through the route before opening the chunk editor", async () => {
    let modalTags: string[] | null = null;
    const fakeInteraction = {
      id: "int-document-edit-open",
      customId: "memories:v1:document-chunk-edit-open:en-US:10:77:0",
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => true },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      reply: async () => {},
    };
    const { dependencies } = createTestDependencies({
      loadDocumentMeta: async () => ({ document_name: "Guide", channel_tags: ["#general"] }),
      loadDocumentChunks: async () => [{ document_chunk_id: 8, chunk_index: 0, content: "Stored chunk" }],
      showEditChunkModal: async (_interaction, _locale, _personaId, _documentId, _chunk, channelTags) => {
        modalTags = channelTags;
      },
    });

    await createMemoriesInteractionRoute(dependencies).execute(
      {} as Client,
      fakeInteraction as unknown as StringSelectMenuInteraction,
      requireRoute(fakeInteraction.customId),
    );

    expect(modalTags).toEqual(["#general"]);
  });

  it("keeps the chunk removal prompt on its own document and addresses chunks by chunk_index", async () => {
    let editedReply: unknown = null;
    const documents = [
      { document_id: 70, document_name: "Alpha", first_chunk: "alpha text", isHistory: false },
      { document_id: 77, document_name: "Beta", first_chunk: "beta text", isHistory: false },
    ];
    // chunk_index 1 is absent: deleteChunk never renumbers, so a real document develops gaps.
    const chunks = [
      { document_chunk_id: 801, chunk_index: 0, content: "Beta chunk zero" },
      { document_chunk_id: 802, chunk_index: 2, content: "Beta chunk two" },
      { document_chunk_id: 803, chunk_index: 5, content: "Beta chunk five" },
    ];
    const { dependencies } = createTestDependencies({
      loadDocuments: async () => documents,
      loadDocumentChunks: async (_serverId, _personaId, documentId) => (documentId === 77 ? chunks : []),
      getDocumentCounts: async () => ({ documents: 2, chunks: 3 }),
      getEligibleDocumentPersonaIds: async () => new Set([10]),
    });
    const interaction = {
      id: "int-chunk-remove-prompt",
      customId: "memories:v1:document-chunk-remove-prompt:en-US:10:77:2",
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => true },
      deferred: false,
      replied: false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async function (this: { deferred: boolean }) {
        this.deferred = true;
      },
      editReply: async (payload: unknown) => {
        editedReply = payload;
      },
    };

    await createMemoriesInteractionRoute(dependencies).execute(
      {} as Client,
      interaction as unknown as StringSelectMenuInteraction,
      requireRoute(interaction.customId),
    );

    const texts = collectTextDisplays(editedReply);
    expect(texts.some((text) => text.includes("Beta"))).toBe(true);
    expect(texts.some((text) => text.includes("Beta chunk two"))).toBe(true);
    expect(texts.some((text) => text.includes("Beta chunk five"))).toBe(false);
    expect(texts.some((text) => text.includes("Alpha"))).toBe(false);

    const buttons = collectButtons(editedReply);
    expect(buttons.map((button) => button.customId)).toContain(
      "memories:v1:document-chunk-remove-confirm:en-US:10:77:2",
    );
    // Navigation steps to a neighbouring stored index, never to chunk_index 1 or 3, which are absent.
    expect(buttons.map((button) => button.customId)).toContain("memories:v1:document-chunk-prev:en-US:10:77:0");
    expect(buttons.map((button) => button.customId)).toContain("memories:v1:document-chunk-next:en-US:10:77:5");
  });

  it("shows real per-lineage counts and tells a non-manager their view is scoped", async () => {
    let managerReply: unknown = null;
    let memberReply: unknown = null;
    const { dependencies } = createTestDependencies();
    const route = createMemoriesInteractionRoute(dependencies);

    function interactionFor(isManager: boolean, sink: (payload: unknown) => void) {
      return {
        id: `int-counts-${isManager}`,
        customId: "memories:v1:category:en-US:memories",
        user: { id: "user-42", username: "user42" },
        guildId: "guild-123",
        memberPermissions: { has: () => isManager },
        deferred: false,
        replied: false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        deferUpdate: async function (this: { deferred: boolean }) {
          this.deferred = true;
        },
        editReply: async (payload: unknown) => sink(payload),
      };
    }

    await route.execute(
      {} as Client,
      interactionFor(true, (p) => {
        managerReply = p;
      }) as unknown as StringSelectMenuInteraction,
      requireRoute("memories:v1:category:en-US:memories"),
    );
    await route.execute(
      {} as Client,
      interactionFor(false, (p) => {
        memberReply = p;
      }) as unknown as StringSelectMenuInteraction,
      requireRoute("memories:v1:category:en-US:memories"),
    );

    // The unselected lineage carries a real count from the repository, never a fabricated 1.
    const managerOptions = collectSelects(managerReply).flatMap((select) => select.options ?? []);
    const unselected = managerOptions.find((option) => option.value === "1880");
    expect(unselected?.description).toContain("4");
    expect(unselected?.description).not.toContain("1 ");

    const managerTexts = collectTextDisplays(managerReply);
    expect(managerTexts.some((text) => text.includes("only the memories you taught"))).toBe(false);

    const memberTexts = collectTextDisplays(memberReply);
    expect(memberTexts.some((text) => text.includes("only the memories you taught"))).toBe(true);
  });

  /**
   * A refusal used to arrive as a second ephemeral message, which reads as an unrelated error
   * rather than as this panel's answer. Ordering is the subtle half: these branches sit above
   * `beginPanelInteraction` precisely because they may open a modal, so a refusal has to
   * acknowledge for itself.
   */
  it("answers a refused modal branch by repainting the panel, never by a separate reply", async () => {
    const { dependencies } = createTestDependencies({
      resolveScope: async (interaction) => ({
        serverId: 1,
        workspaceId: "guild-123",
        guildId: "guild-123",
        userDiscId: interaction.user.id,
        userId: 42,
        canManage: false,
        isBlacklisted: false,
        memteachingEnabled: false,
        configuredEmbeddingModelId: null,
        personas: [makePersona(10, 1770, "Tomori")],
        readStatus: "fresh",
      }),
    });
    const route = createMemoriesInteractionRoute(dependencies);

    for (const [customId, isSelect] of [
      ["memories:v1:select:en-US:1770", true],
      ["memories:v1:document-select:en-US:0", true],
      ["memories:v1:stm-open:en-US", false],
    ] as const) {
      let edited: unknown = null;
      let replied = false;
      const interaction = {
        id: `int-refusal-${customId}`,
        customId,
        values: isSelect ? [customId.includes("document") ? "action:add-document" : "action:add"] : undefined,
        user: { id: "user-42", username: "user42" },
        guildId: "guild-123",
        memberPermissions: { has: () => false },
        deferred: false,
        replied: false,
        isButton: () => !isSelect,
        isStringSelectMenu: () => isSelect,
        isModalSubmit: () => false,
        deferUpdate: async function (this: { deferred: boolean }) {
          this.deferred = true;
        },
        reply: async () => {
          replied = true;
        },
        editReply: async (payload: unknown) => {
          edited = payload;
        },
      };

      await route.execute({} as Client, interaction as unknown as StringSelectMenuInteraction, requireRoute(customId));

      expect(replied).toBe(false);
      expect(interaction.deferred).toBe(true);
      expect(collectTextDisplays(edited).length).toBeGreaterThan(0);
    }
  });

  it("refuses modal opening and writes when user is blacklisted and not manager", async () => {
    let addRepositoryCalled = false;
    const addSpy = spyOn(serverMemoryRepository, "add").mockImplementation(async () => {
      addRepositoryCalled = true;
      return null;
    });

    try {
      const { dependencies } = createTestDependencies({
        resolveScope: async () => ({
          serverId: 1,
          workspaceId: "guild-123",
          guildId: "guild-123",
          userDiscId: "user-blacklisted",
          userId: 42,
          canManage: false,
          isBlacklisted: true,
          memteachingEnabled: true,
          personas: [makePersona(10, 1770, "Tomori")],
          readStatus: "fresh",
        }),
      });

      let refusalPayload: unknown = null;
      const selectAddInteraction = {
        id: "int-add-blacklisted",
        customId: "memories:v1:select:en-US:1770",
        values: ["action:add"],
        user: { id: "user-blacklisted", username: "badactor" },
        guildId: "guild-123",
        memberPermissions: { has: () => false },
        deferred: false,
        replied: false,
        isButton: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        deferUpdate: async function (this: { deferred: boolean }) {
          this.deferred = true;
        },
        editReply: async (payload: unknown) => {
          refusalPayload = payload;
        },
      };

      const route = createMemoriesInteractionRoute(dependencies);
      await route.execute(
        {} as Client,
        selectAddInteraction as unknown as StringSelectMenuInteraction,
        requireRoute(selectAddInteraction.customId),
      );

      // The refusal repaints the panel with a receipt rather than posting a stray ephemeral reply.
      expect(selectAddInteraction.deferred).toBe(true);
      expect(collectTextDisplays(refusalPayload).join(" ")).toContain("blacklisted");
      expect(addRepositoryCalled).toBe(false);

      // Verify add-submit also refuses write
      let editReplyPayload: unknown = null;
      const addSubmitInteraction = {
        id: "int-add-submit-blacklisted",
        customId: "memories:v1:add-submit:en-US:1770:nonce123",
        user: { id: "user-blacklisted", username: "badactor" },
        guildId: "guild-123",
        memberPermissions: { has: () => false },
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyPayload = payload;
        },
        fields: {
          getTextInputValue: (id: string) => (id.startsWith("content_") ? "Injected memory" : ""),
        },
      };

      await route.execute(
        {} as Client,
        addSubmitInteraction as unknown as ModalSubmitInteraction,
        requireRoute(addSubmitInteraction.customId),
      );

      expect(addRepositoryCalled).toBe(false);
      const text = collectTextDisplays(editReplyPayload);
      expect(text.some((t) => t.includes("blacklisted"))).toBe(true);
    } finally {
      addSpy.mockRestore();
    }
  });

  it("refuses writes when server_memteaching_enabled is false and user is not manager", async () => {
    let addRepositoryCalled = false;
    const addSpy = spyOn(serverMemoryRepository, "add").mockImplementation(async () => {
      addRepositoryCalled = true;
      return null;
    });

    try {
      const { dependencies } = createTestDependencies({
        resolveScope: async () => ({
          serverId: 1,
          workspaceId: "guild-123",
          guildId: "guild-123",
          userDiscId: "user-normal",
          userId: 42,
          canManage: false,
          isBlacklisted: false,
          memteachingEnabled: false,
          personas: [makePersona(10, 1770, "Tomori")],
          readStatus: "fresh",
        }),
      });

      let editReplyPayload: unknown = null;
      const addSubmitInteraction = {
        id: "int-add-submit-disabled",
        customId: "memories:v1:add-submit:en-US:1770:nonce123",
        user: { id: "user-normal", username: "normaluser" },
        guildId: "guild-123",
        memberPermissions: { has: () => false },
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyPayload = payload;
        },
        fields: {
          getTextInputValue: (id: string) => (id.startsWith("content_") ? "Injected memory" : ""),
        },
      };

      const route = createMemoriesInteractionRoute(dependencies);
      await route.execute(
        {} as Client,
        addSubmitInteraction as unknown as ModalSubmitInteraction,
        requireRoute(addSubmitInteraction.customId),
      );

      expect(addRepositoryCalled).toBe(false);
      const text = collectTextDisplays(editReplyPayload);
      expect(text.some((t) => t.includes("Member memory teaching is disabled"))).toBe(true);
    } finally {
      addSpy.mockRestore();
    }
  });

  it("allows writes when user is manager regardless of teaching flag", async () => {
    let addRepositoryCalled = false;
    const addSpy = spyOn(serverMemoryRepository, "add").mockImplementation(async () => {
      addRepositoryCalled = true;
      return makeMemory(100, { content: "Manager memory" });
    });
    const checkSpy = spyOn(serverMemoryRepository, "checkServerMemoryLimit").mockImplementation(async () => ({
      isValid: true,
      currentCount: 0,
      maxAllowed: 100,
    }));

    try {
      const { dependencies } = createTestDependencies({
        resolveScope: async () => ({
          serverId: 1,
          workspaceId: "guild-123",
          guildId: "guild-123",
          userDiscId: "user-manager",
          userId: 42,
          canManage: true,
          isBlacklisted: false,
          memteachingEnabled: false,
          personas: [makePersona(10, 1770, "Tomori")],
          readStatus: "fresh",
        }),
      });

      const addSubmitInteraction = {
        id: "int-add-submit-mgr",
        customId: "memories:v1:add-submit:en-US:1770:nonce123",
        user: { id: "user-manager", username: "manager" },
        guildId: "guild-123",
        memberPermissions: { has: () => true },
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        deferUpdate: async () => {},
        editReply: async () => {},
        fields: {
          getTextInputValue: (id: string) => (id.startsWith("content_") ? "Manager memory" : ""),
        },
      };

      const route = createMemoriesInteractionRoute(dependencies);
      await route.execute(
        {} as Client,
        addSubmitInteraction as unknown as ModalSubmitInteraction,
        requireRoute(addSubmitInteraction.customId),
      );

      expect(addRepositoryCalled).toBe(true);
    } finally {
      addSpy.mockRestore();
      checkSpy.mockRestore();
    }
  });

  it("refuses edit or remove when target memory is outside freshly loaded scoped set", async () => {
    let editCalled = false;
    let removeCalled = false;
    const editSpy = spyOn(serverMemoryRepository, "edit").mockImplementation(async () => {
      editCalled = true;
      return true;
    });
    const removeSpy = spyOn(serverMemoryRepository, "remove").mockImplementation(async () => {
      removeCalled = true;
      return true;
    });

    try {
      const { dependencies } = createTestDependencies();
      const route = createMemoriesInteractionRoute(dependencies);

      // Memory ID 999 does not exist in dependencies.memories
      let editReplyPayload: unknown = null;
      const editSubmitInteraction = {
        id: "int-edit-stale",
        customId: "memories:v1:edit-submit:en-US:1770:999:nonce123",
        user: { id: "user-42", username: "user42" },
        guildId: "guild-123",
        memberPermissions: { has: () => true },
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyPayload = payload;
        },
        fields: {
          getTextInputValue: (id: string) => (id.startsWith("content_") ? "Updated content" : ""),
        },
      };

      await route.execute(
        {} as Client,
        editSubmitInteraction as unknown as ModalSubmitInteraction,
        requireRoute(editSubmitInteraction.customId),
      );

      expect(editCalled).toBe(false);
      const text = collectTextDisplays(editReplyPayload);
      expect(text.some((t) => t.includes("State Changed") || t.includes("no longer available"))).toBe(true);

      let removeReplyPayload: unknown = null;
      const removeConfirmInteraction = {
        id: "int-remove-stale",
        customId: "memories:v1:remove-confirm:en-US:1770:999",
        user: { id: "user-42", username: "user42" },
        guildId: "guild-123",
        memberPermissions: { has: () => true },
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          removeReplyPayload = payload;
        },
      };

      await route.execute(
        {} as Client,
        removeConfirmInteraction as unknown as StringSelectMenuInteraction,
        requireRoute(removeConfirmInteraction.customId),
      );

      expect(removeCalled).toBe(false);
      const removeText = collectTextDisplays(removeReplyPayload);
      expect(removeText.some((t) => t.includes("State Changed") || t.includes("no longer available"))).toBe(true);
    } finally {
      editSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it("processes batch file upload with deduplication and slot check", async () => {
    let addBatchCalled = false;
    let insertedLines: string[] = [];
    const addBatchSpy = spyOn(serverMemoryRepository, "addBatch").mockImplementation(
      async (_srv, _p, _l, _u, contents) => {
        addBatchCalled = true;
        insertedLines = contents;
        return true;
      },
    );
    const existingSpy = spyOn(serverMemoryRepository, "loadServerMemoryContents").mockImplementation(async () => [
      "Already existing line",
    ]);
    const limitSpy = spyOn(serverMemoryRepository, "checkServerMemoryLimit").mockImplementation(async () => ({
      isValid: true,
      currentCount: 1,
      maxAllowed: 100,
    }));

    try {
      const { dependencies } = createTestDependencies({
        takeFileUpload: () => ({ id: "att-1", url: "https://example.invalid/batch.txt" }) as never,
        readUploadedText: async () => ({
          isValid: true,
          text: "Already existing line\nNew memory line A\nNew memory line B\nNew memory line A",
        }),
      });

      let editReplyPayload: unknown = null;
      const addSubmitInteraction = {
        id: "int-add-batch",
        customId: "memories:v1:add-submit:en-US:1770:nonce123",
        user: { id: "user-42", username: "user42" },
        guildId: "guild-123",
        memberPermissions: { has: () => true },
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true,
        deferUpdate: async () => {},
        editReply: async (payload: unknown) => {
          editReplyPayload = payload;
        },
        fields: {
          getTextInputValue: () => "",
        },
      };

      const route = createMemoriesInteractionRoute(dependencies);
      await route.execute(
        {} as Client,
        addSubmitInteraction as unknown as ModalSubmitInteraction,
        requireRoute(addSubmitInteraction.customId),
      );

      expect(addBatchCalled).toBe(true);
      // "Already existing line" filtered out, "New memory line A" deduplicated
      expect(insertedLines).toEqual(["New memory line A", "New memory line B"]);

      const text = collectTextDisplays(editReplyPayload);
      expect(text.some((t) => t.includes("Saved 2 memories"))).toBe(true);
    } finally {
      addBatchSpy.mockRestore();
      existingSpy.mockRestore();
      limitSpy.mockRestore();
    }
  });

  it("invalidates tomori state cache on successful edit, remove, and addBatch", async () => {
    let invalidatedWorkspace: string | null = null;
    const cacheSpy = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation((ws) => {
      invalidatedWorkspace = ws;
    });

    const editSpy = spyOn(serverMemoryRepository, "edit").mockImplementation(async () => true);
    const removeSpy = spyOn(serverMemoryRepository, "remove").mockImplementation(async () => true);
    const addBatchSpy = spyOn(serverMemoryRepository, "addBatch").mockImplementation(async () => true);
    const loadContentsSpy = spyOn(serverMemoryRepository, "loadServerMemoryContents").mockImplementation(
      async () => [],
    );
    const limitSpy = spyOn(serverMemoryRepository, "checkServerMemoryLimit").mockImplementation(async () => ({
      isValid: true,
      currentCount: 0,
      maxAllowed: 100,
    }));
    const loadScopedSpy = spyOn(serverMemoryRepository, "loadServerMemoriesScoped").mockImplementation(async () => [
      makeMemory(1, { user_id: 42, persona_lineage_id: 1770, content: "Initial content", tags: [] }),
    ]);

    try {
      // Test edit cache invalidation
      invalidatedWorkspace = null;
      const editResult = await serverMemoriesOperations.edit({
        serverId: 1,
        personaLineageId: 1770,
        taughtByUserId: 42,
        memoryId: 1,
        workspaceId: "guild-123",
        isBlacklisted: false,
        canManage: true,
        content: "New edited content",
        tags: ["updated"],
      });
      expect(editResult.status).toBe("success");
      expect(invalidatedWorkspace).toBe("guild-123");

      // Test remove cache invalidation
      invalidatedWorkspace = null;
      const removeResult = await serverMemoriesOperations.remove({
        serverId: 1,
        personaLineageId: 1770,
        taughtByUserId: 42,
        memoryId: 1,
        workspaceId: "guild-123",
        isBlacklisted: false,
        canManage: true,
      });
      expect(removeResult.status).toBe("success");
      expect(invalidatedWorkspace).toBe("guild-123");

      // Test addBatch cache invalidation
      invalidatedWorkspace = null;
      const batchResult = await serverMemoriesOperations.addBatch({
        serverId: 1,
        personaId: 10,
        personaLineageId: 1770,
        taughtByUserId: 42,
        workspaceId: "guild-123",
        isBlacklisted: false,
        canManage: true,
        memteachingEnabled: true,
        contents: ["Batch memory 1", "Batch memory 2"],
        tags: [],
      });
      expect(batchResult.status).toBe("success");
      expect(invalidatedWorkspace).toBe("guild-123");
    } finally {
      cacheSpy.mockRestore();
      editSpy.mockRestore();
      removeSpy.mockRestore();
      addBatchSpy.mockRestore();
      loadContentsSpy.mockRestore();
      limitSpy.mockRestore();
      loadScopedSpy.mockRestore();
    }
  });

  it("resolves all panel locale keys, including every composed receipt pair", () => {
    const requiredKeys = [
      "selector_guidance",
      "add_option",
      "add_option_description",
      "add_modal_title",
      "edit_modal_title",
      "modal_content_label",
      "modal_content_placeholder",
      "modal_file_label",
      "modal_file_description",
      "modal_tags_label",
      "modal_tags_placeholder",
      "modal_tags_description",
      "edit_button",
      "remove_button",
      "remove_title",
      "remove_confirm",
      "remove_confirm_description",
      "cancel",
      ...MEMORIES_RECEIPT_KEYS.flatMap((key) => [`${key}_heading`, `${key}_detail`]),
    ];

    for (const receiptKey of Object.values(DOCUMENT_RESULT_RECEIPT_KEYS)) {
      expect(MEMORIES_RECEIPT_KEYS as readonly string[]).toContain(receiptKey);
    }

    for (const key of requiredKeys) {
      const fullKey = `commands.memories.${key}`;
      const resolved = localizer("en-US", fullKey, {
        memory: "sample",
        max: 100,
        added: 1,
        skipped: 0,
        available: 5,
        requested: 10,
      });
      expect(resolved).not.toBe(fullKey);
      expect(resolved.length).toBeGreaterThan(0);
    }
  });
});

describe("memories teaching gate on edit and remove", () => {
  /**
   * Server memory edit and remove operations independently gate on `server_memteaching_enabled`,
   * not just memory addition. Removal additionally has no blacklist check, so the two guards are
   * asserted separately rather than assumed to travel together.
   */
  it("refuses edit and remove for a non-manager when teaching is disabled", async () => {
    const editSpy = spyOn(serverMemoryRepository, "edit").mockImplementation(async () => true);
    const removeSpy = spyOn(serverMemoryRepository, "remove").mockImplementation(async () => true);
    const loadSpy = spyOn(serverMemoryRepository, "loadServerMemoriesScoped").mockImplementation(async () => [
      { server_memory_id: 7, content: "stored", tags: [] } as unknown as ServerMemoryRow,
    ]);

    try {
      const denied = {
        serverId: 1,
        personaLineageId: 1770,
        taughtByUserId: 42,
        memoryId: 7,
        workspaceId: "guild-123",
        isBlacklisted: false,
        canManage: false,
        memteachingEnabled: false,
      };

      const editResult = await serverMemoriesOperations.edit({ ...denied, content: "new", tags: [] });
      const removeResult = await serverMemoriesOperations.remove({ ...denied });

      expect(editResult.status).toBe("teaching-disabled");
      expect(removeResult.status).toBe("teaching-disabled");
      expect(editSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();

      // A manager is unaffected by the flag, which is what keeps the guard from being a blanket refusal.
      const allowed = { ...denied, canManage: true };
      expect((await serverMemoriesOperations.remove(allowed)).status).toBe("success");
      expect(removeSpy).toHaveBeenCalled();
    } finally {
      editSpy.mockRestore();
      removeSpy.mockRestore();
      loadSpy.mockRestore();
    }
  });
});

describe("memories document operation ordering", () => {
  it("updates document channel filters without regenerating an unchanged chunk embedding", async () => {
    const metaSpy = spyOn(serverMemoryRepository, "loadDocumentMeta").mockResolvedValue({
      document_name: "Guide",
      channel_tags: ["#old"],
    });
    const chunksSpy = spyOn(serverMemoryRepository, "loadDocumentChunks").mockResolvedValue([
      { document_chunk_id: 8, chunk_index: 0, content: "Stored chunk" },
    ]);
    const tagsSpy = spyOn(serverMemoryRepository, "updateDocumentChannelTags").mockResolvedValue(true);
    const embeddingSpy = spyOn(embeddingProvider, "generateEmbeddingsBatched");
    const invalidateSpy = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => {});

    try {
      const result = await serverDocumentsOperations.editChunk({
        serverId: 1,
        personaId: 10,
        documentId: 77,
        chunkIdx: 0,
        workspaceId: "guild-123",
        userId: 42,
        configuredEmbeddingModelId: null,
        canManage: true,
        content: "Stored chunk",
        channelTags: ["#general"],
      });

      expect(result.status).toBe("success");
      expect(tagsSpy).toHaveBeenCalledWith(77, 1, ["#general"], 10);
      expect(embeddingSpy).not.toHaveBeenCalled();
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
    } finally {
      metaSpy.mockRestore();
      chunksSpy.mockRestore();
      tagsSpy.mockRestore();
      embeddingSpy.mockRestore();
      invalidateSpy.mockRestore();
    }
  });

  it("invalidates authoritative state after every successful document repository write", async () => {
    const ragSpy = spyOn(ragAvailability, "isRagAvailable").mockReturnValue(true);
    const memoryGuardSpy = spyOn(rateLimiter.memoryGuard, "checkMemory").mockReturnValue({
      status: "ok",
      usagePercent: 0,
      heapUsedMB: 1,
      heapTotalMB: 2,
      rssMB: 3,
    });
    const quotaSpy = spyOn(rateLimiter, "reserveDocumentQuota").mockReturnValue({ allowed: true });
    const credentialSpy = spyOn(credentialResolver, "resolveCapabilityCredentials").mockResolvedValue({
      apiKey: "test-key",
    });
    const modelIdSpy = spyOn(credentialResolver, "getResolvedCapabilityModelId").mockReturnValue(5);
    const modelSpy = spyOn(llmModelRepo, "loadEmbeddingModelById").mockResolvedValue({
      embedding_model_id: 5,
      provider: "google",
      codename: "embedding-model",
      model_family: "embedding-family",
    });
    const taskSpy = spyOn(embeddingProvider, "providerSupportsEmbeddingTaskType").mockResolvedValue(false);
    const embeddingSpy = spyOn(embeddingProvider, "generateEmbeddingsBatched").mockResolvedValue([[0.1, 0.2]]);
    const downloadSpy = spyOn(safeDownloadModule, "safeDownload").mockResolvedValue({
      success: true,
      buffer: Buffer.from("Document content"),
    });
    const extractSpy = spyOn(textExtractor, "extractTextFromBuffer").mockResolvedValue("Document content");
    const normalizeSpy = spyOn(ragRepository, "normalizeText").mockImplementation((content) => content);
    const chunkSpy = spyOn(ragRepository, "chunkText").mockReturnValue(["Document content"]);
    const insertSpy = spyOn(ragRepository, "insertWithChunks").mockResolvedValue(91);
    const duplicateSpy = spyOn(serverMemoryRepository, "documentExistsByName").mockResolvedValue(false);
    const documentCountSpy = spyOn(serverMemoryRepository, "countDocumentsScoped").mockResolvedValue(0);
    const chunkCountSpy = spyOn(serverMemoryRepository, "countChunksScoped").mockResolvedValue(0);
    const loadDocumentsSpy = spyOn(serverMemoryRepository, "loadDocuments").mockResolvedValue([
      { document_id: 91, document_name: "Guide", first_chunk: "Document content" },
    ]);
    const loadMetaSpy = spyOn(serverMemoryRepository, "loadDocumentMeta").mockResolvedValue({
      document_name: "Guide",
      channel_tags: [],
    });
    const loadChunksSpy = spyOn(serverMemoryRepository, "loadDocumentChunks").mockResolvedValue([
      { document_chunk_id: 8, chunk_index: 0, content: "Document content" },
    ]);
    const updateChunkSpy = spyOn(serverMemoryRepository, "updateChunk").mockResolvedValue(true);
    const deleteChunkSpy = spyOn(serverMemoryRepository, "deleteChunk").mockResolvedValue(true);
    const removeDocumentSpy = spyOn(serverMemoryRepository, "removeDocument").mockResolvedValue("Guide");
    const rebuildSpy = spyOn(documentService, "rebuildDocumentTextContent").mockResolvedValue(undefined);
    const invalidateSpy = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => {});

    try {
      expect(
        (
          await serverDocumentsOperations.add({
            serverId: 1,
            personaId: 10,
            userId: 42,
            userDiscId: "user-42",
            workspaceId: "guild-123",
            configuredEmbeddingModelId: 5,
            isBlacklisted: false,
            canManage: true,
            memteachingEnabled: true,
            documentName: "Guide",
            attachment: {
              id: "attachment-1",
              filename: "guide.txt",
              size: 16,
              url: "https://cdn.example.invalid/guide.txt",
              proxy_url: "https://proxy.example.invalid/guide.txt",
              content_type: "text/plain",
            },
            channelTags: [],
          })
        ).status,
      ).toBe("success");
      expect(invalidateSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

      invalidateSpy.mockClear();
      expect(
        (
          await serverDocumentsOperations.editChunk({
            serverId: 1,
            personaId: 10,
            documentId: 91,
            chunkIdx: 0,
            workspaceId: "guild-123",
            userId: 42,
            configuredEmbeddingModelId: 5,
            canManage: true,
            content: "Updated content",
            channelTags: [],
          })
        ).status,
      ).toBe("success");
      expect(updateChunkSpy).toHaveBeenCalled();
      expect(rebuildSpy).toHaveBeenCalledWith(91);
      expect(invalidateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

      invalidateSpy.mockClear();
      expect(
        (
          await serverDocumentsOperations.remove({
            serverId: 1,
            personaId: 10,
            documentId: 91,
            workspaceId: "guild-123",
            canManage: true,
            memteachingEnabled: true,
            historyOnly: false,
          })
        ).status,
      ).toBe("success");
      expect(invalidateSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

      invalidateSpy.mockClear();
      expect(
        (
          await serverDocumentsOperations.removeChunk({
            serverId: 1,
            personaId: 10,
            documentId: 91,
            chunkIdx: 0,
            workspaceId: "guild-123",
            canManage: true,
          })
        ).status,
      ).toBe("success");
      expect(deleteChunkSpy).toHaveBeenCalled();
      expect(invalidateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      ragSpy.mockRestore();
      memoryGuardSpy.mockRestore();
      quotaSpy.mockRestore();
      credentialSpy.mockRestore();
      modelIdSpy.mockRestore();
      modelSpy.mockRestore();
      taskSpy.mockRestore();
      embeddingSpy.mockRestore();
      downloadSpy.mockRestore();
      extractSpy.mockRestore();
      normalizeSpy.mockRestore();
      chunkSpy.mockRestore();
      insertSpy.mockRestore();
      duplicateSpy.mockRestore();
      documentCountSpy.mockRestore();
      chunkCountSpy.mockRestore();
      loadDocumentsSpy.mockRestore();
      loadMetaSpy.mockRestore();
      loadChunksSpy.mockRestore();
      updateChunkSpy.mockRestore();
      deleteChunkSpy.mockRestore();
      removeDocumentSpy.mockRestore();
      rebuildSpy.mockRestore();
      invalidateSpy.mockRestore();
    }
  });

  it("inserts and invalidates before removing a vectorized memory, and never removes after embedding failure", async () => {
    const order: string[] = [];
    const ragSpy = spyOn(ragAvailability, "isRagAvailable").mockReturnValue(true);
    const memoryGuardSpy = spyOn(rateLimiter.memoryGuard, "checkMemory").mockReturnValue({
      status: "ok",
      usagePercent: 0,
      heapUsedMB: 1,
      heapTotalMB: 2,
      rssMB: 3,
    });
    const quotaSpy = spyOn(rateLimiter, "reserveDocumentQuota").mockReturnValue({ allowed: true });
    const credentialSpy = spyOn(credentialResolver, "resolveCapabilityCredentials").mockResolvedValue({
      apiKey: "test-key",
    });
    const modelIdSpy = spyOn(credentialResolver, "getResolvedCapabilityModelId").mockReturnValue(5);
    const modelSpy = spyOn(llmModelRepo, "loadEmbeddingModelById").mockResolvedValue({
      embedding_model_id: 5,
      provider: "google",
      codename: "embedding-model",
      model_family: "embedding-family",
    });
    const taskSpy = spyOn(embeddingProvider, "providerSupportsEmbeddingTaskType").mockResolvedValue(false);
    const embeddingSpy = spyOn(embeddingProvider, "generateEmbeddingsBatched").mockResolvedValue([[0.1, 0.2]]);
    const normalizeSpy = spyOn(ragRepository, "normalizeText").mockImplementation((content) => content);
    const chunkSpy = spyOn(ragRepository, "chunkText").mockReturnValue(["Vectorized content"]);
    const insertSpy = spyOn(ragRepository, "insertWithChunks").mockImplementation(async () => {
      order.push("insert");
      return 91;
    });
    const loadSpy = spyOn(serverMemoryRepository, "loadServerMemoriesScoped").mockResolvedValue([
      makeMemory(7, { persona_id: 10, persona_lineage_id: 1770, user_id: 42 }),
    ]);
    const duplicateSpy = spyOn(serverMemoryRepository, "documentExistsByName").mockResolvedValue(false);
    const documentCountSpy = spyOn(serverMemoryRepository, "countDocumentsScoped").mockResolvedValue(0);
    const chunkCountSpy = spyOn(serverMemoryRepository, "countChunksScoped").mockResolvedValue(0);
    const removeSpy = spyOn(serverMemoryRepository, "remove").mockImplementation(async () => {
      order.push("remove");
      return true;
    });
    const invalidateSpy = spyOn(tomoriStateCache, "invalidateTomoriStateCache").mockImplementation(() => {
      order.push("invalidate");
    });

    const input = {
      serverId: 1,
      personaId: 10,
      personaLineageId: 1770,
      memoryId: 7,
      userId: 42,
      userDiscId: "user-42",
      workspaceId: "guild-123",
      configuredEmbeddingModelId: 5,
      isBlacklisted: false,
      canManage: true,
      memteachingEnabled: true,
      content: "Vectorized content",
      documentName: "Vectorized Guide",
      channelTags: [],
    };

    try {
      expect((await serverDocumentsOperations.vectorize(input)).status).toBe("success");
      expect(order).toEqual(["insert", "invalidate", "remove", "invalidate"]);

      order.length = 0;
      removeSpy.mockResolvedValueOnce(false);
      const partial = await serverDocumentsOperations.vectorize(input);
      expect(partial.status).toBe("partial-failure");
      // The document survives and the state cache is invalidated once for it; the second
      // invalidate belongs to the removal that did not happen.
      expect(order).toEqual(["insert", "invalidate"]);

      order.length = 0;
      embeddingSpy.mockRejectedValueOnce(new Error("embedding failed"));
      await expect(serverDocumentsOperations.vectorize(input)).rejects.toThrow("embedding failed");
      expect(order).toEqual([]);
    } finally {
      ragSpy.mockRestore();
      memoryGuardSpy.mockRestore();
      quotaSpy.mockRestore();
      credentialSpy.mockRestore();
      modelIdSpy.mockRestore();
      modelSpy.mockRestore();
      taskSpy.mockRestore();
      embeddingSpy.mockRestore();
      normalizeSpy.mockRestore();
      chunkSpy.mockRestore();
      insertSpy.mockRestore();
      loadSpy.mockRestore();
      duplicateSpy.mockRestore();
      documentCountSpy.mockRestore();
      chunkCountSpy.mockRestore();
      removeSpy.mockRestore();
      invalidateSpy.mockRestore();
    }
  });
});
