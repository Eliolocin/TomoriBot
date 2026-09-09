/**
 * /model override remove aggregate view tests
 * Retained aggregate destructive command browsing channel and persona overrides together.
 */
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { ButtonStyle, type ButtonInteraction, type Client, type ModalSubmitInteraction } from "discord.js";
import { execute as executeOverrideRemove } from "@/commands/model/override/remove";
import * as tomoriStateCache from "@/utils/cache/tomoriStateCache";
import { llmOverrideRepo } from "@/utils/db/repositories";
import * as modalModule from "@/utils/discord/ui/modals";
import type { LlmRow, TomoriState, UserRow } from "@/types/db/schema";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { dispatchGlobalInteraction } from "@/utils/discord/interactions/router";
import {
  buildModelOverrideRouteId,
  computeModelOverrideBatchFingerprint,
  formatModelOverrideModelSummary,
  parseModelOverridePanelRoute,
  sortModelOverrideEntries,
  type ChannelOverrideEntry,
  type ModelOverrideEntry,
  type ModelOverridePanelRoute,
  type PersonaOverrideEntry,
} from "@/utils/discord/modelOverrideCatalog";
import {
  MODEL_OVERRIDE_PAGE_SELECT_MAX_BUTTONS,
  MODEL_OVERRIDE_PAGE_SELECT_MAX_ENTRIES,
  buildModelOverridePageSelectRows,
  buildModelOverrideRemoveModal,
} from "@/utils/discord/ui/modelOverridePanel";
import {
  createModelOverrideInteractionRoute,
  modelOverrideInteractionRoute,
  type ModelOverrideRouteDependencies,
} from "@/utils/discord/interactions/modelOverrideRoutes";
import {
  setTextModelOverride,
  type TextModelOverrideInput,
} from "@/utils/discord/interactions/textModelOverrideOperations";
import * as channelLlmCacheStore from "@/utils/cache/channelLlmCacheStore";
import * as tomoriStateCacheStore from "@/utils/cache/tomoriStateCacheStore";

beforeAll(async () => initializeLocalizer());

const CLIENT = {} as Client;

const LLM_A: LlmRow = {
  llm_id: 7,
  llm_provider: "google",
  llm_codename: "gemini-2.5-flash",
} as unknown as LlmRow;

function makePersona(overrides: Partial<TomoriState>): TomoriState {
  return {
    server_id: 9,
    persona_id: 55,
    persona_nickname: "Sparrow",
    persona_lineage_id: 101,
    config: {},
    ...overrides,
  } as unknown as TomoriState;
}

function makeChannelEntry(channelDiscId: string, llm: LlmRow = LLM_A): ChannelOverrideEntry {
  return {
    scope: "channel",
    channelDiscId,
    llm,
  };
}

function makePersonaEntry(
  persona_id: number,
  persona_nickname: string,
  persona_llm: LlmRow = LLM_A,
): PersonaOverrideEntry {
  return {
    scope: "persona",
    persona_id,
    persona_nickname,
    persona_llm,
  };
}

interface MockInteractionOptions {
  guildId?: string | null;
  hasPermission?: boolean;
  isButton?: boolean;
  isModalSubmit?: boolean;
}

function createMockInteraction(customId: string, options: MockInteractionOptions = {}) {
  const { guildId = "guild-1", hasPermission = true, isButton = true, isModalSubmit = false } = options;
  let repliedPayload: unknown = null;
  let editedReply: unknown = null;
  let deferredUpdate = false;
  let deferredReply = false;

  const interaction = {
    id: "interaction-1",
    customId,
    guildId,
    guild: guildId
      ? {
          id: guildId,
          channels: {
            cache: {
              get: (id: string) =>
                id === "channel-1"
                  ? { name: "general", isTextBased: () => true }
                  : id === "channel-2"
                    ? { name: "voice-chat", isTextBased: () => false }
                    : undefined,
            },
          },
        }
      : null,
    user: { id: "user-1" },
    memberPermissions: guildId
      ? {
          has: (perm: string) => hasPermission && (perm === "ManageGuild" || perm === "32"),
        }
      : null,
    deferred: false,
    replied: false,
    isButton: () => isButton,
    isModalSubmit: () => isModalSubmit,
    isStringSelectMenu: () => false,
    isMessageComponent: () => isButton,
    reply: async (payload: unknown) => {
      repliedPayload = payload;
      interaction.replied = true;
      return payload;
    },
    deferUpdate: async () => {
      deferredUpdate = true;
      interaction.deferred = true;
    },
    deferReply: async () => {
      deferredReply = true;
      interaction.deferred = true;
    },
    editReply: async (payload: unknown) => {
      editedReply = payload;
      return payload;
    },
    followUp: async () => undefined,
    getRepliedPayload: () => repliedPayload,
    getEditedReply: () => editedReply,
    wasDeferredUpdate: () => deferredUpdate,
    wasDeferredReply: () => deferredReply,
  };

  return interaction;
}

