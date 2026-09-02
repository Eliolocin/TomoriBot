/**
 * Route coverage for the `/config` Persona > General surface.
 *
 * Drives the real registered route through the real policy, catalog, and renderer. Where a test
 * proves that a denied actor writes nothing, it spies on the repository the canonical operation
 * actually calls rather than substituting an operations double, because a double would restate the
 * expected answer instead of exercising the guard.
 */
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { PermissionsBitField, type Client } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import { personaRepository } from "@/utils/db/repositories";
import {
  CONFIG_ROUTE_CODECS,
  buildConfigRouteId,
  computeTriggerRemoveFingerprint,
  parseConfigPanelRoute,
  type ConfigPanelRoute,
} from "@/utils/discord/configPanelCatalog";
import { createConfigInteractionRoute } from "@/utils/discord/interactions/configRoutes";
import type { ConfigRouteDependencies, ConfigScope } from "@/utils/discord/interactions/configRouteContext";
import { configPersonaOperations } from "@/utils/discord/interactions/configPersonaOperations";
import { parseInteractionRoute, type ParsedInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { buildConfigModalFieldId, buildTriggerRemoveCheckboxGroupId } from "@/utils/discord/ui/configModals";
import { loadCommandData } from "@/utils/discord/commandLoader";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const CLIENT = {} as Client;

function requireRoute(customId: string): ParsedInteractionRoute {
  const parsed = parseInteractionRoute(customId);
  if (!parsed) throw new Error(`Failed to parse route for customId: ${customId}`);
  return parsed;
}

function makePersona(overrides: Partial<TomoriState> & { persona_id: number }): TomoriState {
  return {
    server_id: 9,
    persona_nickname: `Persona ${overrides.persona_id}`,
    is_alter: false,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    persona_prompt: null,
    attribute_list: [],
    sample_dialogues_in: [],
    sample_dialogues_out: [],
    webhook_avatar_url: null,
    is_pointer: false,
    ...overrides,
  } as unknown as TomoriState;
}

const MAIN = makePersona({ persona_id: 55, persona_nickname: "Aphel", trigger_words: ["aphel", "hey aphel"] });
const ALTER = makePersona({ persona_id: 56, persona_nickname: "Wren", is_alter: true });

interface HarnessOptions {
  isManager?: boolean;
  inGuild?: boolean;
  personas?: TomoriState[];
  refreshedPersonas?: TomoriState[];
  operations?: Partial<ConfigRouteDependencies["operations"]>;
}

interface Harness {
  dependencies: Partial<ConfigRouteDependencies>;
  telemetry: string[];
  edits: unknown[];
  replies: unknown[];
  modals: unknown[];
  scopeLoads: boolean[];
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const telemetry: string[] = [];
  const edits: unknown[] = [];
  const replies: unknown[] = [];
  const modals: unknown[] = [];
  const scopeLoads: boolean[] = [];

  const buildScope = (forceRefresh: boolean): ConfigScope => ({
    serverDiscId: options.inGuild === false ? "user-1" : "guild-1",
    guildId: options.inGuild === false ? null : "guild-1",
    internalServerId: 9,
    actor:
      options.inGuild === false
        ? { workspaceKind: "dm", isManager: true }
        : { workspaceKind: "guild", isManager: options.isManager ?? true },
    personas: (forceRefresh ? (options.refreshedPersonas ?? options.personas) : options.personas) ?? [MAIN, ALTER],
    readStatus: "fresh",
  });

  return {
    telemetry,
    edits,
    replies,
    modals,
    scopeLoads,
    dependencies: {
      resolveScope: async (_interaction, forceRefresh = false) => {
        scopeLoads.push(forceRefresh);
        return buildScope(forceRefresh);
      },
      getPersonaAvatarData: async () => ({ url: null, files: [] }),
      createGuildIdentity: () => ({
        setNickname: async () => true,
        setAvatar: async () => ({ ok: true, rateLimited: false }),
        currentAvatarReference: async () => null,
      }),
      recordAction: (input) => {
        telemetry.push(input.action);
      },
      createNonce: () => "nonce1234567",
      showModal: async (_interaction, payload) => {
        modals.push(payload);
      },
      takeAvatarUpload: () => undefined,
      takeCheckboxValues: () => [],
      operations: { ...configPersonaOperations, ...options.operations },
    },
  };
}

interface FakeInteractionOptions {
  customId: string;
  kind?: "button" | "select" | "modal";
  values?: string[];
  fields?: Record<string, string>;
  isManager?: boolean;
  inGuild?: boolean;
  harness: Harness;
}

function makeInteraction(options: FakeInteractionOptions) {
  let deferred = false;
  let replied = false;
  const kind = options.kind ?? "button";

  const interaction = {
    id: "interaction-1",
    customId: options.customId,
    user: { id: "user-1" },
    guildId: options.inGuild === false ? null : "guild-1",
    guild: options.inGuild === false ? null : { members: { me: null, fetch: async () => null } },
    client: { user: null },
    values: options.values ?? [],
    memberPermissions: {
      has: (flag: bigint) => (options.isManager ?? true) && flag === PermissionsBitField.Flags.ManageGuild,
    },
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isModalSubmit: () => kind === "modal",
    get deferred() {
      return deferred;
    },
    get replied() {
      return replied;
    },
    deferUpdate: async () => {
      deferred = true;
    },
    editReply: async (payload: unknown) => {
      options.harness.edits.push(payload);
      return payload;
    },
    reply: async (payload: unknown) => {
      replied = true;
      options.harness.replies.push(payload);
      return payload;
    },
    fields: {
      getTextInputValue: (fieldId: string) => options.fields?.[fieldId] ?? "",
    },
  };

  return interaction as unknown as Parameters<ReturnType<typeof createConfigInteractionRoute>["execute"]>[1] & {
    deferred: boolean;
  };
}

async function dispatch(harness: Harness, interaction: ReturnType<typeof makeInteraction>): Promise<void> {
  const route = createConfigInteractionRoute(harness.dependencies);
  await route.execute(CLIENT, interaction, requireRoute(interaction.customId));
}

/**
 * Pins the `/config` v1 wire contract: each literal custom ID and the exact route it must decode to.
 * Encoding and decoding through one shared codec table cannot catch a field reordering, because
 * both sides move together and a round-trip still succeeds; only literal bytes can.
 */
const WIRE_CONTRACT_V1: ReadonlyArray<readonly [string, ConfigPanelRoute]> = [
  [
    "config:v1:category:en-US:persona:general",
    { action: "category", locale: "en-US", category: "persona", page: "general" },
  ],
  ["config:v1:page:en-US:models:switch", { action: "page", locale: "en-US", category: "models", page: "switch" }],
  ["config:v1:persona-select:en-US:55", { action: "persona-select", locale: "en-US", personaId: 55 }],
  ["config:v1:persona-page:en-US:55:25", { action: "persona-page", locale: "en-US", personaId: 55, start: 25 }],
  ["config:v1:avatar-open:en-US:55", { action: "avatar-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:avatar-submit:en-US:55:nonce1234567",
    { action: "avatar-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v1:rename-open:en-US:55", { action: "rename-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:rename-submit:en-US:55:nonce1234567",
    { action: "rename-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v1:naming-style:en-US:55", { action: "naming-style-select", locale: "en-US", personaId: 55 }],
  [
    "config:v1:naming-open:en-US:55:neutral",
    { action: "naming-open", locale: "en-US", personaId: 55, style: "neutral" },
  ],
  [
    "config:v1:naming-submit:en-US:55:feminine:nonce1234567",
    { action: "naming-submit", locale: "en-US", personaId: 55, style: "feminine", nonce: "nonce1234567" },
  ],
  ["config:v1:trig-add-open:en-US:55", { action: "trigger-add-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:trig-add-sub:en-US:55:nonce1234567",
    { action: "trigger-add-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" },
  ],
  ["config:v1:trig-rem-open:en-US:55", { action: "trigger-remove-open", locale: "en-US", personaId: 55 }],
  [
    "config:v1:trig-rem-sub:en-US:55:abcd1234:nonce1234567",
    { action: "trigger-remove-submit", locale: "en-US", personaId: 55, fp: "abcd1234", nonce: "nonce1234567" },
  ],
  ["config:v1:promote-view:en-US:56", { action: "promote-view", locale: "en-US", personaId: 56 }],
  [
    "config:v1:promote-confirm:en-US:56:nonce1234567",
    { action: "promote-confirm", locale: "en-US", personaId: 56, nonce: "nonce1234567" },
  ],
  ["config:v1:promote-cancel:en-US:56", { action: "promote-cancel", locale: "en-US", personaId: 56 }],
  [
    "config:v1:retry:en-US:persona:general:55",
    { action: "retry", locale: "en-US", category: "persona", page: "general", personaId: 55 },
  ],
  [
    "config:v1:refresh:en-US:persona:general",
    { action: "refresh", locale: "en-US", category: "persona", page: "general" },
  ],
];

describe("config route wire contract", () => {
  it("decodes every pinned v1 wire string to its exact route", () => {
    for (const [customId, expected] of WIRE_CONTRACT_V1) {
      expect(customId.length).toBeLessThanOrEqual(100);
      expect(parseConfigPanelRoute(requireRoute(customId))).toEqual(expected);
    }
  });

  it("re-encodes every pinned route to the exact wire string it came from", () => {
    for (const [customId, route] of WIRE_CONTRACT_V1) {
      expect(buildConfigRouteId(route)).toBe(customId);
    }
  });

  it("covers every declared action in the pinned wire contract", () => {
    const pinned = new Set(WIRE_CONTRACT_V1.map(([, route]) => route.action));
    expect([...pinned].sort()).toEqual(Object.keys(CONFIG_ROUTE_CODECS).sort());
  });

  it("rejects a malformed or out-of-range field rather than defaulting it", () => {
    expect(parseConfigPanelRoute(requireRoute("config:v1:persona-select:en-US:0"))).toBeNull();
    expect(parseConfigPanelRoute(requireRoute("config:v1:persona-select:en-US:abc"))).toBeNull();
    // `general` is a Behavior page too, so a page must decode against its own category.
    expect(parseConfigPanelRoute(requireRoute("config:v1:page:en-US:models:general"))).toBeNull();
    expect(parseConfigPanelRoute(requireRoute("config:v1:naming-open:en-US:55:androgynous"))).toBeNull();
    expect(parseConfigPanelRoute(requireRoute("config:v1:not-a-token:en-US:55"))).toBeNull();
  });
});

describe("config route authorization", () => {
  it("writes nothing when a guild member replays a manager-owned rename", async () => {
    const renameSpy = spyOn(personaRepository, "renamePersona");
    const harness = makeHarness({ isManager: false });
    const customId = buildConfigRouteId({
      action: "rename-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await dispatch(
      harness,
      makeInteraction({
        customId,
        kind: "modal",
        isManager: false,
        harness,
        fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
      }),
    );

    expect(renameSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    renameSpy.mockRestore();
  });

  it("reaches the same repository write when the identical route carries a manager", async () => {
    // Pairs with the denial above so that test cannot pass vacuously: the only difference between
    // the two dispatches is the actor resolved from the interaction.
    const renameSpy = spyOn(personaRepository, "renamePersona").mockResolvedValue(true);
    const conflictSpy = spyOn(personaRepository, "hasNicknameConflict").mockResolvedValue(false);
    const triggerSpy = spyOn(personaRepository, "addTrigger").mockResolvedValue(true);
    const harness = makeHarness({ isManager: true });
    const customId = buildConfigRouteId({
      action: "rename-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await dispatch(
      harness,
      makeInteraction({
        customId,
        kind: "modal",
        isManager: true,
        harness,
        fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
      }),
    );

    expect(renameSpy).toHaveBeenCalledWith(55, "Renamed");
    expect(harness.telemetry).toEqual(["server-config.workspace.persona.rename"]);
    renameSpy.mockRestore();
    conflictSpy.mockRestore();
    triggerSpy.mockRestore();
  });

  it("writes nothing when a DM actor replays a guild-only trigger add", async () => {
    const addSpy = spyOn(personaRepository, "addTrigger");
    const harness = makeHarness({ inGuild: false });
    const customId = buildConfigRouteId({
      action: "trigger-add-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await dispatch(
      harness,
      makeInteraction({
        customId,
        kind: "modal",
        inGuild: false,
        harness,
        fields: { [buildConfigModalFieldId("triggers", "nonce1234567")]: "wren" },
      }),
    );

    expect(addSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    addSpy.mockRestore();
  });

  it("refuses a forged modal open without opening the modal", async () => {
    const harness = makeHarness({ isManager: false });
    const customId = buildConfigRouteId({ action: "avatar-open", locale: "en-US", personaId: 55 });

    await dispatch(harness, makeInteraction({ customId, isManager: false, harness }));

    expect(harness.modals).toEqual([]);
    expect(harness.replies).toHaveLength(1);
  });
});

describe("config route write behavior", () => {
  it("reports a nickname conflict when a concurrent rename wins the write race", async () => {
    const conflictSpy = spyOn(personaRepository, "hasNicknameConflict")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const renameSpy = spyOn(personaRepository, "renamePersona").mockResolvedValue(false);

    const result = await configPersonaOperations.rename({
      persona: MAIN,
      serverDiscId: "guild-1",
      newNickname: "Renamed",
      guildIdentity: null,
    });

    expect(result).toEqual({ status: "name-conflict", nickname: "Renamed" });
    expect(renameSpy).toHaveBeenCalledWith(55, "Renamed");
    expect(conflictSpy).toHaveBeenNthCalledWith(1, 9, 55, "Renamed");
    expect(conflictSpy).toHaveBeenNthCalledWith(2, 9, 55, "Renamed");
    conflictSpy.mockRestore();
    renameSpy.mockRestore();
  });

  it("rejects a rename route carried by a button before reaching the repository", async () => {
    const renameSpy = spyOn(personaRepository, "renamePersona");
    const harness = makeHarness();
    const customId = buildConfigRouteId({
      action: "rename-submit",
      locale: "en-US",
      personaId: 55,
      nonce: "nonce1234567",
    });

    await expect(dispatch(harness, makeInteraction({ customId, kind: "button", harness }))).rejects.toThrow(
      "Config rename-submit route requires a modal submission",
    );

    expect(renameSpy).not.toHaveBeenCalled();
    renameSpy.mockRestore();
  });

  it("acknowledges the interaction before the write and repaints from a refreshed read", async () => {
    let acknowledgedDuringWrite = false;
    const renamed = makePersona({ persona_id: 55, persona_nickname: "Renamed", trigger_words: ["aphel", "renamed"] });
    const harness = makeHarness({
      personas: [MAIN, ALTER],
      refreshedPersonas: [renamed, ALTER],
      operations: {
        rename: async () => {
          acknowledgedDuringWrite = interaction.deferred;
          return {
            status: "success",
            oldNickname: "Aphel",
            newNickname: "Renamed",
            triggerAdded: true,
            guildNicknameSynced: true,
          };
        },
      },
    });
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "rename-submit", locale: "en-US", personaId: 55, nonce: "nonce1234567" }),
      kind: "modal",
      harness,
      fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
    });

    await dispatch(harness, interaction);

    expect(acknowledgedDuringWrite).toBe(true);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona.rename"]);
    // A forced reload followed the write, so the repaint cannot show a pre-write value.
    expect(harness.scopeLoads).toContain(true);
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Renamed");
  });

  it("writes nothing when the routed persona no longer exists in the workspace", async () => {
    // Falling back to the main persona is right for navigation and catastrophic for a write, so a
    // write whose target vanished must repaint instead of retargeting.
    let renameCalls = 0;
    const harness = makeHarness({
      personas: [MAIN],
      operations: {
        rename: async () => {
          renameCalls += 1;
          return { status: "write-failed" };
        },
      },
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "rename-submit",
          locale: "en-US",
          personaId: 999,
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
        fields: { [buildConfigModalFieldId("nickname", "nonce1234567")]: "Renamed" },
      }),
    );

    expect(renameCalls).toBe(0);
    expect(harness.telemetry).toEqual([]);
    expect(harness.edits).toHaveLength(1);
  });

  it("falls back to the main persona for navigation when the routed persona is gone", async () => {
    const harness = makeHarness({ personas: [MAIN] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "persona-select", locale: "en-US", personaId: 999 }),
        kind: "select",
        values: [],
        harness,
      }),
    );

    const rendered = JSON.stringify(harness.edits.at(-1));
    expect(rendered).toContain(buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }));
  });

  it("reads the newly selected persona from the submitted value, not the route", async () => {
    const harness = makeHarness();

    await dispatch(
      harness,
      makeInteraction({
        // The custom ID names the persona that was selected when the menu rendered.
        customId: buildConfigRouteId({ action: "persona-select", locale: "en-US", personaId: 55 }),
        kind: "select",
        values: ["56"],
        harness,
      }),
    );

    const rendered = JSON.stringify(harness.edits.at(-1));
    expect(rendered).toContain(buildConfigRouteId({ action: "promote-view", locale: "en-US", personaId: 56 }));
  });

  it("reads the newly selected page from the submitted value and refuses one the actor cannot open", async () => {
    const allowed = makeHarness();
    await dispatch(
      allowed,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "persona", page: "general" }),
        kind: "select",
        values: ["sprites"],
        harness: allowed,
      }),
    );
    expect(JSON.stringify(allowed.edits.at(-1))).toContain("Sprites");

    const denied = makeHarness({ isManager: false });
    await dispatch(
      denied,
      makeInteraction({
        customId: buildConfigRouteId({ action: "page", locale: "en-US", category: "persona", page: "general" }),
        kind: "select",
        values: ["advanced"],
        isManager: false,
        harness: denied,
      }),
    );
    // Advanced is omitted for a member, so the submitted value is discarded rather than honoured.
    expect(JSON.stringify(denied.edits.at(-1))).not.toContain("page_persona_advanced");
    expect(JSON.stringify(denied.edits.at(-1))).toContain(
      buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }),
    );
  });

  it("keeps the naming editor on the style the select submitted", async () => {
    const persona = makePersona({
      persona_id: 55,
      persona_nickname: "Aphel",
      naming_config: { prefixes: { masculine: "Sir" }, suffixes: {}, addressTerms: {} },
    } as Partial<TomoriState> & { persona_id: number });
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [persona] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "naming-style-select", locale: "en-US", personaId: 55 }),
        kind: "select",
        values: ["masculine"],
        harness,
      }),
    );

    const rendered = JSON.stringify(harness.edits.at(-1));
    expect(rendered).toContain(
      buildConfigRouteId({ action: "naming-open", locale: "en-US", personaId: 55, style: "masculine" }),
    );
    expect(rendered).toContain("Sir");
  });
});

