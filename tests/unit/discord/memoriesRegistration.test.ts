/**
 * `/memories` absorbed roots that formerly had opposite registration shapes, and the resulting
 * permission is the one thing an implementation summary can describe correctly while being wrong.
 * Shared memory teaching must remain reachable to non-managers under `server_memteaching_enabled`,
 * while the Short-Term category remains manager-gated in the route layer.
 * The sibling `/providers` panel exports `managerOnly = true`, so copying it would
 * silently remove teaching from every non-manager in every guild with nothing failing. This gate
 * lives outside the implementation slice for that reason: the manager check for the Short-Term
 * category belongs in the route layer, not in the command's registration.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "discord.js";
import { loadCommandData, ROOT_COMMAND_EXECUTION_KEY } from "@/utils/discord/commandLoader";
import { createMemoriesInteractionRoute } from "@/utils/discord/interactions/memoriesRoutes";
import { parseInteractionRoute, type GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { buildMemoriesRouteId, computeServerStmFingerprint } from "@/utils/discord/memoriesPanelCatalog";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

type RegistrationPayload = {
  name: string;
  contexts?: number[];
  default_member_permissions?: string;
};

function findRegistration(
  registrationData: Awaited<ReturnType<typeof loadCommandData>>["registrationData"],
  name: string,
): RegistrationPayload | undefined {
  return registrationData.find((command) => command.name === name) as unknown as RegistrationPayload | undefined;
}

describe("/memories registration restrictions", () => {
  it("registers /memories with no manager default and no context restriction", async () => {
    const { registrationData } = await loadCommandData();
    const memories = findRegistration(registrationData, "memories");

    expect(memories).toBeDefined();
    if (!memories) return;

    expect(memories.default_member_permissions).toBeUndefined();
    expect(memories.contexts).toBeUndefined();
  }, 30000);

  it("keeps /memories a bare root", async () => {
    const { executionMap } = await loadCommandData();

    expect([...(executionMap.get("memories")?.keys() ?? [])]).toEqual([ROOT_COMMAND_EXECUTION_KEY]);
  }, 30000);

  // The legacy `/memory` root this Wave 5 slice partially dissolved (CRUD gone, transfer leaves kept)
  // is now gone outright: the transfer leaves it retained moved to /export and /import in Wave 7,
  // leaving no enabled subcommand behind. Full dissolution of a root is asserted once, for every such
  // root, by configRegistration.test.ts's DISSOLVED_ROOTS list, so this file no longer restates it.
});

/**
 * The Short-Term category's manager check lives in the route layer, and the route test file that
 * covers it is one a later sub-slice may edit. This copy sits in the planner-owned file so the
 * permission cannot be relaxed by the same change that rewrites its assertion.
 */
describe("/memories Short-Term manager gate", () => {
  const entries = [
    { channelId: "12345678901234567", personaId: 10, personaName: "Sparrow", lastUpdated: 2 },
    { channelId: "12345678901234568", personaId: null, personaName: "Unscoped", lastUpdated: 1 },
  ];

  function buildRoute(cleared: Array<[string, string, number | null]>) {
    return createMemoriesInteractionRoute({
      resolveScope: async (interaction) => ({
        serverId: 1,
        workspaceId: "guild-123",
        guildId: "guild-123",
        userDiscId: interaction.user.id,
        userId: 42,
        canManage: !interaction.guildId || (interaction.memberPermissions?.has("ManageGuild") ?? false),
        isBlacklisted: false,
        memteachingEnabled: true,
        configuredEmbeddingModelId: null,
        personas: [],
        readStatus: "fresh",
      }),
      getStmEntries: async () => entries,
      preWarmServerStm: async () => {},
      getMemoryCountsByLineage: async () => new Map<number, number>(),
      takeCheckboxValues: () => [],
      clearStm: (workspaceId, channelId, personaId) => {
        cleared.push([workspaceId, channelId, personaId]);
      },
      showStmModal: async () => {
        cleared.push(["modal-opened", "", null]);
      },
    });
  }

  function buildInteraction(customId: string, isManager: boolean, isModal: boolean) {
    return {
      id: `stm-gate-${isManager}-${isModal}`,
      customId,
      user: { id: "user-42", username: "user42" },
      guildId: "guild-123",
      memberPermissions: { has: () => isManager },
      deferred: false,
      replied: false,
      isButton: () => !isModal,
      isStringSelectMenu: () => false,
      isModalSubmit: () => isModal,
      deferUpdate: async function (this: { deferred: boolean }) {
        this.deferred = true;
      },
      reply: async () => {},
      editReply: async () => {},
    } as unknown as GlobalRoutableInteraction;
  }

  it("never opens the clear modal or clears an entry for a guild non-manager", async () => {
    const submitId = buildMemoriesRouteId({
      action: "stm-submit",
      locale: "en-US",
      nonce: computeServerStmFingerprint("guild-123", "user-42", entries),
    });
    const openId = buildMemoriesRouteId({ action: "stm-open", locale: "en-US" });

    const denied: Array<[string, string, number | null]> = [];
    const deniedRoute = buildRoute(denied);
    for (const [customId, isModal] of [
      [openId, false],
      [submitId, true],
    ] as const) {
      const parsed = parseInteractionRoute(customId);
      expect(parsed).not.toBeNull();
      if (!parsed) return;
      await deniedRoute.execute({} as Client, buildInteraction(customId, false, isModal), parsed);
    }
    expect(denied).toEqual([]);

    // Non-vacuity: the same dispatch clears every unchecked entry once the actor is a manager.
    const allowed: Array<[string, string, number | null]> = [];
    const parsedSubmit = parseInteractionRoute(submitId);
    expect(parsedSubmit).not.toBeNull();
    if (!parsedSubmit) return;
    await buildRoute(allowed).execute({} as Client, buildInteraction(submitId, true, true), parsedSubmit);
    expect(allowed).toEqual([
      ["guild-123", "12345678901234567", 10],
      ["guild-123", "12345678901234568", null],
    ]);
  }, 30000);
});