function parseRouteOrThrow(customId: string) {
  const parsed = parseInteractionRoute(customId);
  if (!parsed) throw new Error(`Route parse failed: ${customId}`);
  return parsed;
}

describe("/model override remove - (1) route codecs and IDs", () => {
  it("round-trips page and remove-submit routes through codec encode and decode", () => {
    const routes: ModelOverridePanelRoute[] = [
      { action: "page", locale: "en-US", page: 0 },
      { action: "page", locale: "en-US", page: 24 },
      { action: "remove-submit", locale: "en-US", page: 0, fp: "aB9_-xY1", nonce: "nonce-12345678" },
      { action: "remove-submit", locale: "en-US", page: 12, fp: "ZZ99__aa", nonce: "n1234567" },
    ];

    for (const route of routes) {
      const customId = buildModelOverrideRouteId(route);
      const parsed = parseInteractionRoute(customId);
      expect(parsed).not.toBeNull();
      if (!parsed) throw new Error("Expected parsed interaction route");
      expect(parseModelOverridePanelRoute(parsed)).toEqual(route);
    }
  });

  it("rejects routes with foreign namespace, bumped version, or invalid segments", () => {
    expect(
      parseModelOverridePanelRoute({ namespace: "other", version: "v1", segments: ["page", "en-US", "0"] }),
    ).toBeNull();
    expect(
      parseModelOverridePanelRoute({ namespace: "model-overrides", version: "v2", segments: ["page", "en-US", "0"] }),
    ).toBeNull();
    expect(
      parseModelOverridePanelRoute({
        namespace: "model-overrides",
        version: "v1",
        segments: ["page", "invalid-locale", "0"],
      }),
    ).toBeNull();
    expect(
      parseModelOverridePanelRoute({ namespace: "model-overrides", version: "v1", segments: ["page", "en-US", "-1"] }),
    ).toBeNull();
    expect(
      parseModelOverridePanelRoute({
        namespace: "model-overrides",
        version: "v1",
        segments: ["remove-submit", "en-US", "0", "short"],
      }),
    ).toBeNull();
    expect(
      parseModelOverridePanelRoute({
        namespace: "model-overrides",
        version: "v1",
        segments: ["remove-submit", "en-US", "0", "aB9_-xY1", "short"],
      }),
    ).toBeNull();
    expect(
      parseModelOverridePanelRoute({
        namespace: "model-overrides",
        version: "v1",
        segments: ["unknown-action", "en-US"],
      }),
    ).toBeNull();
  });

  it("keeps the longest realistic route ID strictly under the 100 character limit", () => {
    const route: ModelOverridePanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 99999,
      fp: "aB9_-xY1",
      nonce: "a".repeat(32),
    };
    const customId = buildModelOverrideRouteId(route);
    expect(customId.length).toBeLessThan(100);
  });
});

describe("/model override remove - (2) literal wire types and defaults", () => {
  it("pins wrapper type 18 and nested CheckboxGroup type 22 with default true", () => {
    const channel = makeChannelEntry("channel-1");
    const persona = makePersonaEntry(55, "Sparrow");
    const modal = buildModelOverrideRemoveModal("en-US", 0, "abcd1234", "nonce123", [channel, persona]);

    // Discord component types are bare wire integers. Type 19 is FileUpload and is destructive
    // because it supplies no values on submit. Each wrapper must pin type 18 and component type 22.
    expect(modal.components.length).toBeGreaterThan(0);
    for (const wrapper of modal.components) {
      expect(wrapper.type).toBe(18);
      const inner = wrapper.component as { type: number; options: Array<{ default?: boolean }> };
      expect(inner.type).toBe(22);
      expect(inner.options.length).toBeGreaterThan(0);
      for (const option of inner.options) {
        expect(option.default).toBe(true);
      }
    }
  });
});

describe("/model override remove - (3) page buttons and five-row ceiling", () => {
  it("builds secondary page select buttons in 50-entry ranges", () => {
    const rows = buildModelOverridePageSelectRows("en-US", 125);
    expect(rows).toHaveLength(1);
    expect(rows[0].components).toHaveLength(3);
    expect(rows[0].components[0].label).toBe("1-50");
    expect(rows[0].components[1].label).toBe("51-100");
    expect(rows[0].components[2].label).toBe("101-125");
    expect(rows[0].components[0].style).toBe(ButtonStyle.Secondary);
    expect(rows[0].components[1].style).toBe(ButtonStyle.Secondary);
    expect(rows[0].components[2].style).toBe(ButtonStyle.Secondary);
  });

  it("never exceeds 5 action rows and 25 buttons (1,250 displayed entries ceiling)", () => {
    const rows = buildModelOverridePageSelectRows("en-US", 3000);
    expect(rows.length).toBeLessThanOrEqual(5);
    const buttons = rows.flatMap((row) => row.components);
    expect(buttons).toHaveLength(MODEL_OVERRIDE_PAGE_SELECT_MAX_BUTTONS);
    expect(MODEL_OVERRIDE_PAGE_SELECT_MAX_BUTTONS).toBe(25);
    expect(MODEL_OVERRIDE_PAGE_SELECT_MAX_ENTRIES).toBe(1250);
    for (const row of rows) {
      expect(row.components.length).toBeLessThanOrEqual(5);
    }
  });
});

