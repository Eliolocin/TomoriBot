import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { AutocompleteInteraction, Client } from "discord.js";
import { execute as executeMemoriesExport } from "@/commands/export/memories";
import {
  type MemoryExportDependencies,
  type PersonalMemoryExportMode,
  type WorkspaceMemoryExportMode,
  respondWithMemoryExportPersonas,
  runMemoryExport,
} from "@/commands/export/memoriesExportOperation";
import { execute as executePersonalMemoriesExport } from "@/commands/export/personal/memories";
import {
  EXPORT_V2_VERSION,
  getPersonalMemoriesV2ExportSchema,
  getWorkspaceMemoriesExportSchema,
  type ExportResult,
} from "@/types/db/dataExport";
import type { TomoriState, UserRow } from "@/types/db/schema";
import type { StandardEmbedOptions } from "@/types/discord/embed";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { callMethods, type FakeInteraction, makeFakeInteraction } from "../../../helpers/fakeInteraction";

const GUILD_ID = "guild-111111111111111111";
const GUILD_NAME = "lighthouse_lounge";
const ACTOR_ID = "actor-222222222222222222";
const ACTOR_HANDLE = "jordan_h";
const LOCALE = "en-US";
const ACTOR = {
  id: ACTOR_ID,
  displayName: "Jordan",
  globalName: "Jordan",
  username: ACTOR_HANDLE,
  displayAvatarURL: () => "https://cdn.example.com/avatar.png",
};

const WORKSPACE_MEMORIES_EXPORT = getWorkspaceMemoriesExportSchema().parse({
  version: EXPORT_V2_VERSION,
  type: "workspace_memories",
  exported_at: "2026-01-01T00:00:00.000Z",
  data: { buckets: [{ name: "main", label: "Main Persona", memories: [{ content: "A memory", tags: [] }] }] },
});

const PERSONAL_MEMORIES_EXPORT = getPersonalMemoriesV2ExportSchema().parse({
  version: EXPORT_V2_VERSION,
  type: "personal_memories",
  exported_at: "2026-01-01T00:00:00.000Z",
  data: { buckets: [{ name: "global", label: "Global", memories: [{ content: "A memory", tags: [] }] }] },
});

const USER_DATA = { user_id: 1, user_disc_id: ACTOR_ID, language_pref: LOCALE } as unknown as UserRow;

const WORKSPACE_PERSONAS = [
  { persona_id: 7, persona_lineage_id: 70, persona_nickname: "Sparrow" },
  { persona_id: 8, persona_lineage_id: 80, persona_nickname: "Lighthouse" },
] as unknown as TomoriState[];

interface DeliveredMessage {
  embeds: Array<{ data: { title?: string; description?: string } }>;
  files: Array<{ name: string; attachment: Buffer }>;
}

interface DependencyCalls {
  workspaceReads: Array<{ serverDiscId: string; scope: unknown }>;
  personalReads: Array<{ userDiscId: string; scope: unknown }>;
  personaReads: string[];
  deliveries: DeliveredMessage[];
  replies: StandardEmbedOptions[];
}

interface DependencyOptions {
  workspaceResult?: ExportResult;
  personalResult?: ExportResult;
  personas?: TomoriState[];
  deliveryFails?: boolean;
}

function makeDependencies(options: DependencyOptions = {}): {
  deps: Partial<MemoryExportDependencies>;
  calls: DependencyCalls;
} {
  const calls: DependencyCalls = {
    workspaceReads: [],
    personalReads: [],
    personaReads: [],
    deliveries: [],
    replies: [],
  };

  return {
    calls,
    deps: {
      exportWorkspaceMemories: mock(async (serverDiscId: string, scope: WorkspaceMemoryExportMode) => {
        calls.workspaceReads.push({ serverDiscId, scope });
        return options.workspaceResult ?? { success: true, data: WORKSPACE_MEMORIES_EXPORT };
      }),
      exportPersonalMemories: mock(async (userDiscId: string, scope: PersonalMemoryExportMode) => {
        calls.personalReads.push({ userDiscId, scope });
        return options.personalResult ?? { success: true, data: PERSONAL_MEMORIES_EXPORT };
      }),
      loadWorkspacePersonas: mock(async (workspaceKey: string) => {
        calls.personaReads.push(workspaceKey);
        return options.personas ?? WORKSPACE_PERSONAS;
      }),
      deliverDirectMessage: mock(async (_interaction, payload) => {
        calls.deliveries.push(payload as DeliveredMessage);
        if (options.deliveryFails) throw new Error("Cannot send messages to this user");
        return undefined;
      }),
      replyInfoEmbed: mock(async (_interaction, _locale, embedOptions) => {
        calls.replies.push(embedOptions);
      }),
    },
  };
}