describe("config trigger removal", () => {
  it("removes exactly the unchecked words and leaves the checked ones", async () => {
    const persona = makePersona({ persona_id: 55, trigger_words: ["one", "two", "three"] });
    const removeSpy = spyOn(personaRepository, "removeTrigger").mockResolvedValue(true);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [persona] });
    harness.dependencies.takeCheckboxValues = (_interactionId, fieldId) =>
      fieldId === buildTriggerRemoveCheckboxGroupId(0, "nonce1234567") ? ["0", "2"] : [];

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeTriggerRemoveFingerprint(55, persona.trigger_words),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    // Unchecked means remove, so index 1 ("two") goes and the remaining list is what is written.
    expect(removeSpy).toHaveBeenCalledWith(55, ["one", "three"]);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona-trigger.remove"]);
    removeSpy.mockRestore();
  });

  it("writes nothing when the trigger list changed under the open modal", async () => {
    const persona = makePersona({ persona_id: 55, trigger_words: ["one", "two", "three"] });
    const removeSpy = spyOn(personaRepository, "removeTrigger").mockResolvedValue(true);
    const harness = makeHarness({ personas: [persona] });
    harness.dependencies.takeCheckboxValues = () => ["0"];

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          // Fingerprint of the list as it was before a concurrent add.
          fp: computeTriggerRemoveFingerprint(55, ["one", "two"]),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(removeSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    removeSpy.mockRestore();
  });

  it("treats missing checkbox data as stale without writing", async () => {
    const persona = makePersona({ persona_id: 55, trigger_words: ["one", "two"] });
    const removeSpy = spyOn(personaRepository, "removeTrigger");
    const harness = makeHarness({ personas: [persona] });
    harness.dependencies.takeCheckboxValues = () => undefined;

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeTriggerRemoveFingerprint(55, persona.trigger_words),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(removeSpy).not.toHaveBeenCalled();
    expect(harness.telemetry).toEqual([]);
    removeSpy.mockRestore();
  });

  it("removes a group when its checkbox data is an explicit empty array", async () => {
    const triggerWords = Array.from({ length: 11 }, (_, index) => `word-${index}`);
    const persona = makePersona({ persona_id: 55, trigger_words: triggerWords });
    const removeSpy = spyOn(personaRepository, "removeTrigger").mockResolvedValue(true);
    const harness = makeHarness({ personas: [persona], refreshedPersonas: [persona] });
    harness.dependencies.takeCheckboxValues = (_interactionId, fieldId) => {
      if (fieldId === buildTriggerRemoveCheckboxGroupId(0, "nonce1234567")) return [];
      if (fieldId === buildTriggerRemoveCheckboxGroupId(1, "nonce1234567")) return ["10"];
      return undefined;
    };

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "trigger-remove-submit",
          locale: "en-US",
          personaId: 55,
          fp: computeTriggerRemoveFingerprint(55, triggerWords),
          nonce: "nonce1234567",
        }),
        kind: "modal",
        harness,
      }),
    );

    expect(removeSpy).toHaveBeenCalledWith(55, ["word-10"]);
    expect(harness.telemetry).toEqual(["server-config.workspace.persona-trigger.remove"]);
    removeSpy.mockRestore();
  });

  it("binds the fingerprint to the persona as well as the list", () => {
    expect(computeTriggerRemoveFingerprint(55, ["one", "two"])).not.toBe(
      computeTriggerRemoveFingerprint(56, ["one", "two"]),
    );
    expect(computeTriggerRemoveFingerprint(55, ["one", "two"])).not.toBe(
      computeTriggerRemoveFingerprint(55, ["two", "one"]),
    );
  });
});