describe("/model override remove - (4) slash command <=50 direct modal vs >50 page-select", () => {
  it("opens routed raw modal directly at <=50 entries with no intermediate reply/defer", async () => {
    const stateSpy = spyOn(tomoriStateCache, "getCachedTomoriState").mockResolvedValue(
      makePersona({}) as Awaited<ReturnType<typeof tomoriStateCache.getCachedTomoriState>>,
    );
    const personasSpy = spyOn(tomoriStateCache, "getCachedAllPersonas").mockResolvedValue([
      makePersona({ persona_id: 55, persona_nickname: "Sparrow", persona_llm: LLM_A }),
    ] as unknown as Awaited<ReturnType<typeof tomoriStateCache.getCachedAllPersonas>>);
    const channelSpy = spyOn(llmOverrideRepo, "getAllChannelLlmOverridesForServer").mockResolvedValue([
      { channelDiscId: "channel-1", llm: LLM_A },
    ]);

    let modalShown = false;
    let modalCustomId: string | undefined;
    const showModalSpy = spyOn(modalModule, "showRoutedRawModal").mockImplementation(async (_interaction, payload) => {
      modalShown = true;
      modalCustomId = payload.custom_id;
    });

    const interaction = createMockInteraction("cmd", { isButton: false });
    await executeOverrideRemove(
      CLIENT,
      interaction as unknown as Parameters<typeof executeOverrideRemove>[1],
      {} as UserRow,
      "en-US",
    );

    expect(modalShown).toBe(true);
    expect(modalCustomId).toBeDefined();
    expect(modalCustomId?.startsWith("model-overrides:v1:remove-submit:")).toBe(true);
    // First and only acknowledgment: no intermediate reply or deferral
    expect(interaction.replied).toBe(false);
    expect(interaction.deferred).toBe(false);

    showModalSpy.mockRestore();
    channelSpy.mockRestore();
    personasSpy.mockRestore();
    stateSpy.mockRestore();
  });

  it("sends ephemeral page-select message at >50 entries without opening modal", async () => {
    const stateSpy = spyOn(tomoriStateCache, "getCachedTomoriState").mockResolvedValue(
      makePersona({}) as Awaited<ReturnType<typeof tomoriStateCache.getCachedTomoriState>>,
    );
    // 55 channels: exceeds 50 modal capacity
    const channels = Array.from({ length: 55 }, (_, i) => ({
      channelDiscId: `channel-${String(i).padStart(3, "0")}`,
      llm: LLM_A,
    }));
    const personasSpy = spyOn(tomoriStateCache, "getCachedAllPersonas").mockResolvedValue(
      [] as unknown as Awaited<ReturnType<typeof tomoriStateCache.getCachedAllPersonas>>,
    );
    const channelSpy = spyOn(llmOverrideRepo, "getAllChannelLlmOverridesForServer").mockResolvedValue(channels);

    let modalShown = false;
    const showModalSpy = spyOn(modalModule, "showRoutedRawModal").mockImplementation(async () => {
      modalShown = true;
    });

    const interaction = createMockInteraction("cmd", { isButton: false });
    await executeOverrideRemove(
      CLIENT,
      interaction as unknown as Parameters<typeof executeOverrideRemove>[1],
      {} as UserRow,
      "en-US",
    );

    expect(modalShown).toBe(false);
    expect(interaction.replied).toBe(true);
    const replyPayload = interaction.getRepliedPayload() as { content: string; components: unknown[]; flags: number };
    expect(replyPayload.flags).toBe(64); // Ephemeral
    expect(replyPayload.components).toBeDefined();
    expect(replyPayload.content).toContain(
      localizer("en-US", "commands.model.override.remove.page_select_prompt", { total: "55" }),
    );

    showModalSpy.mockRestore();
    channelSpy.mockRestore();
    personasSpy.mockRestore();
    stateSpy.mockRestore();
  });

  it("shows capped localized prompt above 1,250 entries", async () => {
    const stateSpy = spyOn(tomoriStateCache, "getCachedTomoriState").mockResolvedValue(
      makePersona({}) as Awaited<ReturnType<typeof tomoriStateCache.getCachedTomoriState>>,
    );
    const channels = Array.from({ length: 1300 }, (_, i) => ({
      channelDiscId: `ch-${i}`,
      llm: LLM_A,
    }));
    const personasSpy = spyOn(tomoriStateCache, "getCachedAllPersonas").mockResolvedValue(
      [] as unknown as Awaited<ReturnType<typeof tomoriStateCache.getCachedAllPersonas>>,
    );
    const channelSpy = spyOn(llmOverrideRepo, "getAllChannelLlmOverridesForServer").mockResolvedValue(channels);

    const interaction = createMockInteraction("cmd", { isButton: false });
    await executeOverrideRemove(
      CLIENT,
      interaction as unknown as Parameters<typeof executeOverrideRemove>[1],
      {} as UserRow,
      "en-US",
    );

    expect(interaction.replied).toBe(true);
    const replyPayload = interaction.getRepliedPayload() as { content: string };
    expect(replyPayload.content).toContain(
      localizer("en-US", "commands.model.override.remove.page_select_prompt_capped", {
        total: "1300",
        shown: "1250",
      }),
    );

    channelSpy.mockRestore();
    personasSpy.mockRestore();
    stateSpy.mockRestore();
  });
});

