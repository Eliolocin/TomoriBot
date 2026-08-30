import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import type {
  ActionRowData,
  ButtonInteraction,
  Client,
  InteractionReplyOptions,
  ModalSubmitInteraction,
  StringSelectMenuComponentData,
  StringSelectMenuInteraction,
} from "discord.js";
import { PrivacyLevel, type PersonalMemoryRow, type TomoriState } from "@/types/db/schema";
import {
  createPersonalMemoriesInteractionRoute,
  personalMemoriesOperations,
  type PersonalMemoriesOperations,
  type PersonalMemoriesRouteDependencies,
} from "@/utils/discord/interactions/personalMemoriesRoutes";
import { personalMemoryRepository, userRepository } from "@/utils/db/repositories";
import type { APIAttachment } from "discord.js";
import {
  buildPersonalMemoriesRouteId,
  buildPersonalMemoriesRouteSegments,
  listPersonalMemoriesPanelActions,
  parsePersonalMemoriesPanelRoute,
  PERSONAL_MEMORIES_ROUTE_CODECS,
  PERSONAL_MEMORIES_ROUTE_NAMESPACE,
  PERSONAL_MEMORIES_ROUTE_VERSION,
  type PersonalMemoriesPanelRoute,
} from "@/utils/discord/personalMemoriesPanelCatalog";
import {
  buildInteractionRouteId,
  parseInteractionRoute,
  type ParsedInteractionRoute,
} from "@/utils/discord/interactions/routeRegistry";
import { dispatchGlobalInteraction } from "@/utils/discord/interactions/router";
import {
  buildAddPersonalMemoryModal,
  buildEditPersonalMemoryModal,
  buildPersonalMemoryModalFieldId,
  buildPersonalMemoriesPanelPayload,
} from "@/utils/discord/ui/personalMemoriesPanel";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

// These literal v1 bytes precede the exact-codec refactor and protect published field order.
const WIRE_CONTRACT_V1: ReadonlyArray<readonly [string, PersonalMemoriesPanelRoute]> = [
  ["personal-memories:v1:category:en-US:global", { action: "category", locale: "en-US", category: "global" }],
  [
    "personal-memories:v1:persona-select:en-US:persona:1",
    { action: "persona-select", locale: "en-US", category: "persona", lineageId: 1 },
  ],
  [
    "personal-memories:v1:select:en-US:global:0",
    { action: "select", locale: "en-US", category: "global", lineageId: 0 },
  ],
  [
    "personal-memories:v1:select:en-US:persona:1:0",
    { action: "select", locale: "en-US", category: "persona", lineageId: 1, rangeIndex: 0 },
  ],
  [
    "personal-memories:v1:range-open:en-US:global:0",
    { action: "range-open", locale: "en-US", category: "global", lineageId: 0 },
  ],
  [
    "personal-memories:v1:range:en-US:global:0:0",
    { action: "range", locale: "en-US", category: "global", lineageId: 0, rangeIndex: 0 },
  ],
  [
    "personal-memories:v1:range-page:en-US:global:0:0",
    { action: "range-page", locale: "en-US", category: "global", lineageId: 0, chooserPage: 0 },
  ],
  [
    "personal-memories:v1:range-cancel:en-US:global:0",
    { action: "range-cancel", locale: "en-US", category: "global", lineageId: 0 },
  ],
  [
    "personal-memories:v1:add-submit:en-US:global:0:12345678",
    { action: "add-submit", locale: "en-US", category: "global", lineageId: 0, nonce: "12345678" },
  ],
  [
    "personal-memories:v1:edit-open:en-US:global:0:1",
    { action: "edit-open", locale: "en-US", category: "global", lineageId: 0, memoryId: 1 },
  ],
  [
    "personal-memories:v1:edit-submit:en-US:global:0:1:12345678",
    { action: "edit-submit", locale: "en-US", category: "global", lineageId: 0, memoryId: 1, nonce: "12345678" },
  ],
  [
    "personal-memories:v1:remove-prompt:en-US:global:0:1",
    { action: "remove-prompt", locale: "en-US", category: "global", lineageId: 0, memoryId: 1 },
  ],
  [
    "personal-memories:v1:remove-confirm:en-US:global:0:1",
    { action: "remove-confirm", locale: "en-US", category: "global", lineageId: 0, memoryId: 1 },
  ],
  [
    "personal-memories:v1:remove-cancel:en-US:global:0:1",
    { action: "remove-cancel", locale: "en-US", category: "global", lineageId: 0, memoryId: 1 },
  ],
  [
    "personal-memories:v1:stm-clear:en-US:global:0",
    { action: "stm-clear", locale: "en-US", category: "global", lineageId: 0 },
  ],
  ["personal-memories:v1:retry:en-US:global:0", { action: "retry", locale: "en-US", category: "global", lineageId: 0 }],
  [
    "personal-memories:v1:refresh:en-US:global:0",
    { action: "refresh", locale: "en-US", category: "global", lineageId: 0 },
  ],
];

function requireRoute(customId: string): ParsedInteractionRoute {
  const parsed = parseInteractionRoute(customId);
  if (!parsed) throw new Error(`Failed to parse route for customId: ${customId}`);
  return parsed;
}