function makeInteraction(options: {
  inGuild: boolean;
  canManageGuild: boolean;
  scope?: string | null;
  persona?: string | null;
  guildName?: string;
}): FakeInteraction {
  return makeFakeInteraction({
    guildId: options.inGuild ? GUILD_ID : null,
    guild: options.inGuild ? { id: GUILD_ID, name: options.guildName ?? GUILD_NAME } : null,
    user: ACTOR,
    memberPermissions: { has: (flag: unknown) => flag === "ManageGuild" && options.canManageGuild },
    options: {
      getString: (name: string) => (name === "scope" ? (options.scope ?? null) : (options.persona ?? null)),
      getBoolean: () => null,
    } as FakeInteraction["options"],
  }).interaction;
}

function makeAutocompleteInteraction(options: { inGuild: boolean; focused?: string }): {
  interaction: AutocompleteInteraction;
  answers: string[][];
} {
  const answers: string[][] = [];
  const interaction = {
    guildId: options.inGuild ? GUILD_ID : null,
    user: { id: ACTOR_ID },
    options: { getFocused: () => options.focused ?? "" },
    respond: async (choices: Array<{ value: string }>) => {
      answers.push(choices.map((choice) => choice.value));
    },
  };
  return { interaction: interaction as unknown as AutocompleteInteraction, answers };
}

beforeAll(async () => {
  await initializeLocalizer();
});