describe("/model override remove - (5) route button opens requested batch without defer", () => {
  it("opens requested batch modal directly without deferUpdate when button is clicked", async () => {
    let modalShown = false;
    let presentedBatchLength = 0;
    let presentedPage = -1;

    // 60 total entries: batch 1 has entries 50..59 (10 entries)
    const allEntries: ModelOverrideEntry[] = Array.from({ length: 60 }, (_, i) =>
      makeChannelEntry(`channel-${String(i).padStart(3, "0")}`),
    );

    const dependencies: ModelOverrideRouteDependencies = {
      resolveScope: async () => ({
        guildId: "guild-1",
        serverId: 1,
        channelOverrides: allEntries as ChannelOverrideEntry[],
        personasWithOverride: [],
        entries: allEntries,
      }),
      deleteChannelOverride: async () => true,
      clearPersonaOverride: async () => true,
      showRemoveModal: async (_interaction, _locale, page, _fp, _nonce, entries) => {
        modalShown = true;
        presentedPage = page;
        presentedBatchLength = entries.length;
      },
      takeCheckboxValues: () => undefined,
      createNonce: () => "nonce-12345678",
    };

    const route = createModelOverrideInteractionRoute(dependencies);
    const buttonRoute: ModelOverridePanelRoute = {
      action: "page",
      locale: "en-US",
      page: 1,
    };
    const customId = buildModelOverrideRouteId(buttonRoute);
    const parsed = parseRouteOrThrow(customId);

    const interaction = createMockInteraction(customId, { isButton: true });
    await route.execute(CLIENT, interaction as unknown as ButtonInteraction, parsed);

    expect(interaction.wasDeferredUpdate()).toBe(false);
    expect(modalShown).toBe(true);
    expect(presentedPage).toBe(1);
    expect(presentedBatchLength).toBe(10);
  });

  it("denies access to non-managers before resolving scope or opening modal", async () => {
    let scopeResolved = false;
    let modalShown = false;

    const dependencies: ModelOverrideRouteDependencies = {
      resolveScope: async () => {
        scopeResolved = true;
        return null;
      },
      deleteChannelOverride: async () => true,
      clearPersonaOverride: async () => true,
      showRemoveModal: async () => {
        modalShown = true;
      },
      takeCheckboxValues: () => undefined,
      createNonce: () => "nonce-12345678",
    };

    const route = createModelOverrideInteractionRoute(dependencies);
    const buttonRoute: ModelOverridePanelRoute = {
      action: "page",
      locale: "en-US",
      page: 0,
    };
    const customId = buildModelOverrideRouteId(buttonRoute);
    const parsed = parseRouteOrThrow(customId);

    const interaction = createMockInteraction(customId, { isButton: true, hasPermission: false });
    await route.execute(CLIENT, interaction as unknown as ButtonInteraction, parsed);

    expect(scopeResolved).toBe(false);
    expect(modalShown).toBe(false);
  });
});

