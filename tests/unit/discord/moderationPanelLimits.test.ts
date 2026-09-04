import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { ChannelPersonaWhitelistRow, ChannelWhitelistRow, RoleWhitelistRow } from "@/types/db/schema";
import { CooldownType } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import { MODERATION_PANEL_RANGE_SIZE } from "@/utils/discord/interactions/panelController";
import { PERSONA_NICKNAME_MAX_LENGTH } from "@/utils/discord/interactions/configPersonaOperations";
import { buildModerationPanelPayload } from "@/utils/discord/ui/moderationPanel";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import type { ModerationScopeData } from "@/utils/moderation/moderationOperations";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const localesDir = join(process.cwd(), "src", "locales");
const RUNTIME_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const REALISTIC_RECEIPT: PanelReceipt = {
  tone: "success",
  heading: "Moderation Action Completed Successfully",
  detail: "The moderation setting was saved for workspace 100 with the current permission and access policy.",
  metadata: "trace: moderation-op-987654 | actor: 123456789012345678 | elapsed: 48ms",
};

const READ_STATUSES: PanelReadStatus[] = ["fresh", "stale", "unavailable"];
const RECEIPTS: Array<PanelReceipt | undefined> = [undefined, REALISTIC_RECEIPT];
const BACKTICK_RUNS = [3, 4, 5, 6, 8];
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function rowTextDisplays(value: unknown): string[] {
  const contents: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (record.type === ComponentType.TextDisplay && typeof record.content === "string") {
      contents.push(record.content);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return contents;
}

function assertSafePayload(payload: ReturnType<typeof buildModerationPanelPayload>, label: string): void {
  const result = validateComponentsV2MessageLimits(payload);
  expect(result.valid, `${label} violations: ${JSON.stringify(result.violations)}`).toBe(true);
  for (const content of rowTextDisplays(payload)) {
    expect(LONE_SURROGATE.test(content), `${label} contains a lone surrogate`).toBe(false);
    const fenceStart = content.indexOf("```markdown\n");
    if (fenceStart === -1) continue;
    const bodyStart = fenceStart + "```markdown\n".length;
    const closingFence = content.lastIndexOf("\n```");
    if (closingFence <= bodyStart) continue;
    expect(content.slice(bodyStart, closingFence), `${label} has an adjacent backtick in a fence`).not.toMatch(/``/u);
  }
}

function makeChannel(id: number, overrides: Partial<ChannelWhitelistRow> = {}): ChannelWhitelistRow {
  return {
    server_id: 1,
    channel_disc_id: `channel-${id}`,
    cooldown_type: CooldownType.PER_CHANNEL,
    cooldown_length: 30,
    ...overrides,
  };
}

function makePersonaChannel(
  id: number,
  overrides: Partial<ChannelPersonaWhitelistRow> = {},
): ChannelPersonaWhitelistRow {
  return {
    server_id: 1,
    channel_disc_id: `persona-channel-${id}`,
    persona_id: id,
    ...overrides,
  };
}

function makeRole(id: number, overrides: Partial<RoleWhitelistRow> = {}): RoleWhitelistRow {
  return { server_id: 1, role_disc_id: `role-${id}`, ...overrides };
}

function makeBlock(
  id: number,
  personaName = `Persona ${id}`,
): ModerationScopeData["userBlacklist"]["personaBlocks"][number] {
  return {
    server_id: 1,
    persona_id: id,
    user_disc_id: `blocked-user-${id}`,
    block_type: id % 2 === 0 ? "mute" : "block",
    reason: "fixture reason",
    expires_at: new Date("2030-01-01T00:00:00.000Z"),
    persona_name: personaName,
  };
}

function makeData(readStatus: PanelReadStatus, overrides: Partial<ModerationScopeData> = {}): ModerationScopeData {
  return {
    guildId: "guild-1",
    serverId: 1,
    readStatus,
    memberAccess: {
      serverMemteachingEnabled: true,
      attributeMemteachingEnabled: false,
      sampledialogueMemteachingEnabled: true,
      promptSnapshotEnabled: false,
    },
    serverModelAccess: { allowServerModels: true },
    userBlacklist: {
      personalizationUserIds: ["personalized-user-1"],
      personaBlocks: [makeBlock(1)],
      personalMemoriesEnabled: true,
    },
    whitelist: {
      channels: [makeChannel(1)],
      personaChannels: [makePersonaChannel(1)],
      roles: [makeRole(1)],
      personaNames: new Map([[1, "Persona 1"]]),
    },
    quotas: {
      text: { daily_user_quota: 10, serverwide_quota: 100, serverwide_quota_resets_in: 7 },
      image: { daily_user_quota: 5, serverwide_quota: 50, serverwide_quota_resets_in: 7 },
      video: { daily_user_quota: 2, serverwide_quota: 20, serverwide_quota_resets_in: 7 },
    },
    ...overrides,
  };
}

function buildInput(
  locale: string,
  category: "member-access" | "user-blacklist" | "whitelist" | "quotas",
  whitelistPage: "channels" | "persona-channels" | "roles",
  data: ModerationScopeData,
  receipt: PanelReceipt | undefined,
  rangeIndex = 0,
): Parameters<typeof buildModerationPanelPayload>[0] {
  return { locale, category, whitelistPage, rangeIndex, data, receipt };
}

describe("Moderation panel Components V2 limits", () => {
  it("covers every category, whitelist page, read status, receipt state, and range input", () => {
    const categories = ["member-access", "user-blacklist", "whitelist", "quotas"] as const;
    const whitelistPages = ["channels", "persona-channels", "roles"] as const;
    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of RECEIPTS) {
        for (const readStatus of READ_STATUSES) {
          for (const category of categories) {
            for (const whitelistPage of whitelistPages) {
              const payload = buildModerationPanelPayload(
                buildInput(locale, category, whitelistPage, makeData(readStatus), receipt, 99),
              );
              assertSafePayload(payload, `${locale}/${category}/${whitelistPage}/${readStatus}`);
            }
          }
        }
      }
    }
  });

  it("sweeps every paginated moderation collection at protocol-safe sizes", () => {
    const sizes = [
      0,
      1,
      MODERATION_PANEL_RANGE_SIZE - 1,
      MODERATION_PANEL_RANGE_SIZE,
      MODERATION_PANEL_RANGE_SIZE + 1,
      MODERATION_PANEL_RANGE_SIZE * 3,
    ];
    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of RECEIPTS) {
        for (const readStatus of READ_STATUSES) {
          for (const size of sizes) {
            const channels = Array.from({ length: size }, (_, index) => makeChannel(index + 1));
            const personaChannels = Array.from({ length: size }, (_, index) => makePersonaChannel(index + 1));
            const roles = Array.from({ length: size }, (_, index) => makeRole(index + 1));
            const blocks = Array.from({ length: size }, (_, index) => makeBlock(index + 1));
            const personaNames = new Map(blocks.map((block) => [block.persona_id, block.persona_name]));
            const data = makeData(readStatus, {
              userBlacklist: { personalizationUserIds: [], personaBlocks: blocks, personalMemoriesEnabled: true },
              whitelist: { channels, personaChannels, roles, personaNames },
            });
            for (const whitelistPage of ["channels", "persona-channels", "roles"] as const) {
              assertSafePayload(
                buildModerationPanelPayload(buildInput(locale, "whitelist", whitelistPage, data, receipt, 2)),
                `${locale}/${whitelistPage}/size-${size}`,
              );
            }
            assertSafePayload(
              buildModerationPanelPayload(buildInput(locale, "user-blacklist", "channels", data, receipt, 2)),
              `${locale}/user-blacklist/size-${size}`,
            );
          }
        }
      }
    }
  });

  it("keeps every optional removal target path valid", () => {
    const data = makeData("fresh");
    const cases = [
      {
        category: "user-blacklist" as const,
        page: "channels" as const,
        removeTarget: { source: "personalization" as const, userId: "personalized-user-1" },
      },
      {
        category: "user-blacklist" as const,
        page: "channels" as const,
        removeTarget: { source: "persona-block" as const, personaId: 1, userId: "blocked-user-1" },
      },
      { category: "whitelist" as const, page: "channels" as const, channelRemoveTarget: "channel-1" },
      { category: "whitelist" as const, page: "roles" as const, roleRemoveTarget: "role-1" },
    ];
    for (const testCase of cases) {
      assertSafePayload(
        buildModerationPanelPayload({
          locale: "en-US",
          category: testCase.category,
          whitelistPage: testCase.page,
          rangeIndex: 0,
          data,
          receipt: REALISTIC_RECEIPT,
          ...testCase,
        }),
        `removal ${testCase.category}/${testCase.page}`,
      );
    }
  });

  it("bounds moderation persona names across stored, oversized, fenced, and astral shapes", () => {
    const shapeValues = [
      "S".repeat(PERSONA_NICKNAME_MAX_LENGTH),
      "O".repeat(20_000),
      ...BACKTICK_RUNS.map((length) => `prefix ${"`".repeat(length)} suffix`),
      "🌟".repeat(20_000),
    ];
    for (const [index, value] of shapeValues.entries()) {
      const block = makeBlock(index + 1, value);
      const data = makeData("fresh", {
        userBlacklist: { personalizationUserIds: [], personaBlocks: [block], personalMemoriesEnabled: true },
        whitelist: {
          channels: [],
          personaChannels: [makePersonaChannel(index + 1)],
          roles: [],
          personaNames: new Map([[index + 1, value]]),
        },
      });
      assertSafePayload(
        buildModerationPanelPayload({
          locale: "en-US",
          category: "user-blacklist",
          whitelistPage: "channels",
          rangeIndex: 0,
          data,
          removeTarget: { source: "persona-block", personaId: index + 1, userId: block.user_disc_id },
        }),
        `persona block shape ${index}`,
      );
      assertSafePayload(
        buildModerationPanelPayload({
          locale: "en-US",
          category: "whitelist",
          whitelistPage: "persona-channels",
          rangeIndex: 0,
          data,
        }),
        `persona channel shape ${index}`,
      );
    }

    // Explicitly test a full page of 10 rows all having 20,000-codepoint persona names across locales and receipts
    const fullPagePersonaChannels = Array.from({ length: MODERATION_PANEL_RANGE_SIZE }, (_, i) =>
      makePersonaChannel(i + 1),
    );
    const fullPagePersonaNames = new Map(fullPagePersonaChannels.map((pc) => [pc.persona_id, "X".repeat(20_000)]));
    const fullPageData = makeData("fresh", {
      whitelist: {
        channels: [],
        personaChannels: fullPagePersonaChannels,
        roles: [],
        personaNames: fullPagePersonaNames,
      },
    });
    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of RECEIPTS) {
        assertSafePayload(
          buildModerationPanelPayload({
            locale,
            category: "whitelist",
            whitelistPage: "persona-channels",
            rangeIndex: 0,
            data: fullPageData,
            receipt,
          }),
          `full 10-row page of oversized persona names/${locale}/receipt=${Boolean(receipt)}`,
        );
      }
    }
  });

  it("covers every blacklist and whitelist record exactly once across ranges", () => {
    const total = MODERATION_PANEL_RANGE_SIZE + 1;
    const blocks = Array.from({ length: total }, (_, index) => makeBlock(index + 1));
    const channels = Array.from({ length: total }, (_, index) => makeChannel(index + 1));
    const personaChannels = Array.from({ length: total }, (_, index) => makePersonaChannel(index + 1));
    const roles = Array.from({ length: total }, (_, index) => makeRole(index + 1));
    const data = makeData("fresh", {
      userBlacklist: { personalizationUserIds: [], personaBlocks: blocks, personalMemoriesEnabled: true },
      whitelist: {
        channels,
        personaChannels,
        roles,
        personaNames: new Map(blocks.map((block) => [block.persona_id, block.persona_name])),
      },
    });
    const collect = (
      category: "user-blacklist" | "whitelist",
      whitelistPage: "channels" | "persona-channels" | "roles",
    ) => {
      const values: string[] = [];
      const rangeCount = Math.max(1, Math.ceil(total / MODERATION_PANEL_RANGE_SIZE));
      for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex++) {
        const payload = buildModerationPanelPayload({
          locale: "en-US",
          category,
          whitelistPage,
          rangeIndex,
          data,
        });
        values.push(...rowTextDisplays(payload));
      }
      return values.join("\n");
    };
    expect(
      collect("user-blacklist", "channels")
        .match(/blocked-user-\d+/gu)
        ?.sort(),
    ).toEqual(Array.from({ length: total }, (_, index) => `blocked-user-${index + 1}`).sort());
    expect(
      collect("whitelist", "channels")
        .match(/channel-\d+/gu)
        ?.sort(),
    ).toEqual(Array.from({ length: total }, (_, index) => `channel-${index + 1}`).sort());
    expect(
      collect("whitelist", "persona-channels")
        .match(/persona-channel-\d+/gu)
        ?.sort(),
    ).toEqual(Array.from({ length: total }, (_, index) => `persona-channel-${index + 1}`).sort());
    expect(
      collect("whitelist", "roles")
        .match(/role-\d+/gu)
        ?.sort(),
    ).toEqual(Array.from({ length: total }, (_, index) => `role-${index + 1}`).sort());
  });
});