describe("memory export operation", () => {
  it("refuses a workspace export without Manage Server and never reads memories", async () => {
    const interaction = makeInteraction({ inGuild: true, canManageGuild: false, scope: "all" });
    const { deps, calls } = makeDependencies();

    await runMemoryExport(interaction as never, LOCALE, "workspace", "all", null, deps);

    expect(calls.workspaceReads).toEqual([]);
    expect(calls.deliveries).toEqual([]);
    expect(calls.replies[0]).toMatchObject({
      titleKey: "commands.data.export.no_permission_title",
      descriptionKey: "commands.data.export.no_permission_description",
    });
    expect(interaction.deferred).toBe(false);
  });

  it("still refuses when the guild is absent from the client cache", async () => {
    const interaction = makeInteraction({ inGuild: true, canManageGuild: false, scope: "all" });
    interaction.guild = null;
    const { deps, calls } = makeDependencies();

    await runMemoryExport(interaction as never, LOCALE, "workspace", "all", null, deps);

    expect(calls.workspaceReads).toEqual([]);
    expect(calls.replies[0]).toMatchObject({ titleKey: "commands.data.export.no_permission_title" });
  });

  it("exports the main persona scope under a named, timestamped filename that carries no snowflake", async () => {
    const interaction = makeInteraction({ inGuild: true, canManageGuild: true, scope: "main" });
    const { deps, calls } = makeDependencies();

    await runMemoryExport(interaction as never, LOCALE, "workspace", "main", null, deps);

    expect(calls.workspaceReads).toEqual([{ serverDiscId: GUILD_ID, scope: { mode: "main" } }]);
    expect(calls.personalReads).toEqual([]);
    const deliveredFile = calls.deliveries[0]?.files[0];
    expect(deliveredFile?.name).toMatch(/^tomori-lighthouse_lounge-server-memories-\d{13}\.json$/);
    expect(deliveredFile?.name).not.toContain(GUILD_ID);
    expect(deliveredFile?.name).not.toContain(ACTOR_ID);
    expect(JSON.parse(deliveredFile?.attachment.toString("utf8") ?? "{}")).toEqual(WORKSPACE_MEMORIES_EXPORT);
  });

  it("states in the delivered message that documents and personas are excluded", async () => {
    const interaction = makeInteraction({ inGuild: true, canManageGuild: true, scope: "all" });
    const { deps, calls } = makeDependencies();

    await runMemoryExport(interaction as never, LOCALE, "workspace", "all", null, deps);

    expect(calls.deliveries[0]?.embeds[0]?.data.description).toBe(
      localizer(LOCALE, "commands.transfer.memory_export_dm_description", {
        type: localizer(LOCALE, "commands.transfer.workspace_memories_label"),
      }),
    );
    expect(calls.deliveries[0]?.embeds[0]?.data.description).toContain("Documents and personas are not included");
    expect(calls.replies[0]).toMatchObject({
      titleKey: "commands.data.export.success_title",
      descriptionVars: { type: localizer(LOCALE, "commands.transfer.workspace_memories_label") },
    });
  });

  it("maps every workspace scope selection onto its own repository mode", async () => {
    const cases: Array<{ selection: string; persona: string | null; scope: unknown }> = [
      { selection: "main", persona: null, scope: { mode: "main" } },
      { selection: "persona", persona: "8", scope: { mode: "persona", personaId: 8 } },
      { selection: "all", persona: null, scope: { mode: "all" } },
    ];

    for (const testCase of cases) {
      const interaction = makeInteraction({
        inGuild: true,
        canManageGuild: true,
        scope: testCase.selection,
        persona: testCase.persona,
      });
      const { deps, calls } = makeDependencies();

      await runMemoryExport(interaction as never, LOCALE, "workspace", testCase.selection, testCase.persona, deps);

      expect({ case: testCase.selection, reads: calls.workspaceReads }).toEqual({
        case: testCase.selection,
        reads: [{ serverDiscId: GUILD_ID, scope: testCase.scope }],
      });
    }
  });

  it("refuses the Selected Persona scope without a usable persona value and reads nothing", async () => {
    for (const persona of [null, "", "0", "not-a-number"]) {
      const interaction = makeInteraction({ inGuild: true, canManageGuild: true, scope: "persona", persona });
      const { deps, calls } = makeDependencies();

      await runMemoryExport(interaction as never, LOCALE, "workspace", "persona", persona, deps);

      expect({ persona, reads: calls.workspaceReads, personaReads: calls.personaReads }).toEqual({
        persona,
        reads: [],
        personaReads: [],
      });
      expect({ persona, titleKey: calls.replies[0]?.titleKey }).toEqual({
        persona,
        titleKey: "commands.transfer.memory_export_persona_required_title",
      });
    }
  });

  it("refuses a scope value outside the domain's own vocabulary", async () => {
    // `global` is the personal domain's account-wide scope and names no workspace namespace, so it must not fall
    // through to a default workspace read.
    const interaction = makeInteraction({ inGuild: true, canManageGuild: true, scope: "global" });
    const { deps, calls } = makeDependencies();

    await runMemoryExport(interaction as never, LOCALE, "workspace", "global", null, deps);

    expect(calls.workspaceReads).toEqual([]);
    expect(calls.replies[0]).toMatchObject({ titleKey: "general.errors.invalid_option_title" });
  });

  it("resolves a personal Selected Persona to its lineage through a fresh workspace read", async () => {
    const interaction = makeInteraction({ inGuild: true, canManageGuild: false, scope: "persona", persona: "8" });
    const { deps, calls } = makeDependencies();

    await runMemoryExport(interaction as never, LOCALE, "personal", "persona", "8", deps);

    expect(calls.personaReads).toEqual([GUILD_ID]);
    expect(calls.personalReads).toEqual([{ userDiscId: ACTOR_ID, scope: { mode: "persona", personaLineageId: 80 } }]);
    expect(calls.workspaceReads).toEqual([]);
  });

  it("refuses a personal persona that this workspace does not hold", async () => {
    const interaction = makeInteraction({ inGuild: true, canManageGuild: false, scope: "persona", persona: "9" });
    const { deps, calls } = makeDependencies();

    await runMemoryExport(interaction as never, LOCALE, "personal", "persona", "9", deps);

    expect(calls.personaReads).toEqual([GUILD_ID]);
    expect(calls.personalReads).toEqual([]);
    expect(calls.replies[0]).toMatchObject({ titleKey: "commands.transfer.memory_export_persona_invalid_title" });
  });

  it("refuses a personal persona whose lineage is unusable", async () => {
    const personas = [{ persona_id: 8, persona_nickname: "Lighthouse" }] as unknown as TomoriState[];
    const interaction = makeInteraction({ inGuild: true, canManageGuild: false, scope: "persona", persona: "8" });
    const { deps, calls } = makeDependencies({ personas });

    await runMemoryExport(interaction as never, LOCALE, "personal", "persona", "8", deps);

    expect(calls.personalReads).toEqual([]);
    expect(calls.replies[0]).toMatchObject({ titleKey: "commands.transfer.memory_export_persona_invalid_title" });
  });

  it("maps every personal scope selection onto its own repository mode", async () => {
    const cases: Array<{ selection: string; persona: string | null; scope: unknown }> = [
      { selection: "global", persona: null, scope: { mode: "global" } },
      { selection: "persona", persona: "7", scope: { mode: "persona", personaLineageId: 70 } },
      { selection: "all", persona: null, scope: { mode: "all" } },
    ];

    for (const testCase of cases) {
      const interaction = makeInteraction({
        inGuild: true,
        canManageGuild: false,
        scope: testCase.selection,
        persona: testCase.persona,
      });
      const { deps, calls } = makeDependencies();

      await runMemoryExport(interaction as never, LOCALE, "personal", testCase.selection, testCase.persona, deps);

      expect({ case: testCase.selection, reads: calls.personalReads }).toEqual({
        case: testCase.selection,
        reads: [{ userDiscId: ACTOR_ID, scope: testCase.scope }],
      });
    }
  });

  it("keys a DM-backed workspace on the invoking account and exports without a permission check", async () => {
    const interaction = makeInteraction({ inGuild: false, canManageGuild: false, scope: "all" });
    const { deps, calls } = makeDependencies();

    await runMemoryExport(interaction as never, LOCALE, "workspace", "all", null, deps);

    expect(calls.workspaceReads).toEqual([{ serverDiscId: ACTOR_ID, scope: { mode: "all" } }]);
    expect(calls.replies[0]).toMatchObject({ titleKey: "commands.data.export.success_title" });
  });

  it("acknowledges the interaction before reading memories", async () => {
    const interaction = makeInteraction({ inGuild: true, canManageGuild: true, scope: "all" });
    const { deps } = makeDependencies();
    const acknowledged: boolean[] = [];
    deps.exportWorkspaceMemories = mock(async () => {
      acknowledged.push(interaction.deferred || interaction.replied);
      return { success: true, data: WORKSPACE_MEMORIES_EXPORT };
    });

    await runMemoryExport(interaction as never, LOCALE, "workspace", "all", null, deps);

    expect(acknowledged).toEqual([true]);
  });

  it("reports the closed-DM failure even though the export itself succeeded", async () => {
    const interaction = makeInteraction({ inGuild: true, canManageGuild: true, scope: "all" });
    const { deps, calls } = makeDependencies({ deliveryFails: true });

    await runMemoryExport(interaction as never, LOCALE, "workspace", "all", null, deps);

    expect(calls.workspaceReads).toHaveLength(1);
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]).toMatchObject({
      titleKey: "commands.data.export.dm_failed_title",
      descriptionKey: "commands.data.export.dm_failed_description",
    });
  });

  it("reports a failed export with the repository's own error key and delivers nothing", async () => {
    const interaction = makeInteraction({ inGuild: true, canManageGuild: true, scope: "all" });
    const { deps, calls } = makeDependencies({
      workspaceResult: { success: false, error: "commands.data.export.error_no_server_data" },
    });

    await runMemoryExport(interaction as never, LOCALE, "workspace", "all", null, deps);

    expect(calls.deliveries).toEqual([]);
    expect(calls.replies[0]).toMatchObject({
      titleKey: "commands.data.export.failed_title",
      descriptionKey: "commands.data.export.error_no_server_data",
    });
  });

  it("drives the real replyInfoEmbed seam: defer first, then repaint the same private anchor", async () => {
    const { interaction, calls } = makeFakeInteraction({
      guildId: GUILD_ID,
      guild: { id: GUILD_ID, name: GUILD_NAME },
      user: ACTOR,
      memberPermissions: { has: () => true },
      options: {
        getString: (name: string) => (name === "scope" ? "all" : null),
        getBoolean: () => null,
      } as FakeInteraction["options"],
    });
    const { deps } = makeDependencies();
    delete deps.replyInfoEmbed;

    await runMemoryExport(interaction as never, LOCALE, "workspace", "all", null, deps);

    expect(callMethods(calls)).toEqual(["deferReply", "editReply"]);
    const editPayload = calls[1]?.args[0] as { embeds: Array<{ data: { title?: string } }> } | undefined;
    expect(editPayload?.embeds[0]?.data.title).toBe(localizer(LOCALE, "commands.data.export.success_title"));
  });

  it("routes each leaf to its own scope and destination", async () => {
    const workspaceInteraction = makeInteraction({ inGuild: true, canManageGuild: true, scope: "main" });
    const personalInteraction = makeInteraction({ inGuild: true, canManageGuild: false, scope: "global" });
    const workspaceDeps = makeDependencies();
    const personalDeps = makeDependencies();

    await executeMemoriesExport({} as Client, workspaceInteraction as never, USER_DATA, LOCALE, workspaceDeps.deps);
    await executePersonalMemoriesExport(
      {} as Client,
      personalInteraction as never,
      USER_DATA,
      LOCALE,
      personalDeps.deps,
    );

    expect(workspaceDeps.calls.workspaceReads).toEqual([{ serverDiscId: GUILD_ID, scope: { mode: "main" } }]);
    expect(personalDeps.calls.personalReads).toEqual([{ userDiscId: ACTOR_ID, scope: { mode: "global" } }]);
    expect(personalDeps.calls.replies[0]).toMatchObject({
      descriptionVars: { type: localizer(LOCALE, "commands.transfer.personal_memories_label") },
    });
  });
});

