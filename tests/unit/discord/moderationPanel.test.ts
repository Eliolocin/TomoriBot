import { beforeAll, describe, expect, it } from "bun:test";
import { type ActionRowData, type ButtonComponentData, ButtonStyle, ChannelType, ComponentType } from "discord.js";
import { CooldownType } from "@/types/db/schema";
import {
  buildMemberAccessModalFieldId,
  buildModerationCustomId,
  buildQuotaModalFieldId,
  buildUserBlacklistAddModalFieldId,
  buildWhitelistChannelAddModalFieldId,
  buildWhitelistRoleAddModalFieldId,
  parseModerationPanelRoute,
} from "@/utils/discord/moderationPanelCatalog";
import {
  buildMemberAccessModal,
  buildModerationRemovalModal,
  buildModerationPanelPayload,
  buildPersonaChannelAddModal,
  buildQuotaEditModal,
  buildUserBlacklistAddModal,
  buildWhitelistChannelAddModal,
  buildWhitelistRoleAddModal,
} from "@/utils/discord/ui/moderationPanel";
import type { ModerationScopeData } from "@/utils/moderation/moderationOperations";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function createScopeData(overrides: Partial<ModerationScopeData> = {}): ModerationScopeData {
  return {
    guildId: "12345",
    serverId: 1,
    readStatus: "fresh",
    serverModelAccess: { allowServerModels: true },
    memberAccess: {
      serverMemteachingEnabled: true,
      attributeMemteachingEnabled: false,
      sampledialogueMemteachingEnabled: true,
      promptSnapshotEnabled: false,
    },
    userBlacklist: {
      personalizationUserIds: [],
      personaBlocks: [],
      personalMemoriesEnabled: true,
    },
    whitelist: {
      channels: [],
      personaChannels: [],
      roles: [],
      personaNames: new Map([[1, "Tomori"]]),
    },
    quotas: {
      image: { daily_user_quota: 5, serverwide_quota: 50, serverwide_quota_resets_in: 30 },
      text: { daily_user_quota: 10, serverwide_quota: 100, serverwide_quota_resets_in: 7 },
      video: { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 },
    },
    ...overrides,
  };
}

describe("moderationPanelCatalog route codec", () => {
  it("encodes and decodes category switch routes", () => {
    const customId = buildModerationCustomId("category", "en-US", "member-access");
    expect(customId).toBe("moderation:v1:category:en-US:member-access");
    expect(customId.length).toBeLessThanOrEqual(100);

    const parsed = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["category", "en-US", "member-access"],
    });
    expect(parsed).toEqual({ action: "category", locale: "en-US", category: "member-access" });
  });

  it("encodes and decodes select-page routes", () => {
    const customId = buildModerationCustomId("select-page", "en-US");
    expect(customId).toBe("moderation:v1:select-page:en-US");

    const parsed = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["select-page", "en-US"],
    });
    expect(parsed).toEqual({ action: "select-page", locale: "en-US" });
  });

  it("encodes and decodes whitelist page routes", () => {
    const customId = buildModerationCustomId("page", "en-US", "channels");
    expect(customId).toBe("moderation:v1:page:en-US:channels");

    const parsed = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["page", "en-US", "channels"],
    });
    expect(parsed).toEqual({ action: "page", locale: "en-US", page: "channels" });
  });

  it("encodes and decodes range navigation routes", () => {
    const customId = buildModerationCustomId("range", "en-US", "whitelist", "channels", 2);
    expect(customId).toBe("moderation:v1:range:en-US:whitelist:channels:2");

    const parsed = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["range", "en-US", "whitelist", "channels", "2"],
    });
    expect(parsed).toEqual({
      action: "range",
      locale: "en-US",
      category: "whitelist",
      page: "channels",
      rangeIndex: 2,
    });
  });

  it("encodes and decodes retry routes", () => {
    const customId = buildModerationCustomId("retry", "en-US", "user-blacklist", "none");
    expect(customId).toBe("moderation:v1:retry:en-US:user-blacklist:none");

    const parsed = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["retry", "en-US", "user-blacklist", "none"],
    });
    expect(parsed).toEqual({
      action: "retry",
      locale: "en-US",
      category: "user-blacklist",
      page: "none",
    });
  });

  it("encodes and decodes member-access routes", () => {
    const openId = buildModerationCustomId("member-access-open", "en-US");
    expect(openId).toBe("moderation:v1:member-access-open:en-US");
    expect(openId.length).toBeLessThanOrEqual(100);

    const parsedOpen = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-open", "en-US"],
    });
    expect(parsedOpen).toEqual({ action: "member-access-open", locale: "en-US" });

    const submitId = buildModerationCustomId("member-access-submit", "en-US", "nonce123");
    expect(submitId).toBe("moderation:v1:member-access-submit:en-US:nonce123");
    expect(submitId.length).toBeLessThanOrEqual(100);

    const parsedSubmit = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["member-access-submit", "en-US", "nonce123"],
    });
    expect(parsedSubmit).toEqual({ action: "member-access-submit", locale: "en-US", nonce: "nonce123" });
  });

  it("encodes and decodes user-blacklist-add routes", () => {
    const openId = buildModerationCustomId("user-blacklist-add-open", "en-US");
    expect(openId).toBe("moderation:v1:user-blacklist-add-open:en-US");
    expect(openId.length).toBeLessThanOrEqual(100);

    const parsedOpen = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["user-blacklist-add-open", "en-US"],
    });
    expect(parsedOpen).toEqual({ action: "user-blacklist-add-open", locale: "en-US" });

    const submitId = buildModerationCustomId("user-blacklist-add-submit", "en-US", "nonce456");
    expect(submitId).toBe("moderation:v1:user-blacklist-add-submit:en-US:nonce456");
    expect(submitId.length).toBeLessThanOrEqual(100);

    const parsedSubmit = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["user-blacklist-add-submit", "en-US", "nonce456"],
    });
    expect(parsedSubmit).toEqual({ action: "user-blacklist-add-submit", locale: "en-US", nonce: "nonce456" });
  });

  it("encodes and decodes user-blacklist-remove routes", () => {
    const promptPersId = buildModerationCustomId(
      "user-blacklist-remove-prompt",
      "en-US",
      "personalization",
      "123456789012345678",
    );
    expect(promptPersId).toBe("moderation:v1:user-blacklist-remove-prompt:en-US:personalization:123456789012345678");
    expect(promptPersId.length).toBeLessThanOrEqual(100);

    const parsedPromptPers = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["user-blacklist-remove-prompt", "en-US", "personalization", "123456789012345678"],
    });
    expect(parsedPromptPers).toEqual({
      action: "user-blacklist-remove-prompt",
      locale: "en-US",
      target: { source: "personalization", userId: "123456789012345678" },
    });

    const promptBlockId = buildModerationCustomId(
      "user-blacklist-remove-prompt",
      "en-US",
      "persona-block",
      42,
      "123456789012345678",
    );
    expect(promptBlockId).toBe("moderation:v1:user-blacklist-remove-prompt:en-US:persona-block:42:123456789012345678");
    expect(promptBlockId.length).toBeLessThanOrEqual(100);

    const parsedPromptBlock = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["user-blacklist-remove-prompt", "en-US", "persona-block", "42", "123456789012345678"],
    });
    expect(parsedPromptBlock).toEqual({
      action: "user-blacklist-remove-prompt",
      locale: "en-US",
      target: { source: "persona-block", personaId: 42, userId: "123456789012345678" },
    });

    const confirmId = buildModerationCustomId(
      "user-blacklist-remove-confirm",
      "en-US",
      "personalization",
      "123456789012345678",
    );
    expect(confirmId).toBe("moderation:v1:user-blacklist-remove-confirm:en-US:personalization:123456789012345678");
    expect(confirmId.length).toBeLessThanOrEqual(100);

    const parsedConfirm = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["user-blacklist-remove-confirm", "en-US", "personalization", "123456789012345678"],
    });
    expect(parsedConfirm).toEqual({
      action: "user-blacklist-remove-confirm",
      locale: "en-US",
      target: { source: "personalization", userId: "123456789012345678" },
    });

    const cancelId = buildModerationCustomId("user-blacklist-remove-cancel", "en-US");
    expect(cancelId).toBe("moderation:v1:user-blacklist-remove-cancel:en-US");
    expect(cancelId.length).toBeLessThanOrEqual(100);

    const parsedCancel = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["user-blacklist-remove-cancel", "en-US"],
    });
    expect(parsedCancel).toEqual({
      action: "user-blacklist-remove-cancel",
      locale: "en-US",
    });
  });

  it("decodes bulk removal and persona add routes through the real catalog", () => {
    for (const action of [
      "user-blacklist-remove-submit",
      "whitelist-channel-remove-submit",
      "whitelist-role-remove-submit",
      "persona-channel-remove-submit",
      "persona-channel-add-submit",
    ] as const) {
      expect(
        parseModerationPanelRoute({
          namespace: "moderation",
          version: "v1",
          segments: [action, "en-US", "nonce_bulk"],
        }),
      ).toEqual({ action, locale: "en-US", nonce: "nonce_bulk" });
    }
    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v1",
        segments: ["persona-channel-add-open", "en-US"],
      }),
    ).toEqual({ action: "persona-channel-add-open", locale: "en-US" });
  });

  it("encodes and decodes whitelist-channel routes", () => {
    const openId = buildModerationCustomId("whitelist-channel-add-open", "en-US");
    expect(openId).toBe("moderation:v1:whitelist-channel-add-open:en-US");
    expect(openId.length).toBeLessThanOrEqual(100);

    const parsedOpen = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["whitelist-channel-add-open", "en-US"],
    });
    expect(parsedOpen).toEqual({ action: "whitelist-channel-add-open", locale: "en-US" });

    const submitId = buildModerationCustomId("whitelist-channel-add-submit", "en-US", "nonce789");
    expect(submitId).toBe("moderation:v1:whitelist-channel-add-submit:en-US:nonce789");
    expect(submitId.length).toBeLessThanOrEqual(100);

    const parsedSubmit = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["whitelist-channel-add-submit", "en-US", "nonce789"],
    });
    expect(parsedSubmit).toEqual({ action: "whitelist-channel-add-submit", locale: "en-US", nonce: "nonce789" });

    const promptId = buildModerationCustomId("whitelist-channel-remove-prompt", "en-US", "123456789012345678");
    expect(promptId).toBe("moderation:v1:whitelist-channel-remove-prompt:en-US:123456789012345678");
    expect(promptId.length).toBeLessThanOrEqual(100);

    const parsedPrompt = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["whitelist-channel-remove-prompt", "en-US", "123456789012345678"],
    });
    expect(parsedPrompt).toEqual({
      action: "whitelist-channel-remove-prompt",
      locale: "en-US",
      channelId: "123456789012345678",
    });

    const confirmId = buildModerationCustomId("whitelist-channel-remove-confirm", "en-US", "123456789012345678");
    expect(confirmId).toBe("moderation:v1:whitelist-channel-remove-confirm:en-US:123456789012345678");
    expect(confirmId.length).toBeLessThanOrEqual(100);

    const parsedConfirm = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["whitelist-channel-remove-confirm", "en-US", "123456789012345678"],
    });
    expect(parsedConfirm).toEqual({
      action: "whitelist-channel-remove-confirm",
      locale: "en-US",
      channelId: "123456789012345678",
    });

    const cancelId = buildModerationCustomId("whitelist-channel-remove-cancel", "en-US");
    expect(cancelId).toBe("moderation:v1:whitelist-channel-remove-cancel:en-US");

    const parsedCancel = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["whitelist-channel-remove-cancel", "en-US"],
    });
    expect(parsedCancel).toEqual({
      action: "whitelist-channel-remove-cancel",
      locale: "en-US",
    });

    expect(buildWhitelistChannelAddModalFieldId("nonce123", "channel")).toBe("whitelist_channel_add_channel_nonce123");
    expect(buildWhitelistChannelAddModalFieldId("nonce123", "type")).toBe("whitelist_channel_add_type_nonce123");
    expect(buildWhitelistChannelAddModalFieldId("nonce123", "length")).toBe("whitelist_channel_add_length_nonce123");
  });

  it("encodes and decodes whitelist-role routes", () => {
    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-role-add-open", "en-US"],
      }),
    ).toEqual({ action: "whitelist-role-add-open", locale: "en-US" });
    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-role-add-submit", "en-US", "nonce123"],
      }),
    ).toEqual({ action: "whitelist-role-add-submit", locale: "en-US", nonce: "nonce123" });
    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-role-remove-prompt", "en-US", "123456789012345678"],
      }),
    ).toEqual({ action: "whitelist-role-remove-prompt", locale: "en-US", roleId: "123456789012345678" });
    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v1",
        segments: ["whitelist-role-remove-confirm", "en-US", "123456789012345678"],
      }),
    ).toEqual({ action: "whitelist-role-remove-confirm", locale: "en-US", roleId: "123456789012345678" });
    expect(buildWhitelistRoleAddModalFieldId("nonce123")).toBe("whitelist_role_add_role_nonce123");
  });

  it("rejects malformed routes and unknown versions", () => {
    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v2",
        segments: ["category", "en-US", "member-access"],
      }),
    ).toBeNull();
    expect(
      parseModerationPanelRoute({
        namespace: "other",
        version: "v1",
        segments: ["category", "en-US", "member-access"],
      }),
    ).toBeNull();
    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v1",
        segments: ["category", "invalid-locale", "member-access"],
      }),
    ).toBeNull();
    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v1",
        segments: ["category", "en-US", "invalid-category"],
      }),
    ).toBeNull();
    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v1",
        segments: ["range", "en-US", "whitelist", "channels", "-1"],
      }),
    ).toBeNull();
    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v1",
        segments: ["member-access-submit", "en-US"],
      }),
    ).toBeNull();
  });
});