describe("/model override remove - (6) routed submit stale fp and absent checkbox evidence guards", () => {
  it("performs no repository write when fingerprint is stale", async () => {
    let writeCalled = false;

    const entries: ModelOverrideEntry[] = [makeChannelEntry("channel-1"), makePersonaEntry(55, "Sparrow")];

    const dependencies: ModelOverrideRouteDependencies = {
      resolveScope: async () => ({
        guildId: "guild-1",
        serverId: 1,
        channelOverrides: [entries[0] as ChannelOverrideEntry],
        personasWithOverride: [entries[1] as PersonaOverrideEntry],
        entries,
      }),
      setTextModelOverride: async () => {
        writeCalled = true;
        return true;
      },
      showRemoveModal: async () => undefined,
      takeCheckboxValues: () => [],
      createNonce: () => "nonce-12345678",
    };

    const route = createModelOverrideInteractionRoute(dependencies);
    const submitRoute: ModelOverridePanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: "stale_fp", // Deliberately mismatching fingerprint
      nonce: "nonce-12345678",
    };
    const customId = buildModelOverrideRouteId(submitRoute);
    const parsed = parseRouteOrThrow(customId);

    const interaction = createMockInteraction(customId, { isButton: false, isModalSubmit: true });
    await route.execute(CLIENT, interaction as unknown as ModalSubmitInteraction, parsed);

    expect(writeCalled).toBe(false);
  });

  it("performs no repository write when all checkbox lookups return undefined (no evidence)", async () => {
    let writeCalled = false;

    const entries: ModelOverrideEntry[] = [makeChannelEntry("channel-1"), makePersonaEntry(55, "Sparrow")];
    const validFp = computeModelOverrideBatchFingerprint(entries, 0);

    const dependencies: ModelOverrideRouteDependencies = {
      resolveScope: async () => ({
        guildId: "guild-1",
        serverId: 1,
        channelOverrides: [entries[0] as ChannelOverrideEntry],
        personasWithOverride: [entries[1] as PersonaOverrideEntry],
        entries,
      }),
      setTextModelOverride: async () => {
        writeCalled = true;
        return true;
      },
      showRemoveModal: async () => undefined,
      // Every field lookup returns undefined (absent checkbox evidence)
      takeCheckboxValues: () => undefined,
      createNonce: () => "nonce-12345678",
    };

    const route = createModelOverrideInteractionRoute(dependencies);
    const submitRoute: ModelOverridePanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: validFp,
      nonce: "nonce-12345678",
    };
    const customId = buildModelOverrideRouteId(submitRoute);
    const parsed = parseRouteOrThrow(customId);

    const interaction = createMockInteraction(customId, { isButton: false, isModalSubmit: true });
    await route.execute(CLIENT, interaction as unknown as ModalSubmitInteraction, parsed);

    expect(writeCalled).toBe(false);
  });

  it("clears unchecked persona while keeping checked channel upon valid submission with serverDiscId", async () => {
    const writtenInputs: TextModelOverrideInput[] = [];

    const entries: ModelOverrideEntry[] = [makeChannelEntry("channel-1"), makePersonaEntry(55, "Sparrow")];
    const validFp = computeModelOverrideBatchFingerprint(entries, 0);

    const dependencies: ModelOverrideRouteDependencies = {
      resolveScope: async () => ({
        guildId: "guild-1",
        serverId: 1,
        channelOverrides: [entries[0] as ChannelOverrideEntry],
        personasWithOverride: [entries[1] as PersonaOverrideEntry],
        entries,
      }),
      setTextModelOverride: async (input) => {
        writtenInputs.push(input);
        return true;
      },
      showRemoveModal: async () => undefined,
      // Group 0 has "0" checked (channel-1 kept). Persona at index 1 is unchecked.
      takeCheckboxValues: () => ["0"],
      createNonce: () => "nonce-12345678",
    };

    const route = createModelOverrideInteractionRoute(dependencies);
    const submitRoute: ModelOverridePanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: validFp,
      nonce: "nonce-12345678",
    };
    const customId = buildModelOverrideRouteId(submitRoute);
    const parsed = parseRouteOrThrow(customId);

    const interaction = createMockInteraction(customId, { isButton: false, isModalSubmit: true });
    await route.execute(CLIENT, interaction as unknown as ModalSubmitInteraction, parsed);

    expect(writtenInputs).toHaveLength(1);
    expect(writtenInputs[0]).toEqual({
      scope: "persona",
      personaId: 55,
      llmId: null,
      serverDiscId: "guild-1",
    });
  });

  it("treats empty array checkbox lookup as evidence that all presented rows are unchecked and supplies serverDiscId", async () => {
    const writtenInputs: TextModelOverrideInput[] = [];

    const entries: ModelOverrideEntry[] = [makeChannelEntry("channel-1"), makePersonaEntry(55, "Sparrow")];
    const validFp = computeModelOverrideBatchFingerprint(entries, 0);

    const dependencies: ModelOverrideRouteDependencies = {
      resolveScope: async () => ({
        guildId: "guild-1",
        serverId: 1,
        channelOverrides: [entries[0] as ChannelOverrideEntry],
        personasWithOverride: [entries[1] as PersonaOverrideEntry],
        entries,
      }),
      setTextModelOverride: async (input) => {
        writtenInputs.push(input);
        return true;
      },
      showRemoveModal: async () => undefined,
      // Empty array is valid evidence: all items in batch were unchecked by user
      takeCheckboxValues: () => [],
      createNonce: () => "nonce-12345678",
    };

    const route = createModelOverrideInteractionRoute(dependencies);
    const submitRoute: ModelOverridePanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: validFp,
      nonce: "nonce-12345678",
    };
    const customId = buildModelOverrideRouteId(submitRoute);
    const parsed = parseRouteOrThrow(customId);

    const interaction = createMockInteraction(customId, { isButton: false, isModalSubmit: true });
    await route.execute(CLIENT, interaction as unknown as ModalSubmitInteraction, parsed);

    expect(writtenInputs).toHaveLength(2);
    expect(writtenInputs[0]).toEqual({
      scope: "channel",
      serverId: 1,
      channelId: "channel-1",
      llmId: null,
      serverDiscId: "guild-1",
    });
    expect(writtenInputs[1]).toEqual({
      scope: "persona",
      personaId: 55,
      llmId: null,
      serverDiscId: "guild-1",
    });
  });

  it("does not produce a false success receipt when setTextModelOverride returns false", async () => {
    const entries: ModelOverrideEntry[] = [makeChannelEntry("channel-1")];
    const validFp = computeModelOverrideBatchFingerprint(entries, 0);

    const dependencies: ModelOverrideRouteDependencies = {
      resolveScope: async () => ({
        guildId: "guild-1",
        serverId: 1,
        channelOverrides: [entries[0] as ChannelOverrideEntry],
        personasWithOverride: [],
        entries,
      }),
      setTextModelOverride: async () => false,
      showRemoveModal: async () => undefined,
      takeCheckboxValues: () => [],
      createNonce: () => "nonce-12345678",
    };

    const route = createModelOverrideInteractionRoute(dependencies);
    const submitRoute: ModelOverridePanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: validFp,
      nonce: "nonce-12345678",
    };
    const customId = buildModelOverrideRouteId(submitRoute);
    const parsed = parseRouteOrThrow(customId);

    const interaction = createMockInteraction(customId, { isButton: false, isModalSubmit: true });
    await route.execute(CLIENT, interaction as unknown as ModalSubmitInteraction, parsed);

    const editedPayload = interaction.getEditedReply() as { embeds?: Array<{ data: { title?: string } }> };
    expect(editedPayload).toBeDefined();
    expect(editedPayload?.embeds?.[0]?.data?.title).toBe(localizer("en-US", "general.errors.update_failed_title"));
  });
});

