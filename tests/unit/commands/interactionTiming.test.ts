/**
 * Interaction Timing Contract Tests
 *
 * Verifies that command execute() functions follow the Discord acknowledgement
 * rules documented in docs/subsystems/command-system.md:
 *
 *   Contract 1: Modal commands: showModal() fires without a preceding deferReply().
 *   Contract 2: Async commands: deferReply() is the first call; editReply() follows.
 *   Contract 3: Guard paths: a single reply() is the only acknowledgement;
 *                no interaction is acknowledged twice.
 *
 * All tests use the fake interaction harness from tests/helpers/fakeInteraction.ts
 * and do not connect to Discord or a database.
 */

import { describe, expect, it, mock } from "bun:test";
import type { Client } from "discord.js";
import type { UserRow } from "@/types/db/schema";
import { makeFakeInteraction, callMethods } from "../../helpers/fakeInteraction";
import { createScopedModuleMocker, overrideMembers, stubLogMembers } from "../../helpers/mockSurface";
// Real namespaces captured at link time, before any `mock.module` below runs.
// Spreading them keeps each factory full-surface: `mock.module` is process-global
// and never restored, so an omitted export breaks files loaded later.
import * as realTomoriStateCache from "@/utils/cache/tomoriStateCache";
import * as realRepositories from "@/utils/db/repositories";
import * as realInteractionCore from "@/utils/discord/ui/interactionCore";
import * as realLocalizer from "@/utils/text/localizer";

// All mock.module() calls are hoisted by bun before static imports are resolved.
// They must appear before the first dynamic import() of any command module.
//
// Key design choice: mock @/utils/discord/ui/interactionCore rather than the
// individual barrel re-exports (ui/modals, ui/embeds, ui/buttons, etc.).
// The barrels just re-export from interactionCore, so mocking the source once
// keeps all import paths consistent and avoids "ambiguous multiple bindings"
// errors that arise when two barrels independently re-export the same name
// (e.g. safeSelectOptionText) while one of them is replaced with a mock.

// The real `ColorCode` enum passes through the spread, keeping its hex STRING
// values for modules that call string methods on them at load time (e.g.
// contextEmbeds.ts does ColorCode.ERROR.replace("#", "")).
const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/text/localizer": realLocalizer,
  "@/utils/discord/ui/interactionCore": realInteractionCore,
  "@/utils/cache/tomoriStateCache": realTomoriStateCache,
  "@/utils/db/repositories": realRepositories,
});

stubLogMembers({
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  success: () => undefined,
  section: () => undefined,
});

scopedMock.module("@/utils/text/localizer", () => ({
  ...realLocalizer,
  /**
   * Returns the key so assertions don't depend on locale file content.
   * Image-footer keys are rendered because generated image payload tests can run
   * after this global module mock in the same Bun process.
   */
  localizer: (_locale: string, key: string, vars?: Record<string, string>) => {
    if (key === "tools.image.generated_after_seconds_line") {
      return `Generated after ${vars?.seconds ?? ""} seconds`;
    }
    if (key === "tools.image.referenced_identities_line") {
      return `Referenced: ${vars?.names ?? ""}`;
    }
    return key;
  },
  initializeLocalizer: async () => undefined,
}));

/**
 * interactionCore mock: the single source that all UI barrels re-export from.
 * Mocking here ensures ui/modals, ui/embeds, ui/buttons, etc. all see the same
 * stub without creating duplicate-binding conflicts in the barrel chain.
 *
 * replyInfoEmbed faithfully replicates state-based routing so reply() / editReply()
 * calls still show up in the fake interaction's calls array.
 * promptWithRawModal and promptWithPaginatedModal call showModal() then return
 * "timeout" so commands exit cleanly without a real awaitModalSubmit loop.
 */