describe("moderationPanel UI rendering", () => {
  it("renders member access category with exact semantic status sentences and inline-code permission name", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "member-access",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData(),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Server Moderation");
    expect(serialized).toContain("### Member Access Settings");
    expect(serialized).toContain(
      "### Member Access Settings\\nConfigure permissions for members without `Manage Server`.",
    );
    expect(serialized).not.toContain("> Configure permissions");
    expect(serialized).toContain("> 🟢 Members can manage server memories and documents.");
    expect(serialized).toContain("> 🔴 Members cannot manage persona attributes.");
    expect(serialized).toContain("> 🟢 Members can manage persona sample dialogues.");
    expect(serialized).toContain("> 🔴 Members cannot create prompt snapshots.");
    expect(serialized).toContain("Edit Permissions");
    expect(serialized).toContain('"customId":"moderation:v1:member-access-open:en-US"');
    expect(serialized).toContain('"disabled":false');

    expect(serialized).toContain(
      `"style":${ButtonStyle.Secondary},"customId":"moderation:v1:category:en-US:whitelist"`,
    );

    const container = payload.components[payload.components.length - 1] as {
      type: number;
      components: Array<{ type: number; divider?: boolean; spacing?: number; content?: string }>;
    };
    expect(container.components[0].type).toBe(ComponentType.ActionRow);
    expect(container.components[1].type).toBe(ComponentType.Separator);
    expect(container.components[1].divider).toBe(true);
    expect(container.components[1].spacing).toBe(1);
    expect(container.components[2].type).toBe(ComponentType.TextDisplay);
    expect(container.components[2].content).toBe("## Server Moderation");
  });

  it("states server model access positively and makes only the inactive choice clickable", () => {
    const allowed = JSON.stringify(
      buildModerationPanelPayload({
        locale: "en-US",
        category: "member-access",
        whitelistPage: "channels",
        rangeIndex: 0,
        data: createScopeData({ serverModelAccess: { allowServerModels: true } }),
      }),
    );
    const required = JSON.stringify(
      buildModerationPanelPayload({
        locale: "en-US",
        category: "member-access",
        whitelistPage: "channels",
        rangeIndex: 0,
        data: createScopeData({ serverModelAccess: { allowServerModels: false } }),
      }),
    );

    expect(allowed).toContain("Server model access");
    // The status row matches its four Member Access siblings, emoji included.
    expect(allowed).toContain("🟢 Server members may use this server's models.");
    expect(required).toContain("🔴 Server members cannot use this server's models (personal providers are required).");

    // Exactly one button, naming the transition away from the current policy.
    expect(allowed).toContain('"customId":"moderation:v1:model-access-set:en-US:require-personal"');
    expect(allowed).toContain('"label":"Disable Server Models"');
    expect(allowed).not.toContain("model-access-set:en-US:allow");
    expect(required).toContain('"customId":"moderation:v1:model-access-set:en-US:allow"');
    expect(required).toContain('"label":"Allow Server Models"');
    expect(required).not.toContain("model-access-set:en-US:require-personal");
  });

  it("renders opposite member access status sentence variants across all four flags", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "member-access",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        memberAccess: {
          serverMemteachingEnabled: false,
          attributeMemteachingEnabled: true,
          sampledialogueMemteachingEnabled: false,
          promptSnapshotEnabled: true,
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("> 🔴 Members cannot manage server memories and documents.");
    expect(serialized).toContain("> 🟢 Members can manage persona attributes.");
    expect(serialized).toContain("> 🔴 Members cannot manage persona sample dialogues.");
    expect(serialized).toContain("> 🟢 Members can create prompt snapshots.");
  });

  it("renders user blacklist category empty state with inline-code counter, bold section labels, and no literal ####", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData(),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Blacklisted Members `(0)`");
    expect(serialized).toContain("**Personalization Blacklist**");
    expect(serialized).not.toContain("####");
    expect(serialized).toContain("No members blacklisted from personalization.");
    expect(serialized).not.toContain("> No members blacklisted");
    expect(serialized).not.toContain("I do not load personal memories or saved names for these members:");
    expect(serialized).toContain("**Persona User Blocks**");
    expect(serialized).toContain("No active persona user blocks.");
    expect(serialized).not.toContain("> No active persona");
    expect(serialized).not.toContain("The following members have persona-specific");
    expect(serialized).not.toContain("•");
    expect(serialized).toContain("+ Add Blacklist");
    expect(serialized).toContain("- Remove Blacklist");
  });

  it("renders both blacklist sections in a populated view with bold section labels and inline-code counter", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        userBlacklist: {
          personalizationUserIds: ["p-user-1", "p-user-2"],
          personaBlocks: [
            {
              server_id: 1,
              persona_id: 1,
              user_disc_id: "block-user-1",
              block_type: "mute",
              reason: "test reason",
              expires_at: new Date(Date.now() + 100000),
              created_at: new Date(),
              updated_at: new Date(),
              persona_name: "Tomori",
            },
          ],
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Blacklisted Members `(3)`");
    expect(serialized).toContain("**Personalization Blacklist**");
    expect(serialized).toContain("I do not load personal memories or saved names for these members:");
    expect(serialized).not.toContain("####");
    expect(serialized).toContain("> <@p-user-1>");
    expect(serialized).toContain("> <@p-user-2>");
    expect(serialized).not.toContain("(`p-user-1`)");
    expect(serialized).not.toContain("(`p-user-2`)");
    expect(serialized).toContain("**Persona User Blocks**");
    expect(serialized).toContain("The following members have persona-specific");
    expect(serialized).toContain("> <@block-user-1> for **Tomori** (mute)");
    expect(serialized).not.toContain("(`block-user-1`)");
    expect(serialized).not.toContain("—");
    expect(serialized).not.toContain("No members blacklisted from personalization.");
    expect(serialized).not.toContain("No active persona user blocks.");
    expect(serialized).toContain("Tomori");
    expect(serialized).not.toContain("•");
  });

  it("renders persona blocks when personalization blacklist is empty with inline-code counter", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        userBlacklist: {
          personalizationUserIds: [],
          personaBlocks: [
            {
              server_id: 1,
              persona_id: 1,
              user_disc_id: "block-user-1",
              block_type: "mute",
              reason: "test reason",
              expires_at: new Date(Date.now() + 100000),
              created_at: new Date(),
              updated_at: new Date(),
              persona_name: "Tomori",
            },
          ],
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Blacklisted Members `(1)`");
    expect(serialized).toContain("**Personalization Blacklist**");
    expect(serialized).not.toContain("I do not load personal memories or saved names for these members:");
    expect(serialized).toContain("No members blacklisted from personalization.");
    expect(serialized).toContain("**Persona User Blocks**");
    expect(serialized).toContain("The following members have persona-specific");
    expect(serialized).toContain("> <@block-user-1> for **Tomori** (mute)");
    expect(serialized).not.toContain("No active persona user blocks.");
  });

  it("renders user blacklist entries and range pagination when over budget with inline-code counter", () => {
    const userIds = Array.from({ length: 15 }, (_, i) => `user-${i + 1}`);
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        userBlacklist: {
          personalizationUserIds: userIds,
          personaBlocks: [],
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Blacklisted Members `(15)`");
    expect(serialized).toContain("I do not load personal memories or saved names for these members:");
    expect(serialized).toContain("> <@user-1>");
    expect(serialized).toContain("> <@user-10>");
    expect(serialized).not.toContain("(`user-1`)");
    expect(serialized).not.toContain("(`user-10`)");
    expect(serialized).not.toContain("user-11");
    expect(serialized).not.toContain("The following members have persona-specific");
    expect(serialized).toContain("No active persona user blocks.");
    expect(serialized).toContain("Page 1 of 2");
    expect(serialized).toContain("moderation:v1:range:en-US:user-blacklist:none:1");
    expect(serialized).not.toContain("•");
  });

  it("keeps both blacklist section headers visible on page 1 when personalization rows exceed the budget and shows remaining rows on page 2", () => {
    const userIds = Array.from({ length: 12 }, (_, i) => `p-user-${i + 1}`);
    const personaBlock = {
      server_id: 1,
      persona_id: 1,
      user_disc_id: "block-user-1",
      block_type: "mute" as const,
      reason: "test reason",
      expires_at: new Date(Date.now() + 100000),
      created_at: new Date(),
      updated_at: new Date(),
      persona_name: "Tomori",
    };

    const scopeData = createScopeData({
      userBlacklist: {
        personalizationUserIds: userIds,
        personaBlocks: [personaBlock],
      },
    });

    const page1Payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: scopeData,
    });

    const page1Serialized = JSON.stringify(page1Payload);
    expect(page1Serialized).toContain("### Blacklisted Members `(13)`");
    expect(page1Serialized).toContain("**Personalization Blacklist**");
    expect(page1Serialized).toContain("I do not load personal memories or saved names for these members:");
    expect(page1Serialized).not.toContain("####");
    expect(page1Serialized).toContain("> <@p-user-1>");
    expect(page1Serialized).toContain("> <@p-user-10>");
    expect(page1Serialized).not.toContain("(`p-user-1`)");
    expect(page1Serialized).not.toContain("(`p-user-10`)");
    expect(page1Serialized).not.toContain("p-user-11");
    expect(page1Serialized).not.toContain("p-user-12");

    expect(page1Serialized).toContain("**Persona User Blocks**");
    expect(page1Serialized).toContain("The following members have persona-specific");
    expect(page1Serialized).not.toContain("<@block-user-1>");
    expect(page1Serialized).not.toContain("No active persona user blocks.");
    expect(page1Serialized).toContain("Page 1 of 2");
    expect(page1Serialized).not.toContain("•");

    const page2Payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 1,
      data: scopeData,
    });

    const page2Serialized = JSON.stringify(page2Payload);
    expect(page2Serialized).toContain("### Blacklisted Members `(13)`");
    expect(page2Serialized).toContain("**Personalization Blacklist**");
    expect(page2Serialized).toContain("I do not load personal memories or saved names for these members:");
    expect(page2Serialized).toContain("> <@p-user-11>");
    expect(page2Serialized).toContain("> <@p-user-12>");
    expect(page2Serialized).not.toContain("(`p-user-11`)");
    expect(page2Serialized).not.toContain("(`p-user-12`)");
    expect(page2Serialized).not.toContain("p-user-10");
    expect(page2Serialized).not.toContain("No members blacklisted from personalization.");

    expect(page2Serialized).toContain("**Persona User Blocks**");
    expect(page2Serialized).toContain("The following members have persona-specific");
    expect(page2Serialized).toContain("> <@block-user-1> for **Tomori** (mute)");
    expect(page2Serialized).not.toContain("(`block-user-1`)");
    expect(page2Serialized).not.toContain("—");
    expect(page2Serialized).toContain("Tomori");
    expect(page2Serialized).toContain("Page 2 of 2");
    expect(page2Serialized).not.toContain("•");
  });

  it("clamps out-of-range user blacklist route when rows disappear and renders surviving row with inline-code counter", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 5,
      data: createScopeData({
        userBlacklist: {
          personalizationUserIds: ["surviving-user"],
          personaBlocks: [],
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Blacklisted Members `(1)`");
    expect(serialized).toContain("I do not load personal memories or saved names for these members:");
    expect(serialized).toContain("> <@surviving-user>");
    expect(serialized).not.toContain("(`surviving-user`)");
    expect(serialized).not.toContain("•");
  });

  it("clamps out-of-range whitelist channels route when rows disappear and renders surviving row with inline-code counter", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "channels",
      rangeIndex: 5,
      data: createScopeData({
        whitelist: {
          channels: [
            {
              server_id: 1,
              channel_disc_id: "surviving-channel",
              cooldown_type: null,
              cooldown_length: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          personaChannels: [],
          roles: [],
          personaNames: new Map(),
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Whitelisted Channels `(1)`");
    expect(serialized).toContain("I can only be triggered in the following channels:");
    expect(serialized).toContain("> <#surviving-channel>");
    expect(serialized).not.toContain("(`surviving-channel`)");
    expect(serialized).toContain("> Inherited server global cooldown");
    expect(serialized).not.toContain("•");
  });

  it("renders whitelist channels page empty state and populated state with inline-code counters and cooldowns", () => {
    const emptyPayload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData(),
    });

    const emptySerialized = JSON.stringify(emptyPayload);
    expect(emptySerialized).toContain("### Whitelisted Channels `(0)`");
    expect(emptySerialized).toContain("No channels are whitelisted.");
    expect(emptySerialized).not.toContain("> No channels are whitelisted.");
    expect(emptySerialized).not.toContain("I can only be triggered in the following channels:");

    const populatedPayload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        whitelist: {
          channels: [
            {
              server_id: 1,
              channel_disc_id: "ch-1",
              cooldown_type: null,
              cooldown_length: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
            {
              server_id: 1,
              channel_disc_id: "ch-2",
              cooldown_type: CooldownType.PER_USER,
              cooldown_length: 15,
              created_at: new Date(),
              updated_at: new Date(),
            },
            {
              server_id: 1,
              channel_disc_id: "ch-3",
              cooldown_type: CooldownType.OFF,
              cooldown_length: 0,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          personaChannels: [],
          roles: [],
          personaNames: new Map(),
        },
      }),
    });

    const serialized = JSON.stringify(populatedPayload);
    expect(serialized).toContain("### Whitelisted Channels `(3)`");
    expect(serialized).toContain("I can only be triggered in the following channels:");
    expect(serialized).toContain("> <#ch-1>\\n> Inherited server global cooldown");
    expect(serialized).toContain("> <#ch-2>\\n> Cooldown: Per-User, 15s");
    expect(serialized).toContain("> <#ch-3>\\n> Cooldown: Off, Instant");
    expect(serialized).not.toContain("(`ch-1`)");
    expect(serialized).not.toContain("(`ch-2`)");
    expect(serialized).not.toContain("(`ch-3`)");
    expect(serialized).not.toContain("No channels are whitelisted.");
    expect(serialized).not.toContain("•");
  });

  it("renders whitelist persona channels page with grouped restrictions and inline-code counter", () => {
    const emptyPayload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "persona-channels",
      rangeIndex: 0,
      data: createScopeData(),
    });

    const emptySerialized = JSON.stringify(emptyPayload);
    expect(emptySerialized).toContain("### Personas `(0)`");
    expect(emptySerialized).toContain("No persona channel restrictions configured.");
    expect(emptySerialized).not.toContain("The following personas can only respond in their listed channels:");

    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "persona-channels",
      rangeIndex: 0,
      data: createScopeData({
        whitelist: {
          channels: [],
          personaChannels: [
            { server_id: 1, persona_id: 1, channel_disc_id: "ch-a", created_at: new Date() },
            { server_id: 1, persona_id: 1, channel_disc_id: "ch-b", created_at: new Date() },
          ],
          roles: [],
          personaNames: new Map([[1, "Tomori"]]),
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Personas `(1)`");
    expect(serialized).toContain("The following personas can only respond in their listed channels:");
    expect(serialized).toContain("> **Tomori** restricted to: <#ch-a>, <#ch-b>");
    expect(serialized).not.toContain("No persona channel restrictions configured.");
    expect(serialized).not.toContain("•");
  });

  it("renders whitelist roles page with inline-code counter", () => {
    const emptyPayload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "roles",
      rangeIndex: 0,
      data: createScopeData(),
    });

    const emptySerialized = JSON.stringify(emptyPayload);
    expect(emptySerialized).toContain("### Whitelisted Roles `(0)`");
    expect(emptySerialized).toContain("No roles are whitelisted.");
    expect(emptySerialized).not.toContain("Only the following roles can trigger me:");

    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "roles",
      rangeIndex: 0,
      data: createScopeData({
        whitelist: {
          channels: [],
          personaChannels: [],
          roles: [
            { server_id: 1, role_disc_id: "role-1", created_at: new Date(), updated_at: new Date() },
            { server_id: 1, role_disc_id: "role-2", created_at: new Date(), updated_at: new Date() },
          ],
          personaNames: new Map(),
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Whitelisted Roles `(2)`");
    expect(serialized).toContain("Only the following roles can trigger me:");
    expect(serialized).toContain("> <@&role-1>");
    expect(serialized).toContain("> <@&role-2>");
    expect(serialized).toContain("moderation:v1:whitelist-role-remove-open:en-US");
    expect(serialized).not.toContain("whitelist-role-remove-prompt");
    expect(serialized).toContain("moderation:v1:whitelist-role-add-open:en-US");
    expect(serialized).not.toContain("(`role-1`)");
    expect(serialized).not.toContain("(`role-2`)");
    expect(serialized).not.toContain("No roles are whitelisted.");
    expect(serialized).not.toContain("•");
  });

  it("renders a separate role removal confirmation", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "roles",
      rangeIndex: 0,
      roleRemoveTarget: "123456789012345678",
      data: createScopeData({
        whitelist: {
          channels: [],
          personaChannels: [],
          roles: [
            {
              server_id: 1,
              role_disc_id: "123456789012345678",
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          personaNames: new Map(),
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Remove Whitelisted Role");
    expect(serialized).toContain("<@&123456789012345678>");
    expect(serialized).toContain("moderation:v1:whitelist-role-remove-confirm:en-US:123456789012345678");
    expect(serialized).toContain("moderation:v1:whitelist-role-remove-cancel:en-US");
  });

  it("renders unavailable read status with retry button and top separator", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "member-access",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({ readStatus: "unavailable" }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Moderation settings could not be loaded.");
    expect(serialized).toContain("Retry");
    expect(serialized).toContain("moderation:v1:retry:en-US:member-access:none");
    expect(serialized).not.toContain("Members can manage server memories");

    const container = payload.components[payload.components.length - 1] as {
      type: number;
      components: Array<{ type: number; divider?: boolean; spacing?: number }>;
    };
    expect(container.components[0].type).toBe(ComponentType.ActionRow);
    expect(container.components[1].type).toBe(ComponentType.Separator);
    expect(container.components[1].divider).toBe(true);
    expect(container.components[1].spacing).toBe(1);
  });

  it("renders stale read status warning while visibly retaining semantic status sentences", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "member-access",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        readStatus: "stale",
        memberAccess: {
          serverMemteachingEnabled: true,
          attributeMemteachingEnabled: true,
          sampledialogueMemteachingEnabled: false,
          promptSnapshotEnabled: true,
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Saved data may be out of date because the read failed.");
    expect(serialized).toContain("> 🟢 Members can manage server memories and documents.");
    expect(serialized).toContain("> 🟢 Members can manage persona attributes.");
    expect(serialized).toContain("> 🔴 Members cannot manage persona sample dialogues.");
    expect(serialized).toContain("> 🟢 Members can create prompt snapshots.");
  });

  it("proves implemented actions follow read freshness", () => {
    const freshMemberAccessPayload = buildModerationPanelPayload({
      locale: "en-US",
      category: "member-access",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({ readStatus: "fresh" }),
    });
    const freshContainer = freshMemberAccessPayload.components.find((c) => "components" in c) as
      | { components: Array<ActionRowData<ButtonComponentData> | { type: number; content?: string }> }
      | undefined;
    const freshEditActionRow = freshContainer?.components.find(
      (comp): comp is ActionRowData<ButtonComponentData> =>
        comp.type === ComponentType.ActionRow &&
        "components" in comp &&
        Array.isArray(comp.components) &&
        comp.components.some((btn) => "label" in btn && btn.label === "Edit Permissions"),
    );
    const freshEditButton = freshEditActionRow?.components.find(
      (btn): btn is ButtonComponentData => "label" in btn && btn.label === "Edit Permissions",
    );
    expect(freshEditButton).toBeDefined();
    expect(freshEditButton?.disabled).toBe(false);

    const staleMemberAccessPayload = buildModerationPanelPayload({
      locale: "en-US",
      category: "member-access",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({ readStatus: "stale" }),
    });
    const staleContainer = staleMemberAccessPayload.components.find((c) => "components" in c) as
      | { components: Array<ActionRowData<ButtonComponentData> | { type: number; content?: string }> }
      | undefined;
    const staleEditActionRow = staleContainer?.components.find(
      (comp): comp is ActionRowData<ButtonComponentData> =>
        comp.type === ComponentType.ActionRow &&
        "components" in comp &&
        Array.isArray(comp.components) &&
        comp.components.some((btn) => "label" in btn && btn.label === "Edit Permissions"),
    );
    const staleEditButton = staleEditActionRow?.components.find(
      (btn): btn is ButtonComponentData => "label" in btn && btn.label === "Edit Permissions",
    );
    expect(staleEditButton).toBeDefined();
    expect(staleEditButton?.disabled).toBe(true);

    const freshBlacklistPayload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({ readStatus: "fresh" }),
    });
    const freshBlacklistContainer = freshBlacklistPayload.components.find((c) => "components" in c) as
      | { components: Array<ActionRowData<ButtonComponentData> | { type: number; content?: string }> }
      | undefined;
    const freshBlacklistRow = freshBlacklistContainer?.components.find(
      (comp): comp is ActionRowData<ButtonComponentData> =>
        comp.type === ComponentType.ActionRow &&
        "components" in comp &&
        Array.isArray(comp.components) &&
        comp.components.some((btn) => "label" in btn && btn.label === "+ Add Blacklist"),
    );
    const freshBlacklistButton = freshBlacklistRow?.components.find(
      (btn): btn is ButtonComponentData => "label" in btn && btn.label === "+ Add Blacklist",
    );
    expect(freshBlacklistButton).toBeDefined();
    expect(freshBlacklistButton?.disabled).toBe(false);
    expect(freshBlacklistButton?.customId).toBe("moderation:v1:user-blacklist-add-open:en-US");

    const staleBlacklistPayload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({ readStatus: "stale" }),
    });
    const staleBlacklistContainer = staleBlacklistPayload.components.find((c) => "components" in c) as
      | { components: Array<ActionRowData<ButtonComponentData> | { type: number; content?: string }> }
      | undefined;
    const staleBlacklistRow = staleBlacklistContainer?.components.find(
      (comp): comp is ActionRowData<ButtonComponentData> =>
        comp.type === ComponentType.ActionRow &&
        "components" in comp &&
        Array.isArray(comp.components) &&
        comp.components.some((btn) => "label" in btn && btn.label === "+ Add Blacklist"),
    );
    const staleBlacklistButton = staleBlacklistRow?.components.find(
      (btn): btn is ButtonComponentData => "label" in btn && btn.label === "+ Add Blacklist",
    );
    expect(staleBlacklistButton).toBeDefined();
    expect(staleBlacklistButton?.disabled).toBe(true);

    const freshChannelPayload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({ readStatus: "fresh" }),
    });
    const freshChannelContainer = freshChannelPayload.components.find((c) => "components" in c) as
      | { components: Array<ActionRowData<ButtonComponentData> | { type: number; content?: string }> }
      | undefined;
    const freshChannelRow = freshChannelContainer?.components.find(
      (comp): comp is ActionRowData<ButtonComponentData> =>
        comp.type === ComponentType.ActionRow &&
        "components" in comp &&
        Array.isArray(comp.components) &&
        comp.components.some((btn) => "label" in btn && btn.label === "+ Add or Edit Channel"),
    );
    const freshChannelButton = freshChannelRow?.components.find(
      (btn): btn is ButtonComponentData => "label" in btn && btn.label === "+ Add or Edit Channel",
    );
    expect(freshChannelButton).toBeDefined();
    expect(freshChannelButton?.disabled).toBe(false);
    expect(freshChannelButton?.customId).toBe("moderation:v1:whitelist-channel-add-open:en-US");

    const staleChannelPayload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({ readStatus: "stale" }),
    });
    const staleChannelContainer = staleChannelPayload.components.find((c) => "components" in c) as
      | { components: Array<ActionRowData<ButtonComponentData> | { type: number; content?: string }> }
      | undefined;
    const staleChannelRow = staleChannelContainer?.components.find(
      (comp): comp is ActionRowData<ButtonComponentData> =>
        comp.type === ComponentType.ActionRow &&
        "components" in comp &&
        Array.isArray(comp.components) &&
        comp.components.some((btn) => "label" in btn && btn.label === "+ Add or Edit Channel"),
    );
    const staleChannelButton = staleChannelRow?.components.find(
      (btn): btn is ButtonComponentData => "label" in btn && btn.label === "+ Add or Edit Channel",
    );
    expect(staleChannelButton).toBeDefined();
    expect(staleChannelButton?.disabled).toBe(true);

    const personaChannelViews: Array<{
      category: "whitelist";
      whitelistPage: "persona-channels";
      actionLabel: string;
    }> = [{ category: "whitelist", whitelistPage: "persona-channels", actionLabel: "+ Add Persona" }];

    for (const readStatus of ["fresh", "stale"] as const) {
      for (const view of personaChannelViews) {
        const payload = buildModerationPanelPayload({
          locale: "en-US",
          category: view.category,
          whitelistPage: view.whitelistPage,
          rangeIndex: 0,
          data: createScopeData({ readStatus }),
        });

        const container = payload.components.find((c) => "components" in c) as
          | { components: Array<ActionRowData<ButtonComponentData> | { type: number; content?: string }> }
          | undefined;
        expect(container).toBeDefined();

        const actionRowWithButton = container?.components.find(
          (comp): comp is ActionRowData<ButtonComponentData> =>
            comp.type === ComponentType.ActionRow &&
            "components" in comp &&
            Array.isArray(comp.components) &&
            comp.components.some((btn) => "label" in btn && btn.label === view.actionLabel),
        );

        expect(actionRowWithButton).toBeDefined();
        const button = actionRowWithButton?.components.find(
          (btn): btn is ButtonComponentData => "label" in btn && btn.label === view.actionLabel,
        );
        expect(button).toBeDefined();
        expect(button?.disabled).toBe(readStatus !== "fresh");
        expect(button?.customId).toBe("moderation:v1:persona-channel-add-open:en-US");
      }
    }
  });

  it("builds Member Access raw modal with exact structure, four shared options, defaults, and nonce bounds", () => {
    const nonce = "testnonce123";
    const modal = buildMemberAccessModal(
      "en-US",
      {
        serverMemteachingEnabled: true,
        attributeMemteachingEnabled: false,
        sampledialogueMemteachingEnabled: true,
        promptSnapshotEnabled: false,
      },
      nonce,
    );

    expect(modal.custom_id).toBe(`moderation:v1:member-access-submit:en-US:${nonce}`);
    expect(modal.custom_id.length).toBeLessThanOrEqual(100);
    expect(modal.title).toBe("Server Member Permissions");
    expect(modal.components).toHaveLength(1);

    const labelComponent = modal.components[0];
    expect(labelComponent.type).toBe(18);
    expect(labelComponent.label).toBe("Select what members can do with me");
    expect(labelComponent.description).toBe("Select which things non-admin members can do. Checked = allowed.");

    const checkboxGroup = labelComponent.component as {
      type: number;
      custom_id: string;
      min_values: number;
      max_values: number;
      required: boolean;
      options: Array<{ value: string; label: string; description: string; default: boolean }>;
    };
    expect(checkboxGroup.type).toBe(22);
    expect(checkboxGroup.custom_id).toBe(buildMemberAccessModalFieldId(nonce));
    expect(checkboxGroup.custom_id.length).toBeLessThanOrEqual(100);
    expect(checkboxGroup.min_values).toBe(0);
    expect(checkboxGroup.max_values).toBe(4);
    expect(checkboxGroup.required).toBe(false);

    expect(checkboxGroup.options).toEqual([
      {
        value: "servermemories",
        label: "Server Memories",
        description: "Add/remove server-wide memories",
        default: true,
      },
      {
        value: "attributelist",
        label: "Attribute List",
        description: "Add/remove personality attributes",
        default: false,
      },
      {
        value: "sampledialogues",
        label: "Sample Dialogues",
        description: "Add/remove sample dialogue pairs",
        default: true,
      },
      {
        value: "promptsnapshot",
        label: "Prompt Snapshots",
        description: "Use /tool prompt snapshot",
        default: false,
      },
    ]);
  });

  it("builds User Blacklist Add raw modal with exact structure, component type 5, and nonce bounds", () => {
    const nonce = "useraddnonce99";
    const modal = buildUserBlacklistAddModal("en-US", nonce);

    expect(modal.custom_id).toBe(`moderation:v1:user-blacklist-add-submit:en-US:${nonce}`);
    expect(modal.custom_id.length).toBeLessThanOrEqual(100);
    expect(modal.title).toBe("Add Blacklist");
    expect(modal.components).toHaveLength(1);

    const labelComponent = modal.components[0];
    expect(labelComponent.type).toBe(18);
    expect(labelComponent.label).toBe("Member");
    expect(labelComponent.description).toBe("Choose a member to exclude from personalization.");

    const userSelect = labelComponent.component as {
      type: number;
      custom_id: string;
      min_values: number;
      max_values: number;
      required: boolean;
    };
    expect(userSelect.type).toBe(5);
    expect(userSelect.custom_id).toBe(buildUserBlacklistAddModalFieldId(nonce));
    expect(userSelect.custom_id.length).toBeLessThanOrEqual(100);
    expect(userSelect.min_values).toBe(1);
    expect(userSelect.max_values).toBe(1);
    expect(userSelect.required).toBe(true);
  });

  it("renders separate receipt container alongside Member Access panel", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "member-access",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData(),
      receipt: {
        tone: "success",
        heading: "Member access updated",
        detail: "Updated member permissions for this server.",
      },
    });

    expect(payload.components).toHaveLength(2);
    const receiptContainer = payload.components[0] as {
      type: number;
      accentColor?: number;
      components?: Array<{ type: number; content?: string }>;
    };
    expect(receiptContainer.type).toBe(ComponentType.Container);
    expect(receiptContainer.components?.[0]?.content).toBe(
      "### Member access updated\n> Updated member permissions for this server.",
    );

    const mainContainer = payload.components[1] as {
      type: number;
      components?: Array<{ type: number; content?: string }>;
    };
    expect(mainContainer.type).toBe(ComponentType.Container);
  });

  it("renders exactly two separators in stale views, with top divider after categories and bottom divider before warning", () => {
    const testCases: Array<{
      category: "member-access" | "user-blacklist" | "whitelist";
      whitelistPage: "channels" | "persona-channels" | "roles";
      actionLabel: string;
      scopeData: ModerationScopeData;
    }> = [
      {
        category: "member-access",
        whitelistPage: "channels",
        actionLabel: "Edit Permissions",
        scopeData: createScopeData({ readStatus: "stale" }),
      },
      {
        category: "user-blacklist",
        whitelistPage: "channels",
        actionLabel: "+ Add Blacklist",
        scopeData: createScopeData({
          readStatus: "stale",
          userBlacklist: {
            personalizationUserIds: ["u1", "u2"],
            personaBlocks: [],
          },
        }),
      },
      {
        category: "whitelist",
        whitelistPage: "channels",
        actionLabel: "+ Add or Edit Channel",
        scopeData: createScopeData({
          readStatus: "stale",
          whitelist: {
            channels: [
              {
                server_id: 1,
                channel_disc_id: "ch-1",
                cooldown_type: null,
                cooldown_length: null,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
            personaChannels: [],
            roles: [],
            personaNames: new Map(),
          },
        }),
      },
      {
        category: "whitelist",
        whitelistPage: "persona-channels",
        actionLabel: "+ Add Persona",
        scopeData: createScopeData({
          readStatus: "stale",
          whitelist: {
            channels: [],
            personaChannels: [{ server_id: 1, persona_id: 1, channel_disc_id: "ch-1", created_at: new Date() }],
            roles: [],
            personaNames: new Map([[1, "Tomori"]]),
          },
        }),
      },
      {
        category: "whitelist",
        whitelistPage: "roles",
        actionLabel: "+ Add Role",
        scopeData: createScopeData({
          readStatus: "stale",
          whitelist: {
            channels: [],
            personaChannels: [],
            roles: [{ server_id: 1, role_disc_id: "r-1", created_at: new Date(), updated_at: new Date() }],
            personaNames: new Map(),
          },
        }),
      },
    ];

    for (const tc of testCases) {
      const payload = buildModerationPanelPayload({
        locale: "en-US",
        category: tc.category,
        whitelistPage: tc.whitelistPage,
        rangeIndex: 0,
        data: tc.scopeData,
      });

      const container = payload.components[payload.components.length - 1] as {
        type: number;
        components: Array<{
          type: number;
          content?: string;
          divider?: boolean;
          spacing?: number;
          components?: Array<{ label?: string; disabled?: boolean }>;
        }>;
      };
      expect(container.type).toBe(ComponentType.Container);
      const inner = container.components;
      expect(inner.length).toBeGreaterThanOrEqual(4);

      expect(inner[0].type).toBe(ComponentType.ActionRow);

      expect(inner[1].type).toBe(ComponentType.Separator);
      expect(inner[1].divider).toBe(true);
      expect(inner[1].spacing).toBe(1);

      const lastComp = inner[inner.length - 1];
      const bottomSeparatorComp = inner[inner.length - 2];
      const retryRowComp = inner[inner.length - 3];

      expect(lastComp.type).toBe(ComponentType.TextDisplay);
      expect(lastComp.content).toBe(
        "-# Saved data may be out of date because the read failed.\n-# Write actions are unavailable until a fresh read succeeds.",
      );

      expect(bottomSeparatorComp.type).toBe(ComponentType.Separator);
      expect(bottomSeparatorComp.divider).toBe(true);
      expect(bottomSeparatorComp.spacing).toBe(1);

      expect(retryRowComp.type).toBe(ComponentType.ActionRow);
      const retryButton = retryRowComp.components?.find((b) => b.label === "Retry");
      expect(retryButton).toBeDefined();
      expect(retryButton?.disabled).not.toBe(true);

      const actionRowComp = inner.find((component) =>
        component.components?.some((button) => button.label === tc.actionLabel),
      );
      expect(actionRowComp?.type).toBe(ComponentType.ActionRow);
      const button = actionRowComp?.components?.find((b) => b.label === tc.actionLabel);
      expect(button).toBeDefined();
      expect(button?.disabled).toBe(true);

      const allSeparators = inner.filter((c) => c.type === ComponentType.Separator);
      expect(allSeparators).toHaveLength(2);
    }
  });

  it("proves fresh views contain exactly one top separator and no stale warning across all categories and pages", () => {
    const testCases: Array<{
      category: "member-access" | "user-blacklist" | "whitelist";
      whitelistPage: "channels" | "persona-channels" | "roles";
      actionLabel: string;
    }> = [
      { category: "member-access", whitelistPage: "channels", actionLabel: "Edit Permissions" },
      { category: "user-blacklist", whitelistPage: "channels", actionLabel: "+ Add Blacklist" },
      { category: "whitelist", whitelistPage: "channels", actionLabel: "+ Add or Edit Channel" },
      { category: "whitelist", whitelistPage: "persona-channels", actionLabel: "+ Add Persona" },
      { category: "whitelist", whitelistPage: "roles", actionLabel: "+ Add Role" },
    ];

    for (const tc of testCases) {
      const payload = buildModerationPanelPayload({
        locale: "en-US",
        category: tc.category,
        whitelistPage: tc.whitelistPage,
        rangeIndex: 0,
        data: createScopeData({ readStatus: "fresh" }),
      });

      const container = payload.components[payload.components.length - 1] as {
        type: number;
        components: Array<{
          type: number;
          divider?: boolean;
          spacing?: number;
          components?: Array<{ label?: string; disabled?: boolean }>;
        }>;
      };
      expect(container.type).toBe(ComponentType.Container);
      const inner = container.components;

      expect(inner[0].type).toBe(ComponentType.ActionRow);

      expect(inner[1].type).toBe(ComponentType.Separator);
      expect(inner[1].divider).toBe(true);
      expect(inner[1].spacing).toBe(1);

      const separators = inner.filter((c) => c.type === ComponentType.Separator);
      expect(separators).toHaveLength(1);

      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("Saved data may be out of date");

      const lastComp = inner[inner.length - 1];
      expect(lastComp.type).toBe(ComponentType.ActionRow);
      // Member Access carries a second action row for server model access, so the page's own action
      // is no longer guaranteed to sit in the last one.
      const button = inner.flatMap((component) => component.components ?? []).find((b) => b.label === tc.actionLabel);
      expect(button).toBeDefined();
    }
  });

  it("renders one bulk Remove button and no per-row Remove buttons", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        userBlacklist: {
          personalizationUserIds: ["p-user-1"],
          personaBlocks: [
            {
              server_id: 1,
              persona_id: 1,
              user_disc_id: "b-user-1",
              block_type: "mute",
              reason: "test",
              expires_at: new Date(),
              created_at: new Date(),
              updated_at: new Date(),
              persona_name: "Tomori",
            },
          ],
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("moderation:v1:user-blacklist-remove-open:en-US");
    expect(serialized).not.toContain("user-blacklist-remove-prompt");
  });

  it("renders confirmation view for personalization removal with Confirm and Cancel buttons", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        userBlacklist: {
          personalizationUserIds: ["p-user-1"],
          personaBlocks: [],
        },
      }),
      removeTarget: { source: "personalization", userId: "p-user-1" },
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Remove Blacklisted Member");
    expect(serialized).toContain("Remove <@p-user-1> from the personalization blacklist?");
    expect(serialized).toContain("moderation:v1:user-blacklist-remove-confirm:en-US:personalization:p-user-1");
    expect(serialized).toContain("moderation:v1:user-blacklist-remove-cancel:en-US");
    expect(serialized).not.toContain("### Blacklisted Members");
  });

  it("renders confirmation view for persona user block removal with persona name and block type", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        userBlacklist: {
          personalizationUserIds: [],
          personaBlocks: [
            {
              server_id: 1,
              persona_id: 2,
              user_disc_id: "b-user-1",
              block_type: "mute",
              reason: "test",
              expires_at: new Date(),
              created_at: new Date(),
              updated_at: new Date(),
              persona_name: "Anon",
            },
          ],
        },
      }),
      removeTarget: { source: "persona-block", personaId: 2, userId: "b-user-1" },
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Remove Blacklisted Member");
    expect(serialized).toContain("Remove the interaction restriction for <@b-user-1> on");
    expect(serialized).toContain("moderation:v1:user-blacklist-remove-confirm:en-US:persona-block:2:b-user-1");
    expect(serialized).toContain("moderation:v1:user-blacklist-remove-cancel:en-US");
  });

  it("disables Confirm button and renders stale warning when readStatus is stale during confirmation", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        readStatus: "stale",
        userBlacklist: {
          personalizationUserIds: ["p-user-1"],
          personaBlocks: [],
        },
      }),
      removeTarget: { source: "personalization", userId: "p-user-1" },
    });

    const outer = payload.components[0];
    const inner = outer.components ?? [];
    const actionRow = inner.find(
      (c) => c.type === ComponentType.ActionRow && c.components?.some((b) => b.customId?.includes("confirm")),
    );
    expect(actionRow).toBeDefined();
    const confirmBtn = actionRow?.components?.find((b) => b.customId?.includes("confirm"));
    const cancelBtn = actionRow?.components?.find((b) => b.customId?.includes("cancel"));
    expect(confirmBtn?.disabled).toBe(true);
    expect(cancelBtn?.disabled).toBeFalsy();

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Saved data may be out of date");
  });

  it("falls back to normal blacklist view if removeTarget is not present in data", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "user-blacklist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        userBlacklist: {
          personalizationUserIds: ["p-user-1"],
          personaBlocks: [],
        },
      }),
      removeTarget: { source: "personalization", userId: "ghost-user" },
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Blacklisted Members");
    expect(serialized).not.toContain("### Remove Blacklisted Member");
  });
});