describe("config promotion", () => {
  it("opens a confirmation before promoting rather than swapping on the first press", async () => {
    const swapSpy = spyOn(personaRepository, "swapPersona");
    const harness = makeHarness();

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "promote-view", locale: "en-US", personaId: 56 }),
        harness,
      }),
    );

    expect(swapSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).toContain(
      buildConfigRouteId({ action: "promote-confirm", locale: "en-US", personaId: 56, nonce: "nonce1234567" }),
    );
    swapSpy.mockRestore();
  });

  it("refuses to promote a persona that is already the main one", async () => {
    let promoteCalls = 0;
    const harness = makeHarness({
      operations: {
        promoteToMain: async () => {
          promoteCalls += 1;
          return { status: "not-alter" };
        },
      },
    });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "promote-view", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    expect(promoteCalls).toBe(0);
    expect(JSON.stringify(harness.edits.at(-1))).not.toContain("promote-confirm");
  });
});

describe("config modal opening", () => {
  it("opens a modal as the acknowledgement rather than deferring first", async () => {
    const harness = makeHarness();
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }),
      harness,
    });

    await dispatch(harness, interaction);

    expect(interaction.deferred).toBe(false);
    expect(harness.edits).toEqual([]);
    expect(harness.modals).toHaveLength(1);
    expect(harness.modals[0]).toMatchObject({
      custom_id: buildConfigRouteId({
        action: "rename-submit",
        locale: "en-US",
        personaId: 55,
        nonce: "nonce1234567",
      }),
    });
  });

  it("prefills the rename modal with the persona's current name", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    expect(JSON.stringify(harness.modals[0])).toContain('"value":"Aphel"');
  });

  it("does not open a modal for a persona absent from the workspace", async () => {
    const harness = makeHarness({ personas: [MAIN] });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "rename-open", locale: "en-US", personaId: 999 }),
        harness,
      }),
    );

    expect(harness.modals).toEqual([]);
    expect(harness.replies).toHaveLength(1);
  });

  it("declines to open the removal modal for a persona with no trigger words", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "trigger-remove-open", locale: "en-US", personaId: 56 }),
        harness,
      }),
    );

    expect(harness.modals).toEqual([]);
    expect(harness.replies).toHaveLength(1);
  });

  it("builds the removal modal from CheckboxGroup components, never FileUpload", async () => {
    const harness = makeHarness();
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "trigger-remove-open", locale: "en-US", personaId: 55 }),
        harness,
      }),
    );

    const modal = harness.modals[0] as { components: Array<{ type: number; component: { type: number } }> };
    // 22 is CheckboxGroup. A FileUpload (19) also renders and submits, but carries no option values,
    // which would make unchecked-means-remove delete every presented word.
    expect(modal.components.every((label) => label.type === 18)).toBe(true);
    expect(modal.components.map((label) => label.component.type)).toEqual([22]);
  });
});

describe("config registration is unchanged by this slice", () => {
  it("leaves /config as the manager-defaulted subcommand tree until the cutover slice", async () => {
    const { registrationData } = await loadCommandData();
    const configCommands = registrationData.filter((command) => command.name === "config") as unknown as Array<{
      default_member_permissions?: string;
      contexts?: number[];
      options?: Array<{ type: number; name: string }>;
    }>;

    expect(configCommands).toHaveLength(1);
    const configCommand = configCommands[0];

    // "32" is ManageGuild, applied by MANAGER_ONLY_CATEGORIES rather than a module export. The
    // cutover slice removes both this default and the subcommand tree; the panel must not.
    expect(configCommand.default_member_permissions).toBe("32");
    // Undefined contexts keeps the command DM-capable.
    expect(configCommand.contexts).toBeUndefined();
    // Subcommand (1) and subcommand-group (2) options prove it is still directory-backed, so no bare
    // executable root has appeared. A topological assertion rather than a whole-tree command count,
    // which would fail on every unrelated wave.
    expect((configCommand.options ?? []).length).toBeGreaterThan(0);
    expect((configCommand.options ?? []).every((option) => option.type === 1 || option.type === 2)).toBe(true);
  });
});