describe("/model override remove - (7) combined scopes and ordered positions contract", () => {
  it("enforces channel sort by channelDiscId, then personas by nickname with numeric persona_id tie-breaker", () => {
    const rawChannels = [makeChannelEntry("channel-z"), makeChannelEntry("channel-a"), makeChannelEntry("channel-m")];
    const rawPersonas = [
      makePersonaEntry(99, "Zoe"),
      makePersonaEntry(50, "Alice"),
      makePersonaEntry(10, "Alice"), // Same nickname, lower id should come first
      makePersonaEntry(2, "Bob"),
    ];

    const sorted = sortModelOverrideEntries(rawChannels, rawPersonas);

    // Channels must come first, sorted by channelDiscId
    expect(sorted[0]).toEqual(rawChannels[1]); // channel-a
    expect(sorted[1]).toEqual(rawChannels[2]); // channel-m
    expect(sorted[2]).toEqual(rawChannels[0]); // channel-z

    // Personas come second, sorted by persona_nickname then persona_id
    expect(sorted[3]).toEqual(rawPersonas[2]); // Alice (id 10)
    expect(sorted[4]).toEqual(rawPersonas[1]); // Alice (id 50)
    expect(sorted[5]).toEqual(rawPersonas[3]); // Bob (id 2)
    expect(sorted[6]).toEqual(rawPersonas[0]); // Zoe (id 99)
  });

  it("assigns positional indices as modal option values matching presented batch order", () => {
    const channels = [makeChannelEntry("channel-1"), makeChannelEntry("channel-2")];
    const personas = [makePersonaEntry(10, "Alpha"), makePersonaEntry(20, "Beta")];
    const combined = sortModelOverrideEntries(channels, personas);

    const mockGuild = {
      channels: {
        cache: {
          get: (id: string) => (id === "channel-1" ? { name: "general", isTextBased: () => true } : undefined),
        },
      },
    };

    const modal = buildModelOverrideRemoveModal("en-US", 0, "abcd1234", "nonce123", combined, mockGuild as never);

    const allOptions = modal.components.flatMap(
      (wrapper) => (wrapper.component as { options: Array<{ value: string; label: string }> }).options,
    );

    expect(allOptions).toHaveLength(4);
    expect(allOptions[0].value).toBe("0");
    expect(allOptions[1].value).toBe("1");
    expect(allOptions[2].value).toBe("2");
    expect(allOptions[3].value).toBe("3");

    // Channels first, then personas in presented modal options
    expect(allOptions[0].label).toBe("#general");
    expect(allOptions[2].label).toBe("Alpha");
    expect(allOptions[3].label).toBe("Beta");
  });
});