describe("moderationPanel whitelist channels rendering", () => {
  it("renders empty state and active Add or Edit Channel button when no channels are whitelisted", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        readStatus: "fresh",
        whitelist: {
          channels: [],
          personaChannels: [],
          roles: [],
          personaNames: new Map(),
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Whitelisted Channels `(0)`");
    expect(serialized).toContain("No channels are whitelisted.");
    expect(serialized).toContain("moderation:v1:whitelist-channel-add-open:en-US");

    const outer = payload.components[0];
    const inner = outer.components ?? [];
    const addRow = inner.find(
      (c) =>
        c.type === ComponentType.ActionRow &&
        c.components?.some((b) => b.customId?.includes("whitelist-channel-add-open")),
    );
    expect(addRow).toBeDefined();
    const addBtn = addRow?.components?.find((b) => b.customId?.includes("whitelist-channel-add-open"));
    expect(addBtn?.disabled).toBeFalsy();
  });

  it("renders visible channel rows with cooldown formatting and one bulk Remove button", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        readStatus: "fresh",
        whitelist: {
          channels: [
            {
              server_id: 1,
              channel_disc_id: "111222333444555666",
              cooldown_type: CooldownType.PER_USER,
              cooldown_length: 10,
              created_at: new Date(),
              updated_at: new Date(),
            },
            {
              server_id: 1,
              channel_disc_id: "777888999000111222",
              cooldown_type: null,
              cooldown_length: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          personaChannels: [],
          roles: [],
          personaNames: new Map(),
        },
      }),
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Whitelisted Channels `(2)`");
    expect(serialized).toContain("> <#111222333444555666>\\n> Cooldown: Per-User, 10s");
    expect(serialized).toContain("> <#777888999000111222>\\n> Inherited server global cooldown");
    expect(serialized).toContain("moderation:v1:whitelist-channel-remove-open:en-US");
    expect(serialized).not.toContain("whitelist-channel-remove-prompt");
    expect(serialized).toContain("moderation:v1:whitelist-channel-add-open:en-US");
  });

  it("renders channel remove confirmation screen when channelRemoveTarget matches existing channel", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        readStatus: "fresh",
        whitelist: {
          channels: [
            {
              server_id: 1,
              channel_disc_id: "111222333444555666",
              cooldown_type: null,
              cooldown_length: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          personaChannels: [],
          roles: [],
          personaNames: new Map(),
        },
      }),
      channelRemoveTarget: "111222333444555666",
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("### Remove Whitelisted Channel");
    expect(serialized).toContain("Remove <#111222333444555666> from the whitelist?");
    expect(serialized).toContain("moderation:v1:whitelist-channel-remove-confirm:en-US:111222333444555666");
    expect(serialized).toContain("moderation:v1:whitelist-channel-remove-cancel:en-US");
  });

  it("disables buttons and adds stale footer when readStatus is stale", () => {
    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "whitelist",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: createScopeData({
        readStatus: "stale",
        whitelist: {
          channels: [
            {
              server_id: 1,
              channel_disc_id: "111222333444555666",
              cooldown_type: null,
              cooldown_length: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          personaChannels: [],
          roles: [],
          personaNames: new Map(),
        },
      }),
    });

    const outer = payload.components[0];
    const inner = outer.components ?? [];
    const removeRow = inner.find(
      (c) => c.type === ComponentType.ActionRow && c.components?.some((b) => b.customId?.includes("remove-open")),
    );
    expect(removeRow).toBeDefined();
    const removeBtn = removeRow?.components?.find((b) => b.customId?.includes("remove-open"));
    expect(removeBtn?.disabled).toBe(true);

    const addRow = inner.find(
      (c) =>
        c.type === ComponentType.ActionRow &&
        c.components?.some((b) => b.customId?.includes("whitelist-channel-add-open")),
    );
    expect(addRow).toBeDefined();
    const addBtn = addRow?.components?.find((b) => b.customId?.includes("whitelist-channel-add-open"));
    expect(addBtn?.disabled).toBe(true);

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Saved data may be out of date");
  });
});

