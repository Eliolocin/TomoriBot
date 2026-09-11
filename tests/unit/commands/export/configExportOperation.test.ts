import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Client } from "discord.js";
import { execute as executeConfigExport } from "@/commands/export/config";
import { runConfigExport, type ConfigExportDependencies } from "@/commands/export/configExportOperation";
import { execute as executePersonalConfigExport } from "@/commands/export/personal/config";
import {
  EXPORT_V2_VERSION,
  personalConfigExportSchema,
  workspaceConfigExportDataSchema,
  workspaceConfigExportSchema,
  type ExportResult,
} from "@/types/db/dataExport";
import type { UserRow } from "@/types/db/schema";
import type { StandardEmbedOptions } from "@/types/discord/embed";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";
import { callMethods, type FakeInteraction, makeFakeInteraction } from "../../../helpers/fakeInteraction";

const GUILD_ID = "guild-111111111111111111";
const GUILD_NAME = "lighthouse_lounge";
const ACTOR_ID = "actor-222222222222222222";
const ACTOR_HANDLE = "bau_h";
const LOCALE = "en-US";
const ACTOR = {
  id: ACTOR_ID,
  displayName: "Bau",
  globalName: "Bau",
  username: ACTOR_HANDLE,
  displayAvatarURL: () => "https://cdn.example.com/avatar.png",
};

const WORKSPACE_CONFIG_EXPORT = workspaceConfigExportSchema.parse({
  version: EXPORT_V2_VERSION,
  type: "workspace_config",
  exported_at: "2026-01-01T00:00:00.000Z",
  data: workspaceConfigExportDataSchema.parse({
    // llm_logit_biases sits behind a preprocess, so its default does not fire on an absent key.
    chat: { llm_temperature: 1, humanizer_degree: 1, timezone_offset: 0, llm_logit_biases: [] },
  }),
});

const PERSONAL_CONFIG_EXPORT = personalConfigExportSchema.parse({
  version: EXPORT_V2_VERSION,
  type: "personal_config",
  exported_at: "2026-01-01T00:00:00.000Z",
  data: { profile: { user_nickname: null, language_pref: "en-US" } },
});

const USER_DATA = { user_id: 1, user_disc_id: ACTOR_ID, language_pref: LOCALE } as unknown as UserRow;

interface DeliveredMessage {
  embeds: Array<{ data: { title?: string } }>;
  files: Array<{ name: string; attachment: Buffer }>;
}

interface DependencyCalls {
  workspaceReads: string[];
  personalReads: string[];
  deliveries: DeliveredMessage[];
  replies: StandardEmbedOptions[];
}

interface DependencyOptions {
  workspaceResult?: ExportResult;
  personalResult?: ExportResult;
  deliveryFails?: boolean;
}

/**
 * The repository and delivery seams only. `replyInfoEmbed` is deliberately absent so a test can leave the real
 * interaction sink in place and observe where each receipt actually lands.
 */
function makeCoreDependencies(options: DependencyOptions): {
  deps: Partial<ConfigExportDependencies>;
  calls: DependencyCalls;
} {
  const calls: DependencyCalls = { workspaceReads: [], personalReads: [], deliveries: [], replies: [] };

  return {
    calls,
    deps: {
      exportWorkspaceConfig: mock(async (serverDiscId: string) => {
        calls.workspaceReads.push(serverDiscId);
        return options.workspaceResult ?? { success: true, data: WORKSPACE_CONFIG_EXPORT };
      }),
      exportPersonalConfig: mock(async (userDiscId: string) => {
        calls.personalReads.push(userDiscId);
        return options.personalResult ?? { success: true, data: PERSONAL_CONFIG_EXPORT };
      }),
      deliverDirectMessage: mock(async (_interaction, payload) => {
        calls.deliveries.push(payload as DeliveredMessage);
        if (options.deliveryFails) throw new Error("Cannot send messages to this user");
        return undefined;
      }),
    },
  };
}

function makeDependencies(options: DependencyOptions = {}): {
  deps: Partial<ConfigExportDependencies>;
  calls: DependencyCalls;
} {
  const { deps, calls } = makeCoreDependencies(options);
  deps.replyInfoEmbed = mock(async (_interaction, _locale, embedOptions) => {
    calls.replies.push(embedOptions);
  });
  return { deps, calls };
}

function makeWorkspaceInteraction(options: {
  inGuild: boolean;
  canManageGuild: boolean;
  guildName?: string;
}): FakeInteraction {
  return makeFakeInteraction({
    guildId: options.inGuild ? GUILD_ID : null,
    guild: options.inGuild ? { id: GUILD_ID, name: options.guildName ?? GUILD_NAME } : null,
    user: ACTOR,
    memberPermissions: { has: (flag: unknown) => flag === "ManageGuild" && options.canManageGuild },
  }).interaction;
}

beforeAll(async () => {
  await initializeLocalizer();
});

