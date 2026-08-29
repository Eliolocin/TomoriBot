import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import {
  type ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { ServerMemoryRow, TomoriState } from "@/types/db/schema";
import {
  buildMemoriesRouteId,
  parseMemoriesPanelRoute,
  type MemoriesPanelRoute,
} from "@/utils/discord/memoriesPanelCatalog";
import {
  buildInitialMemoriesPanel,
  createMemoriesInteractionRoute,
  serverMemoriesOperations,
  type MemoriesRouteDependencies,
} from "@/utils/discord/interactions/memoriesRoutes";
import { parseInteractionRoute, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  buildAddServerMemoryModal,
  buildEditServerMemoryModal,
  buildMemoriesPanelPayload,
  buildServerMemoryModalFieldId,
  parseServerMemoryTags,
} from "@/utils/discord/ui/memoriesPanel";
import * as tomoriStateCache from "@/utils/cache/tomoriStateCache";
import { serverMemoryRepository } from "@/utils/db/repositories";
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
      getEligibleLineageIds: async (serverId, userId) => {
        calls.push(`getEligibleLineageIds:${serverId}:${userId ?? "undefined"}`);
        return new Set([1770]);
      },
      getPersonaAvatarUrl: async (_interaction, persona) => {
        calls.push(`getPersonaAvatarUrl:${persona.persona_id}`);
        return `https://cdn.example.invalid/${persona.persona_id}.png`;
      },
      getStmCount: async (workspaceId) => {
        calls.push(`getStmCount:${workspaceId}`);
        return 3;
      },
      preWarmServerStm: async (workspaceId) => {
        calls.push(`preWarmServerStm:${workspaceId}`);
      },
      operations: serverMemoriesOperations,
      recordAction: () => {
        calls.push("recordAction");
      },
      createNonce: () => "test-nonce",
      showAddModal: async () => {
        calls.push("showAddModal");
      },
      takeFileUpload: () => null,
      readUploadedText: async () => ({ isValid: true, text: "" }),
      showEditModal: async () => {
        calls.push("showEditModal");
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
    expect(callsNonManager).toContain("getEligibleLineageIds:1:42");
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
    expect(callsManager).toContain("getEligibleLineageIds:1:undefined");
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

    // Non-manager must NOT trigger getStmCount or preWarmServerStm
    expect(calls.some((c) => c.startsWith("getStmCount"))).toBe(false);
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
    expect(calls).toContain("getStmCount:guild-123");
    const managerTextDisplays = collectTextDisplays(editedReply);
    expect(managerTextDisplays.some((t) => t.includes("3 active short-term memory entries."))).toBe(true);
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
  });

  it("renders inline range buttons when rangeCount <= 5 and chooser button when > 5", () => {
    const personas = [makePersona(1, 100, "Main Persona", false)];

    // 48 memories = 2 pages (page size 24) -> rangeCount = 2 <= 5 -> inline buttons
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
    const rangeButtons = smallButtons.filter((b) => b.customId?.includes(":range:"));
    expect(rangeButtons).toHaveLength(2);
    expect(rangeButtons[0].label).toBe("1-24");
    expect(rangeButtons[1].label).toBe("25-48");

    // 150 memories = 7 pages (page size 24) -> rangeCount = 7 > 5 -> range-open chooser button
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
    const rangeOpenButton = largeButtons.find((b) => b.customId?.includes(":range-open:"));
    expect(rangeOpenButton).toBeDefined();
    expect(rangeOpenButton?.label).toBe(localizer("en-US", "general.pagination.select_page_title"));
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

      let replyContent = "";
      const selectAddInteraction = {
        id: "int-add-blacklisted",
        customId: "memories:v1:select:en-US:1770",
        values: ["action:add"],
        user: { id: "user-blacklisted", username: "badactor" },
        guildId: "guild-123",
        memberPermissions: { has: () => false },
        isButton: () => false,
        isStringSelectMenu: () => true,
        isModalSubmit: () => false,
        reply: async (opts: { content: string }) => {
          replyContent = opts.content;
        },
      };

      const route = createMemoriesInteractionRoute(dependencies);
      await route.execute(
        {} as Client,
        selectAddInteraction as unknown as StringSelectMenuInteraction,
        requireRoute(selectAddInteraction.customId),
      );

      expect(replyContent).toContain("blacklisted");
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

  it("resolves all memories locale keys dynamically", () => {
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
      "added_heading",
      "added_detail",
      "edited_heading",
      "edited_detail",
      "removed_heading",
      "removed_detail",
      "no_changes_heading",
      "no_changes_detail",
      "changed_state_heading",
      "changed_state_detail",
      "write_failed_heading",
      "write_failed_detail",
      "content_too_long_heading",
      "content_too_long_detail",
      "limit_reached_heading",
      "limit_reached_detail",
      "empty_content_heading",
      "empty_content_detail",
      "batch_added_heading",
      "batch_added_detail",
      "batch_file_invalid_heading",
      "batch_file_invalid_detail",
      "batch_file_too_large_heading",
      "batch_file_too_large_detail",
      "batch_all_duplicates_heading",
      "batch_all_duplicates_detail",
      "batch_limit_reached_heading",
      "batch_limit_reached_detail",
      "blacklisted_error_heading",
      "blacklisted_error_detail",
      "teaching_disabled_error_heading",
      "teaching_disabled_error_detail",
    ];

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
   * Every legacy workspace memory leaf gates on `server_memteaching_enabled`, not just `add`:
   * `memory/server/add.ts:111`, `edit.ts:204`, `remove.ts:132`, and `vectorize.ts:178` all carry it.
   * Removal is the one that additionally has no blacklist check, so the two guards are asserted
   * separately rather than assumed to travel together.
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