describe("buildWhitelistChannelAddModal", () => {
  it("builds raw modal payload with type 8 channel select, type 3 cooldown type select, and type 4 length input", () => {
    const modal = buildWhitelistChannelAddModal("en-US", "nonce_abc");
    expect(modal.custom_id).toBe("moderation:v1:whitelist-channel-add-submit:en-US:nonce_abc");
    expect(modal.title).toBe("Add or Edit Channel");
    expect(modal.components).toHaveLength(3);

    const [channelField, typeField, lengthField] = modal.components;
    expect(channelField.type).toBe(18);
    expect(channelField.label).toBe("Channel");
    expect(channelField.component?.type).toBe(8);
    expect(channelField.component?.custom_id).toBe("whitelist_channel_add_channel_nonce_abc");
    expect(channelField.component?.channel_types).toEqual([0]);
    expect(channelField.component?.required).toBe(true);

    expect(typeField.type).toBe(18);
    expect(typeField.label).toBe("Cooldown Type");
    expect(typeField.component?.type).toBe(3);
    expect(typeField.component?.custom_id).toBe("whitelist_channel_add_type_nonce_abc");
    expect(typeField.component?.options).toHaveLength(4);
    expect(typeField.component?.options?.map((o) => o.value)).toEqual(["0", "1", "2", "3"]);

    expect(lengthField.type).toBe(18);
    expect(lengthField.label).toBe("Cooldown Length (Seconds)");
    expect(lengthField.component?.type).toBe(4);
    expect(lengthField.component?.custom_id).toBe("whitelist_channel_add_length_nonce_abc");
  });
});