describe("config export operation", () => {
  it("refuses a workspace export without Manage Server and never reads the configuration", async () => {
    const interaction = makeWorkspaceInteraction({ inGuild: true, canManageGuild: false });
    const { deps, calls } = makeDependencies();

    await runConfigExport(interaction as never, LOCALE, "workspace", deps);

    expect(calls.workspaceReads).toEqual([]);
    expect(calls.deliveries).toEqual([]);
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]).toMatchObject({
      titleKey: "commands.data.export.no_permission_title",
      descriptionKey: "commands.data.export.no_permission_description",
    });
    expect(interaction.deferred).toBe(false);
  });

  it("still refuses when the guild is absent from the client cache", async () => {
    // guildId arrives in the payload while guild is a cache lookup. A guard reading guild would take its DM branch
    // here while the export key still named this guild.
    const interaction = makeWorkspaceInteraction({ inGuild: true, canManageGuild: false });
    interaction.guild = null;
    const { deps, calls } = makeDependencies();

    await runConfigExport(interaction as never, LOCALE, "workspace", deps);

    expect(calls.workspaceReads).toEqual([]);
    expect(calls.replies[0]).toMatchObject({ titleKey: "commands.data.export.no_permission_title" });
  });

  it("exports the workspace configuration to the actor's DMs under a named, timestamped filename", async () => {
    const interaction = makeWorkspaceInteraction({ inGuild: true, canManageGuild: true });
    const { deps, calls } = makeDependencies();

    await runConfigExport(interaction as never, LOCALE, "workspace", deps);

    expect(calls.workspaceReads).toEqual([GUILD_ID]);
    expect(calls.personalReads).toEqual([]);
    expect(calls.deliveries).toHaveLength(1);
    const deliveredFiles = calls.deliveries[0]?.files ?? [];
    expect(deliveredFiles).toHaveLength(1);
    // `/persona export`'s shape: the workspace name, the scope, and an epoch-millisecond stamp for uniqueness.
    expect(deliveredFiles[0]?.name).toMatch(/^tomori-lighthouse_lounge-server-config-\d{13}\.json$/);
    expect(deliveredFiles[0]?.name).not.toContain(GUILD_ID);
    expect(deliveredFiles[0]?.name).not.toContain(ACTOR_ID);
    expect(JSON.parse(deliveredFiles[0]?.attachment.toString("utf8") ?? "{}")).toEqual(WORKSPACE_CONFIG_EXPORT);
    expect(calls.replies[0]).toMatchObject({
      titleKey: "commands.data.export.success_title",
      descriptionKey: "commands.data.export.success_description",
      descriptionVars: { type: localizer(LOCALE, "commands.data.export.type_choice_server_config") },
    });
  });

  it("gives each export of a scope its own filename", async () => {
    const first = makeDependencies();
    const second = makeDependencies();

    await runConfigExport(
      makeWorkspaceInteraction({ inGuild: true, canManageGuild: true }) as never,
      LOCALE,
      "personal",
      first.deps,
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    await runConfigExport(
      makeWorkspaceInteraction({ inGuild: true, canManageGuild: true }) as never,
      LOCALE,
      "personal",
      second.deps,
    );

    const firstFile = first.calls.deliveries[0]?.files[0];
    const secondFile = second.calls.deliveries[0]?.files[0];
    expect(firstFile?.name).toMatch(/^tomori-bau_h-personal-config-\d{13}\.json$/);
    expect(secondFile?.name).not.toBe(firstFile?.name);
  });

  it("sanitizes an arbitrary workspace name into the filename", async () => {
    const hostileNames = [
      "../../etc/passwd",
      "a:b*c?d|e",
      "name\u0000with\u001Fcontrols",
      `emoji-only-${"🌟".repeat(20)}`,
    ];

    for (const guildName of hostileNames) {
      const { deps, calls } = makeDependencies();
      await runConfigExport(
        makeWorkspaceInteraction({ inGuild: true, canManageGuild: true, guildName }) as never,
        LOCALE,
        "workspace",
        deps,
      );

      const fileName = calls.deliveries[0]?.files[0]?.name ?? "";
      expect({ guildName, name: fileName }).toMatchObject({
        guildName,
        name: expect.stringMatching(/^tomori-[\w-]+-server-config-\d{13}\.json$/),
      });
      // The sanitizer is the boundary: none of these characters may survive into the attachment name.
      for (const forbidden of ["/", "\\", ":", "*", "?", "|", "..", " "]) {
        expect({ guildName, forbidden, leaked: fileName.includes(forbidden) }).toEqual({
          guildName,
          forbidden,
          leaked: false,
        });
      }
      expect(fileName.length).toBeLessThan(100);
    }
  });

  it("falls back to the account handle when the guild object is not cached", async () => {
    const interaction = makeWorkspaceInteraction({ inGuild: true, canManageGuild: true });
    const { deps, calls } = makeDependencies();
    interaction.guild = null;

    await runConfigExport(interaction as never, LOCALE, "workspace", deps);

    expect(calls.deliveries[0]?.files[0]?.name).toMatch(/^tomori-bau_h-server-config-\d{13}\.json$/);
  });

  it("acknowledges the interaction before reading the configuration", async () => {
    const interaction = makeWorkspaceInteraction({ inGuild: true, canManageGuild: true });
    const acknowledged: boolean[] = [];
    const { deps } = makeDependencies();
    deps.exportWorkspaceConfig = mock(async () => {
      acknowledged.push(interaction.deferred || interaction.replied);
      return { success: true, data: WORKSPACE_CONFIG_EXPORT };
    });

    await runConfigExport(interaction as never, LOCALE, "workspace", deps);

    expect(acknowledged).toEqual([true]);
  });

  it("treats a missing guild as a DM-backed workspace keyed on the invoking account", async () => {
    const interaction = makeWorkspaceInteraction({ inGuild: false, canManageGuild: false });
    const { deps, calls } = makeDependencies();

    await runConfigExport(interaction as never, LOCALE, "workspace", deps);

    expect(calls.workspaceReads).toEqual([ACTOR_ID]);
    expect(calls.replies[0]).toMatchObject({ titleKey: "commands.data.export.success_title" });
  });

  it("exports personal configuration without any guild permission", async () => {
    const interaction = makeWorkspaceInteraction({ inGuild: true, canManageGuild: false });
    const { deps, calls } = makeDependencies();

    await runConfigExport(interaction as never, LOCALE, "personal", deps);

    expect(calls.personalReads).toEqual([ACTOR_ID]);
    expect(calls.workspaceReads).toEqual([]);
    expect(calls.replies[0]).toMatchObject({
      titleKey: "commands.data.export.success_title",
      descriptionVars: { type: localizer(LOCALE, "commands.data.export.type_choice_personal_settings") },
    });
  });

  it("reports the closed-DM failure even though the export itself succeeded", async () => {
    const interaction = makeWorkspaceInteraction({ inGuild: true, canManageGuild: true });
    const { deps, calls } = makeDependencies({ deliveryFails: true });

    await runConfigExport(interaction as never, LOCALE, "workspace", deps);

    expect(calls.workspaceReads).toEqual([GUILD_ID]);
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]).toMatchObject({
      titleKey: "commands.data.export.dm_failed_title",
      descriptionKey: "commands.data.export.dm_failed_description",
    });
  });

  it("reports a failed export with the repository's own error key and delivers nothing", async () => {
    const interaction = makeWorkspaceInteraction({ inGuild: true, canManageGuild: true });
    const { deps, calls } = makeDependencies({
      workspaceResult: { success: false, error: "commands.data.export.error_no_server_config" },
    });

    await runConfigExport(interaction as never, LOCALE, "workspace", deps);

    expect(calls.deliveries).toEqual([]);
    expect(calls.replies[0]).toMatchObject({
      titleKey: "commands.data.export.failed_title",
      descriptionKey: "commands.data.export.error_no_server_config",
    });
  });

  it("drives the real replyInfoEmbed seam: defer first, then repaint the same private anchor", async () => {
    const { interaction, calls } = makeFakeInteraction({
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      user: ACTOR,
      memberPermissions: { has: () => true },
    });

    await runConfigExport(interaction as never, LOCALE, "workspace", makeCoreDependencies({}).deps);

    expect(callMethods(calls)).toEqual(["deferReply", "editReply"]);
    const editPayload = calls[1]?.args[0] as { embeds: Array<{ data: { title?: string } }> } | undefined;
    expect(editPayload?.embeds[0]?.data.title).toBe(localizer(LOCALE, "commands.data.export.success_title"));
  });

  it("routes each leaf to its own scope and destination", async () => {
    const workspaceInteraction = makeWorkspaceInteraction({ inGuild: true, canManageGuild: true });
    const personalInteraction = makeWorkspaceInteraction({ inGuild: true, canManageGuild: false });
    const workspaceDeps = makeDependencies();
    const personalDeps = makeDependencies();

    await executeConfigExport({} as Client, workspaceInteraction as never, USER_DATA, LOCALE, workspaceDeps.deps);
    await executePersonalConfigExport({} as Client, personalInteraction as never, USER_DATA, LOCALE, personalDeps.deps);

    expect(workspaceDeps.calls.workspaceReads).toEqual([GUILD_ID]);
    expect(personalDeps.calls.personalReads).toEqual([ACTOR_ID]);
    expect(personalDeps.calls.replies[0]).toMatchObject({
      titleKey: "commands.data.export.success_title",
      descriptionVars: { type: localizer(LOCALE, "commands.data.export.type_choice_personal_settings") },
    });
  });

  it("reports a pre-acknowledgement failure with exactly one reply and no deferral", async () => {
    const { interaction, calls } = makeFakeInteraction({
      guildId: GUILD_ID,
      guild: { id: GUILD_ID },
      user: ACTOR,
      memberPermissions: {
        has: () => {
          throw new Error("injected permission lookup failure");
        },
      },
    });

    await runConfigExport(interaction as never, LOCALE, "workspace", makeCoreDependencies({}).deps);

    expect(callMethods(calls)).toEqual(["reply"]);
    const replyPayload = calls[0]?.args[0] as { embeds: Array<{ data: { title?: string } }> } | undefined;
    expect(replyPayload?.embeds[0]?.data.title).toBe(localizer(LOCALE, "general.errors.unknown_error_title"));
  });
});