describe("/model override remove global route wiring", () => {
  it("handles a stale model override route and directs the user to the registered command", async () => {
    let replyPayload: { content?: string } | null = null;
    const interaction = {
      id: "stale-interaction",
      customId: "model-overrides:v0:page:en-US:0",
      locale: "en-US",
      user: { id: "user-1" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      reply: async (payload: { content?: string }) => {
        replyPayload = payload;
      },
    };

    const handled = await dispatchGlobalInteraction({} as Client, interaction as unknown as ButtonInteraction);

    expect(handled).toBe(true);
    expect(replyPayload?.content).toContain("/model override remove");
  });
});

describe("/model override remove - authorization guard against real singleton route", () => {
  it("rejects non-manager modal submit with no aggregate channel read and no llmOverrideRepo write", async () => {
    const readSpy = spyOn(llmOverrideRepo, "getAllChannelLlmOverridesForServer");
    const deleteChannelSpy = spyOn(llmOverrideRepo, "deleteChannelLlmOverride");
    const setPersonaSpy = spyOn(llmOverrideRepo, "setPersonaLlmOverride");
    const setChannelSpy = spyOn(llmOverrideRepo, "setChannelLlmOverride");

    const submitRoute: ModelOverridePanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: "abcdef12",
      nonce: "nonce-12345678",
    };
    const customId = buildModelOverrideRouteId(submitRoute);
    const parsed = parseRouteOrThrow(customId);

    const interaction = createMockInteraction(customId, {
      isButton: false,
      isModalSubmit: true,
      hasPermission: false,
      guildId: "guild-1",
    });

    await modelOverrideInteractionRoute.execute(CLIENT, interaction as unknown as ModalSubmitInteraction, parsed);

    expect(interaction.replied).toBe(true);
    expect(readSpy).not.toHaveBeenCalled();
    expect(deleteChannelSpy).not.toHaveBeenCalled();
    expect(setPersonaSpy).not.toHaveBeenCalled();
    expect(setChannelSpy).not.toHaveBeenCalled();

    readSpy.mockRestore();
    deleteChannelSpy.mockRestore();
    setPersonaSpy.mockRestore();
    setChannelSpy.mockRestore();
  });

  it("rejects DM modal submit with no aggregate channel read and no llmOverrideRepo write", async () => {
    const readSpy = spyOn(llmOverrideRepo, "getAllChannelLlmOverridesForServer");
    const deleteChannelSpy = spyOn(llmOverrideRepo, "deleteChannelLlmOverride");
    const setPersonaSpy = spyOn(llmOverrideRepo, "setPersonaLlmOverride");
    const setChannelSpy = spyOn(llmOverrideRepo, "setChannelLlmOverride");

    const submitRoute: ModelOverridePanelRoute = {
      action: "remove-submit",
      locale: "en-US",
      page: 0,
      fp: "abcdef12",
      nonce: "nonce-12345678",
    };
    const customId = buildModelOverrideRouteId(submitRoute);
    const parsed = parseRouteOrThrow(customId);

    const interaction = createMockInteraction(customId, {
      isButton: false,
      isModalSubmit: true,
      guildId: null,
    });

    await modelOverrideInteractionRoute.execute(CLIENT, interaction as unknown as ModalSubmitInteraction, parsed);

    expect(interaction.replied).toBe(true);
    expect(readSpy).not.toHaveBeenCalled();
    expect(deleteChannelSpy).not.toHaveBeenCalled();
    expect(setPersonaSpy).not.toHaveBeenCalled();
    expect(setChannelSpy).not.toHaveBeenCalled();

    readSpy.mockRestore();
    deleteChannelSpy.mockRestore();
    setPersonaSpy.mockRestore();
    setChannelSpy.mockRestore();
  });
});

describe("setTextModelOverride cache invalidation behavior", () => {
  it("does not invalidate cache when channel repository write fails, and invalidates both channel and tomoriState cache on success", async () => {
    const channelCacheSpy = spyOn(channelLlmCacheStore, "invalidateChannelLlmCache");
    const stateCacheSpy = spyOn(tomoriStateCacheStore, "invalidateTomoriStateCache");

    const sqlSpy = spyOn(
      llmOverrideRepo as unknown as { deleteChannelOverrideSql: () => Promise<boolean> },
      "deleteChannelOverrideSql",
    );

    sqlSpy.mockResolvedValue(false);
    const failResult = await setTextModelOverride({
      scope: "channel",
      serverId: 42,
      channelId: "channel-42",
      llmId: null,
      serverDiscId: "guild-42",
    });
    expect(failResult).toBe(false);
    expect(channelCacheSpy).not.toHaveBeenCalled();
    expect(stateCacheSpy).not.toHaveBeenCalled();

    sqlSpy.mockResolvedValue(true);
    const successResult = await setTextModelOverride({
      scope: "channel",
      serverId: 42,
      channelId: "channel-42",
      llmId: null,
      serverDiscId: "guild-42",
    });
    expect(successResult).toBe(true);
    expect(channelCacheSpy).toHaveBeenCalledWith(42, "channel-42");
    expect(stateCacheSpy).toHaveBeenCalledWith("guild-42");

    sqlSpy.mockRestore();
    channelCacheSpy.mockRestore();
    stateCacheSpy.mockRestore();
  });

  it("does not invalidate cache when persona repository write fails, and invalidates tomoriState cache on success", async () => {
    const stateCacheSpy = spyOn(tomoriStateCacheStore, "invalidateTomoriStateCache");

    const sqlSpy = spyOn(
      llmOverrideRepo as unknown as { writePersonaOverrideSql: () => Promise<boolean> },
      "writePersonaOverrideSql",
    );

    sqlSpy.mockResolvedValue(false);
    const failResult = await setTextModelOverride({
      scope: "persona",
      personaId: 77,
      llmId: null,
      serverDiscId: "guild-77",
    });
    expect(failResult).toBe(false);
    expect(stateCacheSpy).not.toHaveBeenCalled();

    sqlSpy.mockResolvedValue(true);
    const successResult = await setTextModelOverride({
      scope: "persona",
      personaId: 77,
      llmId: null,
      serverDiscId: "guild-77",
    });
    expect(successResult).toBe(true);
    expect(stateCacheSpy).toHaveBeenCalledWith("guild-77");

    sqlSpy.mockRestore();
    stateCacheSpy.mockRestore();
  });
});