describe("buildWhitelistRoleAddModal", () => {
  it("builds a nonce-bounded required native Role Select", () => {
    const modal = buildWhitelistRoleAddModal("en-US", "nonce_role");
    expect(modal.custom_id).toBe("moderation:v1:whitelist-role-add-submit:en-US:nonce_role");
    expect(modal.title).toBe("Add Whitelisted Role");
    expect(modal.components).toHaveLength(1);
    expect(modal.components[0]?.component?.type).toBe(6);
    expect(modal.components[0]?.component?.custom_id).toBe(buildWhitelistRoleAddModalFieldId("nonce_role"));
    expect(modal.components[0]?.component?.required).toBe(true);
  });
});

describe("moderation bulk and persona modals", () => {
  it("builds unchecked-means-remove checkbox groups with every entry selected", () => {
    const modal = buildModerationRemovalModal(
      "en-US",
      "nonce_bulk",
      "user-blacklist",
      Array.from({ length: 12 }, (_, index) => ({ value: `u:${index}`, label: `Member ${index}` })),
    );
    expect(modal.custom_id).toBe("moderation:v1:user-blacklist-remove-submit:en-US:nonce_bulk");
    expect(modal.components).toHaveLength(2);
    const serialized = JSON.stringify(modal);
    expect(serialized).toContain('"type":22');
    expect(serialized).toContain('"default":true');
    expect(serialized).toContain('"min_values":0');
    expect(serialized).toContain('"label":"Blacklisted Members"');
    expect(serialized).toContain('"description":"Uncheck box then submit to remove blacklist entry"');
    expect(serialized).toContain('"label":"Continuation (1)"');
    expect(serialized.match(/"description":/g)).toHaveLength(1);
  });

  it("uses whitelist-specific checklist titles", () => {
    for (const [action, title] of [
      ["whitelist-channel", "Whitelisted Channels"],
      ["whitelist-role", "Whitelisted Roles"],
      ["persona-channel", "Whitelisted Personas"],
    ] as const) {
      const modal = buildModerationRemovalModal("en-US", "nonce_list", action, [{ value: "entry", label: "Sparrow" }]);
      const serialized = JSON.stringify(modal);
      expect(serialized).toContain(`"label":"${title}"`);
      expect(serialized).toContain('"description":"Uncheck box then submit to remove whitelist"');
    }
  });

  it("builds persona add with a persona String Select and native text-channel select", () => {
    const modal = buildPersonaChannelAddModal("en-US", "nonce_persona", new Map([[7, "Sparrow"]]));
    expect(modal.custom_id).toBe("moderation:v1:persona-channel-add-submit:en-US:nonce_persona");
    const serialized = JSON.stringify(modal);
    expect(serialized).toContain('"type":3');
    expect(serialized).toContain('"value":"7"');
    expect(serialized).toContain('"type":8');
    expect(serialized).toContain(`"channel_types":[${ChannelType.GuildText}]`);
  });
});