describe("memory export persona autocomplete", () => {
  it("lists this workspace's personas and keys a DM-backed workspace on the actor", async () => {
    const guildCase = makeAutocompleteInteraction({ inGuild: true });
    const guildDeps = makeDependencies();

    await respondWithMemoryExportPersonas(guildCase.interaction, guildDeps.deps);

    expect(guildDeps.calls.personaReads).toEqual([GUILD_ID]);
    expect(guildCase.answers).toEqual([["7", "8"]]);

    const dmCase = makeAutocompleteInteraction({ inGuild: false });
    const dmDeps = makeDependencies();
    await respondWithMemoryExportPersonas(dmCase.interaction, dmDeps.deps);
    expect(dmDeps.calls.personaReads).toEqual([ACTOR_ID]);
  });

  it("ranks an exact nickname first and caps the answer at Discord's 25-choice ceiling", async () => {
    const personas = [
      ...Array.from({ length: 40 }, (_unused, index) => ({
        persona_id: index + 1,
        persona_lineage_id: index + 1,
        persona_nickname: `Sparrow ${index}`,
      })),
      { persona_id: 99, persona_lineage_id: 99, persona_nickname: "Sparrow" },
    ] as unknown as TomoriState[];
    const { interaction, answers } = makeAutocompleteInteraction({ inGuild: true, focused: "sparrow" });
    const { deps } = makeDependencies({ personas });

    await respondWithMemoryExportPersonas(interaction, deps);

    expect(answers[0]).toHaveLength(25);
    expect(answers[0]?.[0]).toBe("99");
  });

  it("answers with an empty list when the persona read fails", async () => {
    const { interaction, answers } = makeAutocompleteInteraction({ inGuild: true });
    const { deps } = makeDependencies();
    deps.loadWorkspacePersonas = mock(async () => {
      throw new Error("injected persona read failure");
    });

    await expect(respondWithMemoryExportPersonas(interaction, deps)).resolves.toBeUndefined();

    expect(answers).toEqual([[]]);
  });

  it("answers empty rather than throwing when the interaction can no longer be answered", async () => {
    const { interaction } = makeAutocompleteInteraction({ inGuild: true });
    const { deps } = makeDependencies();
    deps.loadWorkspacePersonas = mock(async () => {
      throw new Error("injected persona read failure");
    });
    (interaction as unknown as { respond: () => Promise<void> }).respond = async () => {
      throw new Error("Unknown interaction");
    };

    await expect(respondWithMemoryExportPersonas(interaction, deps)).resolves.toBeUndefined();
  });
});
