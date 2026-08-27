import { beforeAll, describe, expect, it, spyOn } from "bun:test";
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
import {
  buildPersonalMemoriesCustomId,
  parsePersonalMemoriesPanelRoute,
  PERSONAL_MEMORIES_ROUTE_NAMESPACE,
  PERSONAL_MEMORIES_ROUTE_VERSION,
} from "@/utils/discord/personalMemoriesPanelCatalog";
import { parseInteractionRoute, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { dispatchGlobalInteraction } from "@/utils/discord/interactions/router";
import {
  buildPersonalMemoryModalFieldId,
  buildPersonalMemoriesPanelPayload,
} from "@/utils/discord/ui/personalMemoriesPanel";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

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

function makePersona(id: number, lineageId: number, name: string): TomoriState {
  return {
    persona_id: id,
    persona_lineage_id: lineageId,
    persona_nickname: name,
    is_alter: false,
    is_active: true,
  } as unknown as TomoriState;
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
    ...overrides,
  };

  return { dependencies, memories, telemetry };
}

describe("personal-memories panel route catalog", () => {
  it("round trips valid state custom IDs", () => {
    const parsedCategory = parsePersonalMemoriesPanelRoute({
      namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
      version: PERSONAL_MEMORIES_ROUTE_VERSION,
      segments: ["category", "en-US", "global"],
    });
    expect(parsedCategory).toEqual({ action: "category", locale: "en-US", category: "global" });

    const parsedPersonaSelect = parsePersonalMemoriesPanelRoute({
      namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
      version: PERSONAL_MEMORIES_ROUTE_VERSION,
      segments: ["persona-select", "en-US", "persona", "10"],
    });
    expect(parsedPersonaSelect).toEqual({
      action: "persona-select",
      locale: "en-US",
      category: "persona",
      lineageId: 10,
    });

    const parsedSelect = parsePersonalMemoriesPanelRoute({
      namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
      version: PERSONAL_MEMORIES_ROUTE_VERSION,
      segments: ["select", "en-US", "global", "0", "1"],
    });
    expect(parsedSelect).toEqual({
      action: "select",
      locale: "en-US",
      category: "global",
      lineageId: 0,
      rangeIndex: 1,
    });

    const parsedAddSubmit = parsePersonalMemoriesPanelRoute({
      namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
      version: PERSONAL_MEMORIES_ROUTE_VERSION,
      segments: ["add-submit", "en-US", "global", "0", "abcdef123456"],
    });
    expect(parsedAddSubmit).toEqual({
      action: "add-submit",
      locale: "en-US",
      category: "global",
      lineageId: 0,
      nonce: "abcdef123456",
    });

    const parsedEditSubmit = parsePersonalMemoriesPanelRoute({
      namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
      version: PERSONAL_MEMORIES_ROUTE_VERSION,
      segments: ["edit-submit", "en-US", "persona", "10", "42", "abcdef123456"],
    });
    expect(parsedEditSubmit).toEqual({
      action: "edit-submit",
      locale: "en-US",
      category: "persona",
      lineageId: 10,
      memoryId: 42,
      nonce: "abcdef123456",
    });

    const parsedRemoveConfirm = parsePersonalMemoriesPanelRoute({
      namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
      version: PERSONAL_MEMORIES_ROUTE_VERSION,
      segments: ["remove-confirm", "en-US", "global", "0", "42"],
    });
    expect(parsedRemoveConfirm).toEqual({
      action: "remove-confirm",
      locale: "en-US",
      category: "global",
      lineageId: 0,
      memoryId: 42,
    });

    const parsedStmClear = parsePersonalMemoriesPanelRoute({
      namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
      version: PERSONAL_MEMORIES_ROUTE_VERSION,
      segments: ["stm-clear", "en-US", "global", "0"],
    });
    expect(parsedStmClear).toEqual({
      action: "stm-clear",
      locale: "en-US",
      category: "global",
      lineageId: 0,
    });
  });

  it("rejects malformed custom IDs, missing segments, and invalid nonces", () => {
    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: "other",
        version: "v1",
        segments: ["stm-clear", "en-US", "global", "0"],
      }),
    ).toBeNull();

    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: "v2",
        segments: ["stm-clear", "en-US", "global", "0"],
      }),
    ).toBeNull();

    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: PERSONAL_MEMORIES_ROUTE_VERSION,
        segments: ["add-submit", "en-US", "global", "0", "short"],
      }),
    ).toBeNull();

    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: PERSONAL_MEMORIES_ROUTE_VERSION,
        segments: ["remove-confirm", "en-US", "global", "0", "0"],
      }),
    ).toBeNull();

    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: PERSONAL_MEMORIES_ROUTE_VERSION,
        segments: ["persona-select", "en-US", "persona", "0"],
      }),
    ).toBeNull();

    expect(
      parsePersonalMemoriesPanelRoute({
        namespace: PERSONAL_MEMORIES_ROUTE_NAMESPACE,
        version: PERSONAL_MEMORIES_ROUTE_VERSION,
        segments: ["unknown", "en-US", "global", "0"],
      }),
    ).toBeNull();
  });
});

describe("owner scoping invariant", () => {
  it("edit operation with memoryId not in user scope performs no write and returns not-found", async () => {
    const calls: string[] = [];
    const { dependencies, telemetry } = makeDependencies(calls);
    const route = createPersonalMemoriesInteractionRoute(dependencies);

    const nonce = "abcdef123456";
    const customId = buildPersonalMemoriesCustomId("edit-submit", "en-US", "global", 0, 999, nonce);
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

    const customId = buildPersonalMemoriesCustomId("remove-confirm", "en-US", "global", 0, 999);
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
      customId: buildPersonalMemoriesCustomId("select", "en-US", "global", 0),
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
      customId: buildPersonalMemoriesCustomId("edit-open", "en-US", "global", 0, 1),
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
      customId: buildPersonalMemoriesCustomId("remove-confirm", "en-US", "global", 0, 1),
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
      customId: buildPersonalMemoriesCustomId("stm-clear", "en-US", "global", 0),
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
      customId: buildPersonalMemoriesCustomId("add-submit", "en-US", "global", 0, nonce),
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
      customId: buildPersonalMemoriesCustomId("edit-submit", "en-US", "global", 0, 1, nonce),
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
      customId: buildPersonalMemoriesCustomId("remove-confirm", "en-US", "global", 0, 1),
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
      customId: buildPersonalMemoriesCustomId("stm-clear", "en-US", "global", 0),
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