describe("moderationPanel Quotas surface and modals", () => {
  it("encodes and decodes quota-edit-open and quota-edit-submit routes", () => {
    const openCustomId = buildModerationCustomId("quota-edit-open", "en-US", "image");
    expect(openCustomId).toBe("moderation:v1:quota-edit-open:en-US:image");
    const openParsed = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["quota-edit-open", "en-US", "image"],
    });
    expect(openParsed).toEqual({ action: "quota-edit-open", locale: "en-US", quotaType: "image" });

    const submitCustomId = buildModerationCustomId("quota-edit-submit", "en-US", "text", "nonce_abc");
    expect(submitCustomId).toBe("moderation:v1:quota-edit-submit:en-US:text:nonce_abc");
    const submitParsed = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["quota-edit-submit", "en-US", "text", "nonce_abc"],
    });
    expect(submitParsed).toEqual({
      action: "quota-edit-submit",
      locale: "en-US",
      quotaType: "text",
      nonce: "nonce_abc",
    });
  });

  it("rejects unknown quota types and malformed nonces", () => {
    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v1",
        segments: ["quota-edit-open", "en-US", "audio"],
      }),
    ).toBeNull();

    expect(
      parseModerationPanelRoute({
        namespace: "moderation",
        version: "v1",
        segments: ["quota-edit-submit", "en-US", "text", "bad!nonce@"],
      }),
    ).toBeNull();
  });

  it("accepts quotas category with page none in category, range, and retry routes", () => {
    const catParsed = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["category", "en-US", "quotas"],
    });
    expect(catParsed).toEqual({ action: "category", locale: "en-US", category: "quotas" });

    const rangeParsed = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["range", "en-US", "quotas", "none", "0"],
    });
    expect(rangeParsed).toEqual({
      action: "range",
      locale: "en-US",
      category: "quotas",
      page: "none",
      rangeIndex: 0,
    });

    const retryParsed = parseModerationPanelRoute({
      namespace: "moderation",
      version: "v1",
      segments: ["retry", "en-US", "quotas", "none"],
    });
    expect(retryParsed).toEqual({
      action: "retry",
      locale: "en-US",
      category: "quotas",
      page: "none",
    });
  });

  it("renders Quotas category with four top buttons and all three subsections with code spans", () => {
    const scope = createScopeData({
      quotas: {
        image: { daily_user_quota: 5, serverwide_quota: 50, serverwide_quota_resets_in: 30 },
        text: { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 },
        video: { daily_user_quota: 2, serverwide_quota: 20, serverwide_quota_resets_in: 14 },
      },
    });

    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "quotas",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: scope,
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('"label":"Member Access"');
    expect(serialized).toContain('"label":"User Blacklist"');
    expect(serialized).toContain('"label":"Whitelist"');
    expect(serialized).toContain('"label":"Quotas"');

    expect(serialized).toContain("### Generation Quotas");
    expect(serialized).toContain("**Image Generation**");
    expect(serialized).toContain("> Daily per-user limit: `5`");
    expect(serialized).toContain("> Server-wide limit: `50`");
    expect(serialized).toContain("> Reset period: `30` days");

    expect(serialized).toContain("**Text Generation**");
    expect(serialized).toContain("> Daily per-user limit: Unlimited");
    expect(serialized).toContain("> Server-wide limit: Unlimited");
    expect(serialized).toContain("> Reset period: `365` days");

    expect(serialized).toContain("**Video Generation**");
    expect(serialized).toContain("> Daily per-user limit: `2`");
    expect(serialized).toContain("> Server-wide limit: `20`");
    expect(serialized).toContain("> Reset period: `14` days");

    expect(serialized).toContain('"label":"Edit Text Quota"');
    expect(serialized).toContain('"label":"Edit Image Quota"');
    expect(serialized).toContain('"label":"Edit Video Quota"');

    expect(serialized.indexOf("**Text Generation**")).toBeLessThan(serialized.indexOf("**Image Generation**"));
    expect(serialized.indexOf("**Image Generation**")).toBeLessThan(serialized.indexOf("**Video Generation**"));
    expect(serialized.indexOf('"label":"Edit Text Quota"')).toBeLessThan(
      serialized.indexOf('"label":"Edit Image Quota"'),
    );
    expect(serialized.indexOf('"label":"Edit Image Quota"')).toBeLessThan(
      serialized.indexOf('"label":"Edit Video Quota"'),
    );
  });

  it("renders no-row defaults (0, 0, 365) as Unlimited and 365 days", () => {
    const scope = createScopeData({
      quotas: {
        image: { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 },
        text: { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 },
        video: { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 },
      },
    });

    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "quotas",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: scope,
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("> Daily per-user limit: Unlimited");
    expect(serialized).toContain("> Server-wide limit: Unlimited");
    expect(serialized).toContain("> Reset period: `365` days");
    expect(serialized).not.toContain("Daily per-user limit: `0`");
    expect(serialized).not.toContain("Server-wide limit: `0`");
  });

  it("disables Edit buttons and displays stale warning when readStatus is stale", () => {
    const scope = createScopeData({
      readStatus: "stale",
    });

    const payload = buildModerationPanelPayload({
      locale: "en-US",
      category: "quotas",
      whitelistPage: "channels",
      rangeIndex: 0,
      data: scope,
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain("Saved data may be out of date because the read failed");
    expect(serialized).toContain('"customId":"moderation:v1:retry:en-US:quotas:none"');
    expect(serialized).toContain('"disabled":true');
  });

  it("builds quota edit modal with three Short Text Inputs prefilled with raw values", () => {
    const modal = buildQuotaEditModal(
      "en-US",
      "image",
      { daily_user_quota: 10, serverwide_quota: 500, serverwide_quota_resets_in: 30 },
      "nonce_edit",
    );

    expect(modal.custom_id).toBe("moderation:v1:quota-edit-submit:en-US:image:nonce_edit");
    expect(modal.title).toBe("Edit Image Quotas");
    expect(modal.components).toHaveLength(3);

    const serialized = JSON.stringify(modal);
    expect(serialized).toContain('"type":4');
    expect(serialized).toContain(`"custom_id":"${buildQuotaModalFieldId("nonce_edit", "daily_user_quota")}"`);
    expect(serialized).toContain('"value":"10"');
    expect(serialized).toContain(`"custom_id":"${buildQuotaModalFieldId("nonce_edit", "serverwide_quota")}"`);
    expect(serialized).toContain('"value":"500"');
    expect(serialized).toContain(`"custom_id":"${buildQuotaModalFieldId("nonce_edit", "serverwide_quota_resets_in")}"`);
    expect(serialized).toContain('"value":"30"');

    expect(serialized).toContain("0-100, 0 = unlimited");
    expect(serialized).toContain("0-99999, 0 = unlimited");
    expect(serialized).toContain("1-365");
  });
});