function makeMemory(id: number, overrides: Partial<PersonalMemoryRow> = {}): PersonalMemoryRow {
  return {
    personal_memory_id: id,
    user_id: 1,
    persona_lineage_id: 0,
    content: `Memory content ${id}`,
    tags: ["tag1", "tag2"],
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

/** Every String Select in the payload, flattened, so a test can pick one out by custom ID. */
function collectSelects(
  value: unknown,
): Array<{ customId?: string; options?: Array<{ value?: string; label?: string; description?: string }> }> {
  if (Array.isArray(value)) return value.flatMap(collectSelects);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const self = record.type === 3 ? [record as never] : [];
  return [...self, ...Object.values(record).flatMap(collectSelects)];
}

function makeDependencies(
  calls: string[],
  overrides: Partial<PersonalMemoriesRouteDependencies> = {},
): {
  dependencies: PersonalMemoriesRouteDependencies;
  memories: PersonalMemoryRow[];
  telemetry: string[];
} {
  const memories: PersonalMemoryRow[] = [
    makeMemory(1, { persona_lineage_id: 0, content: "Global memory 1" }),
    makeMemory(2, { persona_lineage_id: 0, content: "Global memory 2" }),
    makeMemory(3, { persona_lineage_id: 10, content: "Persona memory 1", tags: ["#general"] }),
  ];
  const telemetry: string[] = [];

  const operations: PersonalMemoriesOperations = {
    addBatch: async (input) => {
      calls.push(`addBatch:${input.contents.length}`);
      for (const content of input.contents) {
        memories.push(
          makeMemory(200 + memories.length, {
            user_id: input.userId,
            persona_lineage_id: input.personaLineageId,
            content,
            tags: input.tags,
          }),
        );
      }
      return { status: "success", added: input.contents.length, skipped: 0 };
    },
    add: async (input) => {
      calls.push(`add:${input.content}`);
      const newMemory = makeMemory(100, {
        user_id: input.userId,
        persona_lineage_id: input.personaLineageId,
        content: input.content,
        tags: input.tags,
      });
      memories.push(newMemory);
      return { status: "success", row: newMemory };
    },
    edit: async (input) => {
      calls.push(`edit:${input.memoryId}`);
      const existing = memories.find((m) => m.personal_memory_id === input.memoryId);
      if (!existing) return { status: "not-found" };
      existing.content = input.content;
      existing.tags = input.tags;
      return { status: "success", row: existing };
    },
    remove: async (input) => {
      calls.push(`remove:${input.memoryId}`);
      const index = memories.findIndex((m) => m.personal_memory_id === input.memoryId);
      if (index === -1) return { status: "not-found" };
      const removed = memories.splice(index, 1)[0];
      if (!removed) return { status: "not-found" };
      return { status: "success", row: removed };
    },
    clearStm: async (userDiscId) => {
      calls.push(`clearStm:${userDiscId}`);
    },
  };

  const dependencies: PersonalMemoriesRouteDependencies = {
    resolveScope: async (_interaction, _forceRefresh) => {
      calls.push("resolveScope");
      return {
        userId: 1,
        userDiscId: "123456789",
        guildId: "987654321",
        workspaceId: "987654321",
        internalServerId: 42,
        privacyLevel: PrivacyLevel.MINIMAL,
        personas: [makePersona(1, 10, "Tomori"), makePersona(2, 20, "Anon")],
        readStatus: "fresh",
      };
    },
    loadMemories: async (_userId, lineageId) => {
      calls.push(`loadMemories:${lineageId}`);
      return lineageId === 0
        ? memories.filter((m) => m.persona_lineage_id === 0)
        : memories.filter((m) => m.persona_lineage_id === lineageId);
    },
    getMemoryCountsByLineage: async (_userId) => {
      calls.push("getMemoryCountsByLineage");
      const counts = new Map<number, number>();
      for (const memory of memories) {
        if (memory.persona_lineage_id === 0) continue;
        counts.set(memory.persona_lineage_id, (counts.get(memory.persona_lineage_id) ?? 0) + 1);
      }
      return counts;
    },
    getPersonaAvatarUrl: async (_interaction, persona) => {
      calls.push(`getPersonaAvatarUrl:${persona.persona_id}`);
      return `https://cdn.example.invalid/${persona.persona_id}.png`;
    },
    getStmCount: async (_userDiscId) => {
      calls.push("getStmCount");
      return 2;
    },
    operations,
    recordAction: (input) => {
      calls.push(`recordAction:${input.action}`);
      telemetry.push(input.action);
    },
    createNonce: () => "abcdef123456",
    showAddModal: async () => {
      calls.push("showAddModal");
    },
    showEditModal: async () => {
      calls.push("showEditModal");
    },
    takeFileUpload: () => undefined,
    readUploadedText: async () => ({ isValid: true, text: "1. First memory\n2. Second memory\n" }),
    ...overrides,
  };

  return { dependencies, memories, telemetry };
}

describe("personal-memories panel route catalog", () => {
  it("decodes every literal v1 wire string to its exact route", () => {
    for (const [customId, expected] of WIRE_CONTRACT_V1) {
      expect(parsePersonalMemoriesPanelRoute(requireRoute(customId))).toEqual(expected);
    }
  });

  it("encodes every canonical typed route to exact literal wire bytes", () => {
    for (const [customId, expected] of WIRE_CONTRACT_V1) {
      expect(buildPersonalMemoriesRouteId(expected)).toBe(customId);
      const expectedSegments = customId.split(":").slice(2);
      expect(buildPersonalMemoriesRouteSegments(expected)).toEqual(expectedSegments);
    }
  });

  it("round trips parse and build for all canonical actions", () => {
    for (const [, expected] of WIRE_CONTRACT_V1) {
      const builtId = buildPersonalMemoriesRouteId(expected);
      const parts = builtId.split(":");
      const parsedFromBuilt = parsePersonalMemoriesPanelRoute({
        namespace: parts[0] as string,
        version: parts[1] as string,
        segments: parts.slice(2),
      });
      expect(parsedFromBuilt).toEqual(expected);
    }
  });

  it("guarantees 16-action exhaustiveness across catalog, accepted actions, wire contract, and route handler comparisons", () => {
    const ACCEPTED_16_ACTIONS = [
      "add-submit",
      "category",
      "edit-open",
      "edit-submit",
      "persona-select",
      "range",
      "range-cancel",
      "range-open",
      "range-page",
      "refresh",
      "remove-cancel",
      "remove-confirm",
      "remove-prompt",
      "retry",
      "select",
      "stm-clear",
    ].sort();

    const catalogActions = listPersonalMemoriesPanelActions().sort();
    const wireActions = [...new Set(WIRE_CONTRACT_V1.map(([, route]) => route.action))].sort();
    const codecTableActions = Object.keys(PERSONAL_MEMORIES_ROUTE_CODECS).sort();

    const routesSource = readFileSync(
      new URL("../../../src/utils/discord/interactions/personalMemoriesRoutes.ts", import.meta.url),
      "utf8",
    );
    const handlerActions = new Set([...routesSource.matchAll(/route\.action === "([a-z0-9-]+)"/g)].map((m) => m[1]));

    expect(catalogActions).toEqual(ACCEPTED_16_ACTIONS);
    expect(wireActions).toEqual(ACCEPTED_16_ACTIONS);
    expect(codecTableActions).toEqual(ACCEPTED_16_ACTIONS);

    expect(handlerActions.size).toBe(16);
    expect([...handlerActions].sort()).toEqual(ACCEPTED_16_ACTIONS);
    expect(ACCEPTED_16_ACTIONS.filter((a) => !handlerActions.has(a))).toEqual([]);
    expect([...handlerActions].filter((a) => !ACCEPTED_16_ACTIONS.includes(a))).toEqual([]);
    expect(codecTableActions.filter((a) => !handlerActions.has(a))).toEqual([]);
    expect([...handlerActions].filter((a) => !codecTableActions.includes(a))).toEqual([]);
  });

  it("guarantees producer coverage against production UI and modal surfaces with explicit allowlist for producerless actions", () => {
    const PRODUCERLESS_ACTIONS = ["refresh"] as const;
    const ACCEPTED_16_ACTIONS = [
      "add-submit",
      "category",
      "edit-open",
      "edit-submit",
      "persona-select",
      "range",
      "range-cancel",
      "range-open",
      "range-page",
      "refresh",
      "remove-cancel",
      "remove-confirm",
      "remove-prompt",
      "retry",
      "select",
      "stm-clear",
    ].sort();

    const collectedCustomIds: string[] = [];

    function harvestCustomIds(val: unknown): void {
      if (Array.isArray(val)) {
        for (const item of val) harvestCustomIds(item);
        return;
      }
      if (!val || typeof val !== "object") return;
      const obj = val as Record<string, unknown>;
      if (typeof obj.customId === "string" && obj.customId.startsWith("personal-memories:")) {
        collectedCustomIds.push(obj.customId);
      }
      if (typeof obj.custom_id === "string" && obj.custom_id.startsWith("personal-memories:")) {
        collectedCustomIds.push(obj.custom_id);
      }
      for (const prop of Object.values(obj)) {
        harvestCustomIds(prop);
      }
    }

    const sampleMemories = [
      makeMemory(1, { persona_lineage_id: 0, content: "Global memory 1" }),
      makeMemory(2, { persona_lineage_id: 0, content: "Global memory 2" }),
      makeMemory(3, { persona_lineage_id: 10, content: "Persona memory 1" }),
    ];
    const manyMemories = Array.from({ length: 30 }, (_, i) => makeMemory(i + 1, { persona_lineage_id: 0 }));
    const multiPageChooserMemories = Array.from({ length: 300 }, (_, i) =>
      makeMemory(i + 1, { persona_lineage_id: 0 }),
    );
    const samplePersonas = [makePersona(1, 10, "Tomori"), makePersona(2, 20, "Anon")];

    // Global main with memories (produces category, select, edit-open, remove-prompt, stm-clear)
    harvestCustomIds(
      buildPersonalMemoriesPanelPayload({
        locale: "en-US",
        category: "global",
        selectedLineageId: 0,
        personas: samplePersonas,
        memories: sampleMemories,
        stmCount: 1,
        privacyLevel: PrivacyLevel.MINIMAL,
        readStatus: "fresh",
        page: { kind: "main" },
      }),
    );

    // Global main with multi-page memories (produces range-open)
    harvestCustomIds(
      buildPersonalMemoriesPanelPayload({
        locale: "en-US",
        category: "global",
        selectedLineageId: 0,
        personas: samplePersonas,
        memories: manyMemories,
        stmCount: 1,
        privacyLevel: PrivacyLevel.MINIMAL,
        readStatus: "fresh",
        page: { kind: "main" },
      }),
    );

    // Range chooser (produces range, range-page, range-cancel)
    harvestCustomIds(
      buildPersonalMemoriesPanelPayload({
        locale: "en-US",
        category: "global",
        selectedLineageId: 0,
        personas: samplePersonas,
        memories: multiPageChooserMemories,
        stmCount: 1,
        privacyLevel: PrivacyLevel.MINIMAL,
        readStatus: "fresh",
        page: { kind: "range-chooser", chooserPage: 0 },
      }),
    );

    // Remove page (produces remove-confirm, remove-cancel)
    harvestCustomIds(
      buildPersonalMemoriesPanelPayload({
        locale: "en-US",
        category: "global",
        selectedLineageId: 0,
        personas: samplePersonas,
        memories: sampleMemories,
        stmCount: 1,
        privacyLevel: PrivacyLevel.MINIMAL,
        readStatus: "fresh",
        page: { kind: "remove", memoryId: 1 },
      }),
    );

    // Persona main (produces persona-select, select, edit-open, remove-prompt)
    harvestCustomIds(
      buildPersonalMemoriesPanelPayload({
        locale: "en-US",
        category: "persona",
        selectedLineageId: 10,
        personas: samplePersonas,
        memories: sampleMemories,
        stmCount: 0,
        privacyLevel: PrivacyLevel.MINIMAL,
        readStatus: "fresh",
        page: { kind: "main" },
      }),
    );

    // Persona multi-page (produces range-open)
    harvestCustomIds(
      buildPersonalMemoriesPanelPayload({
        locale: "en-US",
        category: "persona",
        selectedLineageId: 10,
        personas: samplePersonas,
        memories: manyMemories,
        stmCount: 0,
        privacyLevel: PrivacyLevel.MINIMAL,
        readStatus: "fresh",
        page: { kind: "main" },
      }),
    );

    // Unavailable status (produces retry)
    harvestCustomIds(
      buildPersonalMemoriesPanelPayload({
        locale: "en-US",
        category: "global",
        selectedLineageId: 0,
        personas: samplePersonas,
        memories: [],
        stmCount: 0,
        privacyLevel: PrivacyLevel.MINIMAL,
        readStatus: "unavailable",
        page: { kind: "main" },
      }),
    );

    // Stale status (produces retry)
    harvestCustomIds(
      buildPersonalMemoriesPanelPayload({
        locale: "en-US",
        category: "global",
        selectedLineageId: 0,
        personas: samplePersonas,
        memories: sampleMemories,
        stmCount: 1,
        privacyLevel: PrivacyLevel.MINIMAL,
        readStatus: "stale",
        page: { kind: "main" },
      }),
    );

    // Add modal (produces add-submit)
    harvestCustomIds(buildAddPersonalMemoryModal("en-US", "global", 0, "12345678"));

    // Edit modal (produces edit-submit)
    harvestCustomIds(buildEditPersonalMemoryModal("en-US", "global", 0, 1, "content", [], "12345678"));

    const producedActions = new Set<string>();
    for (const customId of collectedCustomIds) {
      const parts = customId.split(":");
      const parsed = parsePersonalMemoriesPanelRoute({
        namespace: parts[0] as string,
        version: parts[1] as string,
        segments: parts.slice(2),
      });
      expect(parsed).not.toBeNull();
      if (parsed) {
        producedActions.add(parsed.action);
      }
    }

    for (const action of PRODUCERLESS_ACTIONS) {
      expect(producedActions.has(action)).toBe(false);
    }

    const unionedActions = [...new Set([...producedActions, ...PRODUCERLESS_ACTIONS])].sort();
    expect(unionedActions).toEqual(ACCEPTED_16_ACTIONS);
  });

  it("distinguishes presence and absence of optional select.rangeIndex", () => {
    const shortSelect = parsePersonalMemoriesPanelRoute({
      namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
      version: PERSONAL_MEMORIES_ROUTE_VERSION,
      segments: ["select", "en-US", "global", "0"],
    });
    expect(shortSelect).not.toBeNull();
    if (shortSelect) {
      expect("rangeIndex" in shortSelect).toBe(false);
      expect(shortSelect).toEqual({ action: "select", locale: "en-US", category: "global", lineageId: 0 });
      expect(buildPersonalMemoriesRouteId(shortSelect)).toBe("personal-memories:v1:select:en-US:global:0");
    }

    const longSelect = parsePersonalMemoriesPanelRoute({
      namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
      version: PERSONAL_MEMORIES_ROUTE_VERSION,
      segments: ["select", "en-US", "persona", "1", "0"],
    });
    expect(longSelect).not.toBeNull();
    if (longSelect) {
      expect("rangeIndex" in longSelect).toBe(true);
      expect(longSelect).toEqual({
        action: "select",
        locale: "en-US",
        category: "persona",
        lineageId: 1,
        rangeIndex: 0,
      });
      expect(buildPersonalMemoriesRouteId(longSelect)).toBe("personal-memories:v1:select:en-US:persona:1:0");
    }
  });

  it("rejects unsupported locales, malformed segment counts, and invalid values", () => {
    expect(
      parsePersonalMemoriesPanelRoute({ namespace: "wrong", version: "v1", segments: ["category", "en-US", "global"] }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v2",
        segments: ["category", "en-US", "global"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["category", "fr-FR", "global"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["category", "", "global"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["unknown", "en-US", "global", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["category", "en-US", "invalid"],
      }),
    ).toBeNull();

    // Segment count bounds
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["category", "en-US"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["category", "en-US", "global", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["persona-select", "en-US", "persona"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["persona-select", "en-US", "persona", "1", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["select", "en-US", "global"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["select", "en-US", "global", "0", "1", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["range", "en-US", "global", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["range", "en-US", "global", "0", "1", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["range-page", "en-US", "global", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["range-page", "en-US", "global", "0", "1", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["add-submit", "en-US", "global", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["add-submit", "en-US", "global", "0", "12345678", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["edit-open", "en-US", "global", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["edit-open", "en-US", "global", "0", "1", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["edit-submit", "en-US", "global", "0", "1"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["edit-submit", "en-US", "global", "0", "1", "12345678", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["remove-prompt", "en-US", "global", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["remove-prompt", "en-US", "global", "0", "1", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["remove-confirm", "en-US", "global", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["remove-confirm", "en-US", "global", "0", "1", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["remove-cancel", "en-US", "global", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["remove-cancel", "en-US", "global", "0", "1", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["stm-clear", "en-US", "global"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["stm-clear", "en-US", "global", "0", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["retry", "en-US", "global"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["retry", "en-US", "global", "0", "extra"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["refresh", "en-US", "global"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["refresh", "en-US", "global", "0", "extra"],
      }),
    ).toBeNull();

    // Value validations
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["persona-select", "en-US", "global", "1"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["persona-select", "en-US", "persona", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["persona-select", "en-US", "persona", "-1"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["persona-select", "en-US", "persona", "abc"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["select", "en-US", "global", "-1"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["select", "en-US", "global", "0", "-1"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["select", "en-US", "global", "0", "abc"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["range", "en-US", "global", "0", "-1"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["range", "en-US", "global", "0", "abc"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["range-page", "en-US", "global", "0", "-1"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["range-page", "en-US", "global", "0", "abc"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["add-submit", "en-US", "global", "0", "short"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["add-submit", "en-US", "global", "0", "spaces in nonce"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["add-submit", "en-US", "global", "0", "a".repeat(33)],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["edit-open", "en-US", "global", "0", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["edit-open", "en-US", "global", "0", "-1"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["edit-open", "en-US", "global", "0", "abc"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["edit-submit", "en-US", "global", "0", "0", "12345678"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["edit-submit", "en-US", "global", "0", "1", "short"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["remove-prompt", "en-US", "global", "0", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["remove-confirm", "en-US", "global", "0", "0"],
      }),
    ).toBeNull();
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v1",
        segments: ["remove-cancel", "en-US", "global", "0", "0"],
      }),
    ).toBeNull();
  });

  it("asserts realistic maximum-length routes stay comfortably within Discord's 100-character custom ID ceiling", () => {
    const maxLocale = "zh-Hans";
    const maxNonce = "nonce1234567";
    const maxId = 2147483647;

    const maxRoutes: PersonalMemoriesPanelRoute[] = [
      { action: "category", locale: maxLocale, category: "persona" },
      { action: "persona-select", locale: maxLocale, category: "persona", lineageId: maxId },
      { action: "select", locale: maxLocale, category: "persona", lineageId: maxId, rangeIndex: maxId },
      { action: "range-open", locale: maxLocale, category: "persona", lineageId: maxId },
      { action: "range", locale: maxLocale, category: "persona", lineageId: maxId, rangeIndex: maxId },
      { action: "range-page", locale: maxLocale, category: "persona", lineageId: maxId, chooserPage: maxId },
      { action: "range-cancel", locale: maxLocale, category: "persona", lineageId: maxId },
      { action: "add-submit", locale: maxLocale, category: "persona", lineageId: maxId, nonce: maxNonce },
      { action: "edit-open", locale: maxLocale, category: "persona", lineageId: maxId, memoryId: maxId },
      {
        action: "edit-submit",
        locale: maxLocale,
        category: "persona",
        lineageId: maxId,
        memoryId: maxId,
        nonce: maxNonce,
      },
      { action: "remove-prompt", locale: maxLocale, category: "persona", lineageId: maxId, memoryId: maxId },
      { action: "remove-confirm", locale: maxLocale, category: "persona", lineageId: maxId, memoryId: maxId },
      { action: "remove-cancel", locale: maxLocale, category: "persona", lineageId: maxId, memoryId: maxId },
      { action: "stm-clear", locale: maxLocale, category: "persona", lineageId: maxId },
      { action: "retry", locale: maxLocale, category: "persona", lineageId: maxId },
      { action: "refresh", locale: maxLocale, category: "persona", lineageId: maxId },
    ];

    for (const route of maxRoutes) {
      const customId = buildPersonalMemoriesRouteId(route);
      expect(customId.length).toBeLessThanOrEqual(100);
    }
  });

  it("guards Discord's 100-character custom ID limit", () => {
    expect(() =>
      buildInteractionRouteId("personal-memories", "v1", "add-submit", "en-US", "global", "0", "x".repeat(90)),
    ).toThrow("exceeds 100");
  });
});

describe("owner scoping invariant", () => {
  it("edit operation with memoryId not in user scope performs no write and returns not-found", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalMemoriesInteractionRoute(dependencies);

    const nonce = "abcdef123456";
    const customId = buildPersonalMemoriesRouteId({
      action: "edit-submit",
      locale: "en-US",
      category: "global",
      lineageId: 0,
      memoryId: 999,
      nonce,
    });
    const parsed = requireRoute(customId);

    let deferred = false;
    let editReplyCalled = false;
    const interaction = {
      id: "interaction-1",
      customId,
      user: { id: "123456789", username: "testuser" },
      fields: {
        getTextInputValue: (fieldId: string) => {
          if (fieldId === buildPersonalMemoryModalFieldId("content", nonce)) return "New content";
          return "";
        },
      },
      isButton: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => true,
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {
        editReplyCalled = true;
      },
    } as unknown as ModalSubmitInteraction;

    await route.execute({} as Client, interaction, parsed);

    expect(deferred).toBeTrue();
    expect(editReplyCalled).toBeTrue();
    // Non-existent memory 999 was not edited, so no telemetry was recorded
    expect(telemetry).toBeEmpty();
    expect(calls.filter((c) => c.startsWith("edit:"))).toEqual(["edit:999"]);
  });

  it("remove operation with memoryId not in user scope performs no write and returns not-found", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalMemoriesInteractionRoute(dependencies);

    const customId = buildPersonalMemoriesRouteId({
      action: "remove-confirm",
      locale: "en-US",
      category: "global",
      lineageId: 0,
      memoryId: 999,
    });
    const parsed = requireRoute(customId);

    let deferred = false;
    let editReplyCalled = false;
    const interaction = {
      id: "interaction-2",
      customId,
      user: { id: "123456789", username: "testuser" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => {
        deferred = true;
      },
      editReply: async () => {
        editReplyCalled = true;
      },
    } as unknown as ButtonInteraction;

    await route.execute({} as Client, interaction, parsed);

    expect(deferred).toBeTrue();
    expect(editReplyCalled).toBeTrue();
    expect(telemetry).toBeEmpty();
    expect(calls.filter((c) => c.startsWith("remove:"))).toEqual(["remove:999"]);
  });
});

describe("privacy level asymmetry", () => {
  it("blocks add and edit under PrivacyLevel.FULL, while allowing remove and stm-clear", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls, {
      resolveScope: async () => ({
        userId: 1,
        userDiscId: "123456789",
        guildId: "987654321",
        workspaceId: "987654321",
        internalServerId: 42,
        privacyLevel: PrivacyLevel.FULL,
        personas: [makePersona(1, 10, "Tomori")],
        readStatus: "fresh",
      }),
    });
    const route = createPersonalMemoriesInteractionRoute(dependencies);

    let addBlockedReply = false;
    const addSelectInteraction = {
      id: "int-add-select",
      customId: buildPersonalMemoriesRouteId({ action: "select", locale: "en-US", category: "global", lineageId: 0 }),
      user: { id: "123456789", username: "testuser" },
      values: ["action:add"],
      isButton: () => false,
      isStringSelectMenu: () => true,
      isModalSubmit: () => false,
      reply: async () => {
        addBlockedReply = true;
      },
    } as unknown as StringSelectMenuInteraction;

    const addSelectParsed = requireRoute(addSelectInteraction.customId);
    await route.execute({} as Client, addSelectInteraction, addSelectParsed);
    expect(addBlockedReply).toBeTrue();
    expect(calls).not.toContain("showAddModal");

    let editBlockedReply = false;
    const editOpenInteraction = {
      id: "int-edit-open",
      customId: buildPersonalMemoriesRouteId({
        action: "edit-open",
        locale: "en-US",
        category: "global",
        lineageId: 0,
        memoryId: 1,
      }),
      user: { id: "123456789", username: "testuser" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      reply: async () => {
        editBlockedReply = true;
      },
    } as unknown as ButtonInteraction;

    const editOpenParsed = requireRoute(editOpenInteraction.customId);
    await route.execute({} as Client, editOpenInteraction, editOpenParsed);
    expect(editBlockedReply).toBeTrue();
    expect(calls).not.toContain("showEditModal");

    // Opting out of personalization must never strip the ability to delete data already stored.
    const removeInteraction = {
      id: "int-remove",
      customId: buildPersonalMemoriesRouteId({
        action: "remove-confirm",
        locale: "en-US",
        category: "global",
        lineageId: 0,
        memoryId: 1,
      }),
      user: { id: "123456789", username: "testuser" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    const removeParsed = requireRoute(removeInteraction.customId);
    await route.execute({} as Client, removeInteraction, removeParsed);
    expect(telemetry).toContain("personal-memories.personal.memory.remove");

    // Clearing is a deletion too, so the privacy opt-out does not gate it either.
    const stmClearInteraction = {
      id: "int-stm-clear",
      customId: buildPersonalMemoriesRouteId({
        action: "stm-clear",
        locale: "en-US",
        category: "global",
        lineageId: 0,
      }),
      user: { id: "123456789", username: "testuser" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      deferUpdate: async () => {},
      editReply: async () => {},
    } as unknown as ButtonInteraction;

    const stmClearParsed = requireRoute(stmClearInteraction.customId);
    await route.execute({} as Client, stmClearInteraction, stmClearParsed);
    expect(telemetry).toContain("personal-memories.personal.stm.clear");
  });
});

describe("telemetry & acknowledgement invariants", () => {
  it("acknowledges before every write and records telemetry on success only", async () => {
    const calls: string[] = [];
    let addAcknowledged = false;
    let editAcknowledged = false;
    let removeAcknowledged = false;
    let stmAcknowledged = false;

    let currentInteraction: { deferred: boolean; replied: boolean } = { deferred: false, replied: false };

    const { dependencies, telemetry } = makeDependencies(calls, {
      operations: {
        add: async (input) => {
          addAcknowledged = currentInteraction.deferred || currentInteraction.replied;
          return { status: "success", row: makeMemory(200, { content: input.content }) };
        },
        edit: async (input) => {
          editAcknowledged = currentInteraction.deferred || currentInteraction.replied;
          return { status: "success", row: makeMemory(input.memoryId, { content: input.content }) };
        },
        remove: async (input) => {
          removeAcknowledged = currentInteraction.deferred || currentInteraction.replied;
          return { status: "success", row: makeMemory(input.memoryId) };
        },
        clearStm: async () => {
          stmAcknowledged = currentInteraction.deferred || currentInteraction.replied;
        },
      },
    });

    const route = createPersonalMemoriesInteractionRoute(dependencies);

    // Test add-submit
    const nonce = "nonce1234567";
    const addInteraction = {
      id: "add-int",
      customId: buildPersonalMemoriesRouteId({
        action: "add-submit",
        locale: "en-US",
        category: "global",
        lineageId: 0,
        nonce,
      }),
      user: { id: "123456789", username: "testuser" },
      fields: {
        getTextInputValue: (fieldId: string) => {
          if (fieldId === buildPersonalMemoryModalFieldId("content", nonce)) return "New added memory";
          return "";
        },
      },
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
    currentInteraction = addInteraction;
    await route.execute(
      {} as Client,
      addInteraction as unknown as ModalSubmitInteraction,
      requireRoute(addInteraction.customId),
    );
    expect(addAcknowledged).toBeTrue();
    expect(telemetry).toContain("personal-memories.personal.memory.add");

    // Test edit-submit
    const editInteraction = {
      id: "edit-int",
      customId: buildPersonalMemoriesRouteId({
        action: "edit-submit",
        locale: "en-US",
        category: "global",
        lineageId: 0,
        memoryId: 1,
        nonce,
      }),
      user: { id: "123456789", username: "testuser" },
      fields: {
        getTextInputValue: (fieldId: string) => {
          if (fieldId === buildPersonalMemoryModalFieldId("content", nonce)) return "Updated memory";
          return "";
        },
      },
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
    currentInteraction = editInteraction;
    await route.execute(
      {} as Client,
      editInteraction as unknown as ModalSubmitInteraction,
      requireRoute(editInteraction.customId),
    );
    expect(editAcknowledged).toBeTrue();
    expect(telemetry).toContain("personal-memories.personal.memory.edit");

    // Test remove-confirm
    const removeInteraction = {
      id: "remove-int",
      customId: buildPersonalMemoriesRouteId({
        action: "remove-confirm",
        locale: "en-US",
        category: "global",
        lineageId: 0,
        memoryId: 1,
      }),
      user: { id: "123456789", username: "testuser" },
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
    currentInteraction = removeInteraction;
    await route.execute(
      {} as Client,
      removeInteraction as unknown as ButtonInteraction,
      requireRoute(removeInteraction.customId),
    );
    expect(removeAcknowledged).toBeTrue();
    expect(telemetry).toContain("personal-memories.personal.memory.remove");

    // Test stm-clear
    const stmInteraction = {
      id: "stm-int",
      customId: buildPersonalMemoriesRouteId({
        action: "stm-clear",
        locale: "en-US",
        category: "global",
        lineageId: 0,
      }),
      user: { id: "123456789", username: "testuser" },
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
    currentInteraction = stmInteraction;
    await route.execute(
      {} as Client,
      stmInteraction as unknown as ButtonInteraction,
      requireRoute(stmInteraction.customId),
    );
    expect(stmAcknowledged).toBeTrue();
    expect(telemetry).toContain("personal-memories.personal.stm.clear");
  });
});

describe("memory selector pagination & 25-option ceiling", () => {
  it("caps single page options at 25 (1 Add option + 24 memories) even with 100 memories", () => {
    const hundredMemories: PersonalMemoryRow[] = Array.from({ length: 100 }, (_, i) =>
      makeMemory(i + 1, { persona_lineage_id: 0, content: `Memory number ${i + 1}` }),
    );

    const payload = buildPersonalMemoriesPanelPayload({
      locale: "en-US",
      category: "global",
      selectedLineageId: 0,
      personas: [],
      memories: hundredMemories,
      stmCount: 0,
      privacyLevel: PrivacyLevel.MINIMAL,
      readStatus: "fresh",
      page: { kind: "main" },
    });

    const rootContainer = payload.components[0] as unknown as {
      components: ActionRowData<StringSelectMenuComponentData>[];
    };
    const selectActionRow = rootContainer.components.find((c) => c.type === 1 && c.components?.[0]?.type === 3);

    expect(selectActionRow).toBeDefined();
    const selectMenu = selectActionRow?.components[0];
    // 1 Add option + 24 memories = exactly 25 options
    expect(selectMenu?.options?.length).toBe(25);
    expect(selectMenu?.options?.[0]?.value).toBe("action:add");
    expect(selectMenu?.options?.[1]?.value).toBe("1");
    expect(selectMenu?.options?.[24]?.value).toBe("24");
  });
});

describe("persona selector lineage identity", () => {
  function buildPersonaPage(
    personas: TomoriState[],
    memoryCountsByLineage?: Map<number, number>,
    selectedPersonaAvatarUrl?: string | null,
  ) {
    return buildPersonalMemoriesPanelPayload({
      locale: "en-US",
      category: "persona",
      selectedLineageId: personas[0]?.persona_lineage_id ?? 0,
      personas,
      memoryCountsByLineage,
      selectedPersonaAvatarUrl,
      memories: [],
      stmCount: 0,
      privacyLevel: PrivacyLevel.MINIMAL,
      readStatus: "fresh",
      page: { kind: "main" },
    });
  }

  function personaSelect(payload: unknown) {
    return collectSelects(payload).find((select) => select.customId?.includes(":persona-select:"));
  }

  it("emits one option per lineage when two personas share one", () => {
    // A preset-derived persona keeps its ancestor's lineage, so two personas in one guild can share
    // a memory scope. Discord rejects the whole payload if that repeats an option value.
    const payload = buildPersonaPage([
      makePersona(51, 1770, "Timori", true),
      makePersona(55, 1770, "Aphel"),
      makePersona(39, 3585, "Tomori", true),
      makePersona(50, 3585, "Lilya", true),
      makePersona(60, 10010, "Sparrow"),
    ]);

    const select = personaSelect(payload);
    expect(select).toBeDefined();
    const values = select?.options?.map((option) => option.value) ?? [];
    expect(values).toEqual(["1770", "3585", "10010"]);
    expect(new Set(values).size).toBe(values.length);

    // The non-alter member names the shared scope; an all-alter lineage falls back to its first.
    expect(select?.options?.map((option) => option.label)).toEqual(["Aphel", "Tomori", "Sparrow"]);
  });

  it("describes each lineage by its memory count, singular and shared included", () => {
    const personas = [
      makePersona(51, 1770, "Timori", true),
      makePersona(55, 1770, "Aphel"),
      makePersona(60, 10010, "Sparrow"),
      makePersona(61, 10011, "Wren"),
    ];
    const payload = buildPersonaPage(
      personas,
      new Map([
        [1770, 3],
        [10010, 1],
      ]),
    );

    // 10011 is absent from the map rather than zero: a lineage with no memories is never returned
    // by the grouped query, so an absent entry has to read as none rather than as unknown.
    expect(personaSelect(payload)?.options?.map((option) => option.description)).toEqual([
      "3 memories, shared across 2 personas",
      "1 memory",
      "0 memories",
    ]);
  });

  it("pins the selected persona's avatar to the heading, and drops the Section when unfetchable", () => {
    const personas = [makePersona(51, 1770, "Timori", true), makePersona(55, 1770, "Aphel")];

    const withAvatar = JSON.stringify(buildPersonaPage(personas, undefined, "https://cdn.example.invalid/55.png"));
    // Type 9 is Section and 11 is Thumbnail: the heading has to become a Section to host one.
    expect(withAvatar).toContain('"type":9');
    expect(withAvatar).toContain('"type":11');
    expect(withAvatar).toContain("https://cdn.example.invalid/55.png");

    // A local-path or data-URI avatar resolves to null, and a Thumbnail cannot load either.
    const withoutAvatar = JSON.stringify(buildPersonaPage(personas, undefined, null));
    expect(withoutAvatar).not.toContain('"type":11');
    expect(withoutAvatar).toContain("Persona-Scoped Personal Memories");
  });

  it("caps the selector at 25 lineages and says how many are hidden", () => {
    const personas = Array.from({ length: 30 }, (_, index) => makePersona(index + 1, 20000 + index, `P${index}`));
    const payload = buildPersonaPage(personas);

    const select = personaSelect(payload);
    expect(select?.options).toHaveLength(25);
    expect(JSON.stringify(payload)).toContain("5 more personas are not listed here.");
  });
});

describe("router wiring & outdated version fallback", () => {
  it("dispatches through dispatchGlobalInteraction and handles outdated version", async () => {
    let replyPayload: InteractionReplyOptions | null = null;
    const staleInteraction = {
      id: "stale-int",
      customId: `personal-memories:v0:select:en-US:global:0`,
      locale: "en-US",
      user: { id: "123" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      reply: async (payload: InteractionReplyOptions) => {
        replyPayload = payload;
      },
    };

    const handled = await dispatchGlobalInteraction({} as Client, staleInteraction as unknown as ButtonInteraction);
    expect(handled).toBeTrue();
    expect(replyPayload).toBeDefined();
    expect(replyPayload?.content).toContain("/personal memories");
  });
});

// The suite above drives the route layer against a mocked `operations` object that reimplements the
// guards, so it would pass unchanged if the real ones were deleted. These exercise the exported
// singleton itself, which is where owner scoping and the privacy asymmetry actually live.
describe("personalMemoriesOperations enforces its own guards", () => {
  const scopedInput = { userId: 1, userDiscId: "123456789", personaLineageId: 0 };

  it("refuses to edit or remove an id absent from the caller's own freshly loaded scope", async () => {
    const loadSpy = spyOn(personalMemoryRepository, "loadForUserLineage").mockResolvedValue([
      makeMemory(1, { user_id: 1, persona_lineage_id: 0 }),
    ]);
    const editSpy = spyOn(personalMemoryRepository, "edit").mockResolvedValue(true);
    const removeSpy = spyOn(personalMemoryRepository, "remove").mockResolvedValue(true);
    const privacySpy = spyOn(userRepository, "getPrivacyLevel").mockResolvedValue(PrivacyLevel.MINIMAL);

    try {
      const edited = await personalMemoriesOperations.edit({
        ...scopedInput,
        memoryId: 999,
        content: "someone else's memory",
        tags: [],
      });
      const removed = await personalMemoriesOperations.remove({ ...scopedInput, memoryId: 999 });

      expect(edited.status).toBe("not-found");
      expect(removed.status).toBe("not-found");
      // The write, not the reply text, is the invariant: a partial write is as bad as a full one.
      expect(editSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
      expect(loadSpy).toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
      editSpy.mockRestore();
      removeSpy.mockRestore();
      privacySpy.mockRestore();
    }
  });

  it("blocks add and edit at PrivacyLevel.FULL while still permitting remove", async () => {
    const privacySpy = spyOn(userRepository, "getPrivacyLevel").mockResolvedValue(PrivacyLevel.FULL);
    const loadSpy = spyOn(personalMemoryRepository, "loadForUserLineage").mockResolvedValue([
      makeMemory(1, { user_id: 1, persona_lineage_id: 0 }),
    ]);
    const addSpy = spyOn(personalMemoryRepository, "add").mockResolvedValue(makeMemory(2));
    const editSpy = spyOn(personalMemoryRepository, "edit").mockResolvedValue(true);
    const removeSpy = spyOn(personalMemoryRepository, "remove").mockResolvedValue(true);

    try {
      const added = await personalMemoriesOperations.add({ ...scopedInput, content: "new", tags: [] });
      const edited = await personalMemoriesOperations.edit({
        ...scopedInput,
        memoryId: 1,
        content: "changed",
        tags: [],
      });
      const removed = await personalMemoriesOperations.remove({ ...scopedInput, memoryId: 1 });

      expect(added.status).toBe("privacy-blocked");
      expect(edited.status).toBe("privacy-blocked");
      expect(addSpy).not.toHaveBeenCalled();
      expect(editSpy).not.toHaveBeenCalled();
      // Opting out of personalization must never strip the ability to delete data already stored.
      expect(removed.status).toBe("success");
      expect(removeSpy).toHaveBeenCalled();
    } finally {
      privacySpy.mockRestore();
      loadSpy.mockRestore();
      addSpy.mockRestore();
      editSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});

// `receipt()` composes its locale keys as `${key}_heading` / `${key}_detail`, which the
// `check-locales` scanner cannot see because it only matches literal dot-notation strings. A
// missing half therefore renders the raw key to the user with every gate green, which is exactly
// how `privacy_blocked_error_heading` shipped absent. Re-derive the keys from source instead of
// listing them here, so a key added later is covered without anyone remembering to update this.
describe("receipt locale keys resolve", () => {
  it("has a heading and a detail for every key passed to receipt()", async () => {
    const source = await Bun.file("src/utils/discord/interactions/personalMemoriesRoutes.ts").text();
    const keys = new Set([
      // Keys passed to receipt() as literals.
      ...[...source.matchAll(/receipt\(\s*(?:route\.)?locale\s*,\s*"([a-z0-9_]+)"/g)].map((m) => m[1] as string),
      // Keys reached only through a receiptByStatus lookup, which is where the shipped gap was.
      ...[...source.matchAll(/^\s*"[a-z-]+":\s*"([a-z0-9_]+)",$/gm)].map((m) => m[1] as string),
      // Keys enumerated for tone selection, scoped to that declaration so unrelated string
      // literals elsewhere in the file are not mistaken for receipt keys.
      ...[
        ...(source.match(/ERROR_RECEIPT_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "").matchAll(/"([a-z0-9_]+)"/g),
      ].map((m) => m[1] as string),
    ]);
    // A regex that silently matches nothing would make this test vacuous.
    expect(keys.has("privacy_blocked_error")).toBeTrue();
    expect(keys.size).toBeGreaterThan(7);

    for (const key of keys) {
      for (const suffix of ["heading", "detail"]) {
        const localeKey = `commands.personal.memories.${key}_${suffix}`;
        expect(localizer("en-US", localeKey)).not.toBe(localeKey);
      }
    }
  });
});

// The batch path exists so that dissolving `memory personal add` does not remove the ability to
// author many memories in a text editor and upload them. Wave 7's import reads a JSON export, so it
// is round-trip transfer rather than authoring and does not replace this.
describe("Add Memory batch upload", () => {
  function makeAddInteraction(nonce: string, typedContent: string) {
    return {
      id: "batch-int",
      customId: buildPersonalMemoriesRouteId({
        action: "add-submit",
        locale: "en-US",
        category: "global",
        lineageId: 0,
        nonce,
      }),
      user: { id: "123456789", username: "testuser" },
      fields: {
        getTextInputValue: (fieldId: string) => {
          if (fieldId === buildPersonalMemoryModalFieldId("content", nonce)) return typedContent;
          return "";
        },
      },
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
  }

  it("routes an uploaded txt to addBatch and leaves the single insert untouched without one", async () => {
    const nonce = "nonce1234567";

    const noFileCalls: string[] = [];
    const { dependencies: noFileDeps } = makeDependencies(noFileCalls);
    const noFileRoute = createPersonalMemoriesInteractionRoute(noFileDeps);
    const noFileInteraction = makeAddInteraction(nonce, "A single typed memory");
    await noFileRoute.execute(
      {} as Client,
      noFileInteraction as unknown as ModalSubmitInteraction,
      requireRoute(noFileInteraction.customId),
    );
    expect(noFileCalls).toContain("add:A single typed memory");
    expect(noFileCalls.some((entry) => entry.startsWith("addBatch:"))).toBeFalse();

    const fileCalls: string[] = [];
    const { dependencies: fileDeps } = makeDependencies(fileCalls, {
      takeFileUpload: () =>
        ({
          id: "1",
          filename: "memories.txt",
          size: 64,
          url: "https://cdn.example/memories.txt",
          proxy_url: "https://cdn.example/memories.txt",
          content_type: "text/plain",
        }) as unknown as APIAttachment,
    });
    const fileRoute = createPersonalMemoriesInteractionRoute(fileDeps);
    const fileInteraction = makeAddInteraction(nonce, "A single typed memory");
    await fileRoute.execute(
      {} as Client,
      fileInteraction as unknown as ModalSubmitInteraction,
      requireRoute(fileInteraction.customId),
    );
    expect(fileCalls.some((entry) => entry.startsWith("addBatch:"))).toBeTrue();
    expect(fileCalls).not.toContain("add:A single typed memory");
  });

  it("exposes an optional file upload of raw component type 19 on the Add Memory modal", () => {
    const nonce = "nonce1234567";
    const modal = buildAddPersonalMemoryModal("en-US", "global", 0, nonce);
    const fileWrapper = modal.components.find(
      (component) =>
        (component as { component?: { custom_id?: string } }).component?.custom_id ===
        buildPersonalMemoryModalFieldId("file", nonce),
    ) as { component: { type: number; required: boolean; min_values: number; max_values: number } } | undefined;

    expect(fileWrapper).toBeDefined();
    // 19 is FileUpload. 22 is CheckboxGroup and 3 is StringSelect, and Discord renders any of them
    // without complaint, so pinning the number is the only thing that catches a wrong one.
    expect(fileWrapper?.component.type).toBe(19);
    expect(fileWrapper?.component.required).toBeFalse();
    expect(fileWrapper?.component.min_values).toBe(0);
    expect(fileWrapper?.component.max_values).toBe(1);

    const contentWrapper = modal.components.find(
      (component) =>
        (component as { component?: { custom_id?: string } }).component?.custom_id ===
        buildPersonalMemoryModalFieldId("content", nonce),
    ) as { component: { required: boolean } } | undefined;
    // Optional so a file alone is a valid submission; the handler rejects both being empty.
    expect(contentWrapper?.component.required).toBeFalse();
  });
});