scopedMock.module("@/utils/discord/ui/interactionCore", () => ({
  ...realInteractionCore,
  // Used directly by commands under test.
  replyInfoEmbed: async (
    interaction: {
      deferred: boolean;
      replied: boolean;
      reply: (...a: unknown[]) => Promise<void>;
      editReply: (...a: unknown[]) => Promise<void>;
    },
    _locale: string,
    _options: unknown,
    _flags?: unknown,
  ) => {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({});
    } else {
      await interaction.reply({});
    }
  },
  promptWithRawModal: async (
    interaction: { showModal: (...a: unknown[]) => Promise<void> },
    _locale: string,
    _options: unknown,
    _flags?: unknown,
  ) => {
    await interaction.showModal({});
    return { outcome: "timeout" as const };
  },
  promptWithPaginatedModal: async (
    interaction: { showModal: (...a: unknown[]) => Promise<void> },
    _locale: string,
    _options: unknown,
  ) => {
    await interaction.showModal({});
    return { outcome: "timeout" as const };
  },
  safeSelectOptionText: (text: string) => text,
  replySummaryEmbed: async () => undefined,
  replyComponentsV2Status: async () => undefined,
  updateButtonComponentsV2Status: async () => undefined,
  acknowledgeModalSubmitForRefresh: async () => undefined,
  promptWithConfirmation: async () => ({ confirmed: false }),
  promptWithUnacknowledgedConfirmation: async () => ({ confirmed: false }),
  promptWithModal: async (
    interaction: { showModal: (...a: unknown[]) => Promise<void> },
    _locale: string,
    _options: unknown,
  ) => {
    await interaction.showModal({});
    return { outcome: "timeout" as const };
  },
  replyPaginatedChoices: async () => ({ outcome: "timeout" }),
  replyPaginatedPersonaChoicesV2: async () => ({ outcome: "timeout", reason: "timeout" }),
  replyPaginatedStatusPages: async () => undefined,
}));

/** Fake Tomori state returned by cache lookups: has the fields /nsfw jailbreaks reads. */
const fakeTomoriState = {
  server_id: 1,
  persona_id: 1,
  persona_nickname: "Tomori",
  is_alter: false,
  config: {
    uncensor_injection_enabled: false,
    uncensor_unicode_space_enabled: false,
    uncensor_sanitize_enabled: false,
  },
};

scopedMock.module("@/utils/cache/tomoriStateCache", () => ({
  ...realTomoriStateCache,
  getCachedTomoriState: async () => fakeTomoriState,
  invalidateTomoriStateCache: () => undefined,
  getLastDbError: () => null,
}));

/**
 * Repositories mock. Bun's mock registry is global across files and the last
 * mock.module call for a path wins, so this must not rely on another file's
 * factory. It spreads the real barrel and delegates through each repository
 * instance's prototype, overriding only the methods these commands drive.
 *
 * Commands under test:
 *   /nsfw jailbreaks : imports configRepository (never calls it in our paths)
 *   /ping            : no repository imports
 *   /comment         : no repository imports
 */
scopedMock.module("@/utils/db/repositories", () => ({
  ...realRepositories,
  configRepository: overrideMembers(realRepositories.configRepository, {
    updateNsfwConfig: async () => true,
  }),
  personaRepository: overrideMembers(realRepositories.personaRepository, {
    loadAllForServer: async () => [],
    hasNicknameConflict: async () => false,
    renamePersona: async () => true,
    addTrigger: async () => true,
  }),
  llmProviderRepo: overrideMembers(realRepositories.llmProviderRepo, {
    loadSavedProviderConfig: async () => null,
  }),
  userRepository: overrideMembers(realRepositories.userRepository, {
    loadOrCreateUser: async () => null,
    updateLastSeen: async () => undefined,
  }),
  serverRepository: overrideMembers(realRepositories.serverRepository, {
    loadServerState: async () => null,
  }),
}));

/** Minimal UserRow that satisfies the execute() signature. */
function makeUserData(): UserRow {
  return {
    user_id: 1,
    user_disc_id: "fake_user_id",
    language_pref: "en-US",
  } as unknown as UserRow;
}

/** Empty Client stub: commands that don't use the client still receive one. */
function makeClient(): Client {
  return {} as unknown as Client;
}

/**
 * Fake guild channel whose `type` value passes isGuildMessageCommandChannel()
 * (ChannelType.GuildText = 0) without requiring a mock of that module.
 */