describe("buildModelOverrideRemoveModal option descriptions and mixed chunk contract", () => {
  it("labels each row with its target and describes only the effective model", () => {
    const channelEntry = makeChannelEntry("channel-1", LLM_A);
    const personaEntry = makePersonaEntry(55, "Sparrow", LLM_A);

    const mockGuild = {
      channels: {
        cache: {
          get: (id: string) => (id === "channel-1" ? { name: "general", isTextBased: () => true } : undefined),
        },
      },
    };

    const modal = buildModelOverrideRemoveModal(
      "en-US",
      0,
      "abcd1234",
      "nonce123",
      [channelEntry, personaEntry],
      mockGuild as never,
    );
    const options = (modal.components[0].component as { options: Array<{ label: string; description: string }> })
      .options;

    expect(options[0].label).toBe("#general");
    expect(options[0].description).toBe("gemini-2.5-flash (google)");

    expect(options[1].label).toBe("Sparrow");
    expect(options[1].description).toBe("gemini-2.5-flash (google)");
  });

  it("keeps scope and editor destination in the group context instead of every option", () => {
    const channelModal = buildModelOverrideRemoveModal(
      "en-US",
      0,
      "abcd1234",
      "nonce123",
      [makeChannelEntry("channel-1")],
      null,
    );
    expect(channelModal.components[0].label).toBe(
      localizer("en-US", "commands.model.override.remove.channel_checkbox_label"),
    );
    expect(channelModal.components[0].description).toBe(
      localizer("en-US", "commands.model.override.remove.channel_checkbox_description"),
    );
    expect(channelModal.components[0].description).toContain("/config > Channels > Overrides");

    const personaModal = buildModelOverrideRemoveModal(
      "en-US",
      0,
      "abcd1234",
      "nonce123",
      [makePersonaEntry(55, "Sparrow")],
      null,
    );
    expect(personaModal.components[0].label).toBe(
      localizer("en-US", "commands.model.override.remove.persona_checkbox_label"),
    );
    expect(personaModal.components[0].description).toBe(
      localizer("en-US", "commands.model.override.remove.persona_checkbox_description"),
    );
    expect(personaModal.components[0].description).toContain("/config > Persona > Overrides");
  });

  it("labels mixed chunk with mixed checkbox label and description instead of lying about contents", () => {
    const channelEntry = makeChannelEntry("channel-1", LLM_A);
    const personaEntry = makePersonaEntry(55, "Sparrow", LLM_A);

    const modal = buildModelOverrideRemoveModal("en-US", 0, "abcd1234", "nonce123", [channelEntry, personaEntry], null);

    expect(modal.components[0].label).toBe(localizer("en-US", "commands.model.override.remove.mixed_checkbox_label"));
    expect(modal.components[0].description).toBe(
      localizer("en-US", "commands.model.override.remove.mixed_checkbox_description"),
    );
  });

  it("bounds oversized targets in the label and model summaries in the description without scope or destination repetition", () => {
    const oversizedLlm: LlmRow = {
      llm_id: 88,
      llm_provider: "oversized-provider-name-that-exceeds-bounds",
      llm_codename: "oversized-model-codename-that-exceeds-bounds",
    } as unknown as LlmRow;

    const oversizedChannelEntry = makeChannelEntry("channel-oversized", oversizedLlm);
    const oversizedPersonaEntry = makePersonaEntry(99, "oversized-persona-target-that-exceeds-bounds", oversizedLlm);

    const mockGuild = {
      channels: {
        cache: {
          get: (id: string) =>
            id === "channel-oversized"
              ? {
                  name: "oversized-channel-target-that-exceeds-bounds",
                  isTextBased: () => true,
                }
              : undefined,
        },
      },
    };

    const modal = buildModelOverrideRemoveModal(
      "en-US",
      0,
      "abcd1234",
      "nonce123",
      [oversizedChannelEntry, oversizedPersonaEntry],
      mockGuild as never,
    );
    const options = (modal.components[0].component as { options: Array<{ label: string; description: string }> })
      .options;

    const channelLabel = options[0].label;
    expect(channelLabel.length).toBeLessThanOrEqual(100);
    expect(channelLabel).toContain("#oversized-channel");
    expect(channelLabel).not.toContain("/config");
    expect(options[0].description).toBe(formatModelOverrideModelSummary(oversizedLlm));
    expect(options[0].description.length).toBeLessThanOrEqual(100);
    expect(options[0].description).not.toContain("•");

    const personaLabel = options[1].label;
    expect(personaLabel.length).toBeLessThanOrEqual(100);
    expect(personaLabel).toContain("oversized-persona");
    expect(personaLabel).not.toContain("/config");
    expect(options[1].description).toBe(formatModelOverrideModelSummary(oversizedLlm));
    expect(options[1].description.length).toBeLessThanOrEqual(100);
    expect(options[1].description).not.toContain("•");
  });
});