function makeFakeGuildChannel(): object {
  return {
    type: 0, // ChannelType.GuildText
    id: "fake_channel_id",
    send: async () => ({ id: "sent_msg_id" }),
  };
}

// Pattern 3 (command-system.md): the first interaction acknowledgement must be
// showModal(). No deferReply() should appear before or instead of the modal.

describe("Contract 1: modal command /nsfw jailbreaks", () => {
  it("calls showModal() as the only interaction acknowledgement", async () => {
    // Arrange: channel present so the command reaches the modal call
    const { interaction, calls } = makeFakeInteraction({
      guild: { id: "guild_1" },
      channel: makeFakeGuildChannel(),
      guildId: "guild_1",
      user: {
        id: "fake_user_id",
        displayName: "TestUser",
        globalName: "TestUser",
        username: "testuser",
        displayAvatarURL: () => "https://cdn.example.com/avatar.png",
      },
    });

    const { execute } = await import("@/commands/nsfw/jailbreaks");
    await execute(makeClient(), interaction as never, makeUserData(), "en-US");

    // Assert: the only acknowledgement call is showModal
    expect(callMethods(calls)).toEqual(["showModal"]);
  });

  it("does not call deferReply() before showModal()", async () => {
    const { interaction, calls } = makeFakeInteraction({
      guild: { id: "guild_1" },
      channel: makeFakeGuildChannel(),
      guildId: "guild_1",
      user: {
        id: "fake_user_id",
        displayName: "TestUser",
        globalName: "TestUser",
        username: "testuser",
        displayAvatarURL: () => "https://cdn.example.com/avatar.png",
      },
    });

    const { execute } = await import("@/commands/nsfw/jailbreaks");
    await execute(makeClient(), interaction as never, makeUserData(), "en-US");

    const methods = callMethods(calls);
    const deferIndex = methods.indexOf("deferReply");
    const modalIndex = methods.indexOf("showModal");

    // showModal must appear; deferReply must NOT appear before it (or at all)
    expect(modalIndex).toBeGreaterThanOrEqual(0);
    expect(deferIndex).toBe(-1);
  });

  it("does not call reply() on the slash interaction", async () => {
    const { interaction, calls } = makeFakeInteraction({
      guild: { id: "guild_1" },
      channel: makeFakeGuildChannel(),
      guildId: "guild_1",
      user: {
        id: "fake_user_id",
        displayName: "TestUser",
        globalName: "TestUser",
        username: "testuser",
        displayAvatarURL: () => "https://cdn.example.com/avatar.png",
      },
    });

    const { execute } = await import("@/commands/nsfw/jailbreaks");
    await execute(makeClient(), interaction as never, makeUserData(), "en-US");

    // reply() and deferReply() are mutually exclusive only showModal() is expected
    expect(callMethods(calls)).not.toContain("reply");
    expect(callMethods(calls)).not.toContain("deferReply");
  });
});

// Pattern 2 (command-system.md): deferReply() must be the very first call.
// All async work (fetchReply, latency measurement) happens after the deferral.
// The final response goes through editReply(), not reply().

describe("Contract 2: async defer command /ping", () => {
  it("calls deferReply() as the first acknowledgement", async () => {
    const { interaction, calls } = makeFakeInteraction();

    const { execute } = await import("@/commands/ping");
    await execute(makeClient(), interaction as never, makeUserData(), "en-US");

    expect(calls[0]?.method).toBe("deferReply");
  });

  it("follows deferReply() with editReply() — not a second reply()", async () => {
    const { interaction, calls } = makeFakeInteraction();

    const { execute } = await import("@/commands/ping");
    await execute(makeClient(), interaction as never, makeUserData(), "en-US");

    const methods = callMethods(calls);
    // deferReply first, editReply second
    expect(methods[0]).toBe("deferReply");
    expect(methods[1]).toBe("editReply");
    // reply() must never appear alongside deferReply()
    expect(methods).not.toContain("reply");
  });

  it("produces exactly two acknowledgement calls: deferReply then editReply", async () => {
    const { interaction, calls } = makeFakeInteraction();

    const { execute } = await import("@/commands/ping");
    await execute(makeClient(), interaction as never, makeUserData(), "en-US");

    expect(callMethods(calls)).toEqual(["deferReply", "editReply"]);
  });
});

// ─── Contract 3: Guard-path no-double-ack: /comment ─────────────────────
//
// Pattern 1 / Pattern 5 (command-system.md): fast validation paths that exit
// early must use a single reply(). The normal async path must defer first and
// never double-acknowledge the same interaction.

describe("Contract 3: /comment acknowledgement ordering", () => {
  it("non-guild early-exit: sends exactly one reply() with no prior deferReply()", async () => {
    // Arrange: no guild → command hits the guild-only guard and returns after replyInfoEmbed
    const { interaction, calls } = makeFakeInteraction({
      guild: null,
      channel: null,
    });

    const { execute } = await import("@/commands/comment");
    await execute(makeClient(), interaction as never, makeUserData(), "en-US");

    const methods = callMethods(calls);
    // Exactly one acknowledgement: reply() from replyInfoEmbed
    expect(methods).toEqual(["reply"]);
    // Never deferred: the guard fires before any async work
    expect(methods).not.toContain("deferReply");
  });

  it("non-guild path: interaction is not acknowledged twice", async () => {
    const { interaction, calls } = makeFakeInteraction({
      guild: null,
      channel: null,
    });

    const { execute } = await import("@/commands/comment");
    await execute(makeClient(), interaction as never, makeUserData(), "en-US");

    const methods = callMethods(calls);
    // reply() and deferReply() must not both appear (double-ack)
    const hasReply = methods.includes("reply");
    const hasDefer = methods.includes("deferReply");
    expect(hasReply && hasDefer).toBe(false);
  });

  it("normal path: deferReply() is first; editReply() follows; no reply() present", async () => {
    // Arrange: guild + valid channel so the command reaches deferReply
    const fakeChannel = makeFakeGuildChannel();
    const { interaction, calls } = makeFakeInteraction({
      guild: { id: "guild_1" },
      channel: fakeChannel,
      guildId: "guild_1",
      user: {
        id: "fake_user_id",
        displayName: "TestUser",
        globalName: "TestUser",
        username: "testuser",
        displayAvatarURL: () => "https://cdn.example.com/avatar.png",
      },
      member: {
        displayAvatarURL: () => "https://cdn.example.com/member_avatar.png",
      },
      options: {
        getString: (_name: string, _required?: boolean) => "This is a test comment.",
        getBoolean: () => null,
      },
    });

    const { execute } = await import("@/commands/comment");
    await execute(makeClient(), interaction as never, makeUserData(), "en-US");

    const methods = callMethods(calls);

    // Defer is first (before any async work like channel.send)
    expect(methods[0]).toBe("deferReply");

    // editReply appears as the final acknowledgement (via replyInfoEmbed after defer)
    expect(methods).toContain("editReply");

    // reply() must not appear: using editReply after deferReply is the correct pattern
    expect(methods).not.toContain("reply");
  });

  it("normal path: interaction is not double-acknowledged", async () => {
    const fakeChannel = makeFakeGuildChannel();
    const { interaction, calls } = makeFakeInteraction({
      guild: { id: "guild_1" },
      channel: fakeChannel,
      guildId: "guild_1",
      user: {
        id: "fake_user_id",
        displayName: "TestUser",
        globalName: "TestUser",
        username: "testuser",
        displayAvatarURL: () => "https://cdn.example.com/avatar.png",
      },
      member: {
        displayAvatarURL: () => "https://cdn.example.com/member_avatar.png",
      },
      options: {
        getString: (_name: string, _required?: boolean) => "Double-ack check.",
        getBoolean: () => null,
      },
    });

    const { execute } = await import("@/commands/comment");
    await execute(makeClient(), interaction as never, makeUserData(), "en-US");

    const methods = callMethods(calls);
    // reply() and deferReply() must never both appear on the same interaction
    expect(methods.filter((m) => m === "reply").length).toBe(0);
    expect(methods.filter((m) => m === "deferReply").length).toBeLessThanOrEqual(1);
  });
});
