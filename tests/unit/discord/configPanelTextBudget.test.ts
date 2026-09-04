/**
 * Text budgeting coverage for Config pages:
 * asserts message-wide Text Display budgets at stored maxima, boundary Unicode handling,
 * and fence breakout immunity.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import type {
  ConfigBehaviorView,
  ConfigChannelsView,
  ConfigPersonaMemoryView,
} from "@/utils/discord/interactions/configRouteContext";
import {
  DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX,
  getDiscordTextLength,
  validateComponentsV2MessageLimits,
} from "@/utils/discord/ui/componentsV2Limits";
import { buildConfigPanelPayload } from "@/utils/discord/ui/configPanel";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const localesDir = join(process.cwd(), "src", "locales");
const RUNTIME_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const GUILD_MANAGER: ConfigActor = { workspaceKind: "guild", isManager: true };

function makePersona(overrides: Partial<TomoriState> & { persona_id: number }): TomoriState {
  return {
    server_id: 9,
    persona_nickname: `Persona ${overrides.persona_id}`,
    is_alter: false,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    ...overrides,
  } as unknown as TomoriState;
}

function makeSnowflake(n: number): string {
  return (1000000000000000000n + BigInt(n)).toString();
}

function makeChannelList(count: number): Array<{ id: string; name?: string }> {
  return Array.from({ length: count }, (_, i) => ({
    id: makeSnowflake(i + 1),
    name: `channel-${i + 1}`,
  }));
}

function getTextDisplays(payload: unknown): string[] {
  const contents: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (record.type === ComponentType.TextDisplay && typeof record.content === "string") {
      contents.push(record.content);
    }
    for (const value of Object.values(record)) {
      if (typeof value === "object" && value !== null) visit(value);
    }
  };
  visit(payload);
  return contents;
}

describe("config page text budgeting at stored maxima", () => {
  const memoryLimits = getMemoryLimits();
  const maxAttribute = Math.min(4000, memoryLimits.maxAttributeLength);
  const maxDialogue = Math.min(4000, memoryLimits.maxSampleDialogueLength);

  const testCases = [
    {
      name: "Persona Identity & Personality",
      buildPayload: (locale: string, receipt: boolean) =>
        buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "persona",
          page: "general",
          personas: [
            makePersona({
              persona_id: 55,
              attribute_list: ["A".repeat(maxAttribute)],
              sample_dialogues_in: ["Q".repeat(maxDialogue)],
              sample_dialogues_out: ["R".repeat(maxDialogue)],
            }),
          ],
          selectedPersonaId: 55,
          selectedAttributeIndex: 0,
          selectedDialogueIndex: 0,
          readStatus: "fresh",
          receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
        }),
    },
    {
      name: "Persona Appearance",
      buildPayload: (locale: string, receipt: boolean) =>
        buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "persona",
          page: "appearance",
          personas: [
            makePersona({
              persona_id: 55,
              physical_appearance_tags: ["tag1".repeat(200), "tag2".repeat(200), "tag3".repeat(400)],
            }),
          ],
          selectedPersonaId: 55,
          readStatus: "fresh",
          receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
        }),
    },
    {
      name: "Persona Advanced",
      buildPayload: (locale: string, receipt: boolean) =>
        buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "persona",
          page: "advanced",
          personas: [
            makePersona({
              persona_id: 55,
              persona_prompt: "P".repeat(4000),
              context_note: "C".repeat(2000),
            }),
          ],
          selectedPersonaId: 55,
          readStatus: "fresh",
          receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
        }),
    },
    {
      name: "Behavior General",
      buildPayload: (locale: string, receipt: boolean) => {
        const behaviorView: ConfigBehaviorView = {
          general: {
            systemPrompt: "S".repeat(16000),
            contextNote: "G".repeat(2000),
            humanizerDegree: 1,
            messageFetchLimit: 20,
            timezoneOffset: 0,
          },
        };
        return buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "behavior",
          page: "general",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          readStatus: "fresh",
          behaviorView,
          receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
        });
      },
    },
    {
      name: "Behavior Memory & STM",
      buildPayload: (locale: string, receipt: boolean) => {
        const behaviorView: ConfigBehaviorView = {
          memory: {
            memoryTaggingEnabled: true,
            channelMemoryEnabled: true,
            stmCategories: [{ server_id: 9, position: 0, label: "Summary", description: "Scene summary" }],
            stmConfig: {
              server_id: 9,
              refresh_cadence: 5,
              render_mode: "supersede",
              crude_message_count: 6,
              nudge_injection_depth: 2,
              content_injection_depth: -1,
              tool_description_override: "T".repeat(4000),
              update_nudge_override: "N".repeat(4000),
            },
          },
        };
        return buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "behavior",
          page: "memory",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          readStatus: "fresh",
          behaviorView,
          receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
        });
      },
    },
    {
      name: "Persona Memory & STM",
      buildPayload: (locale: string, receipt: boolean) => {
        const personaMemoryView: ConfigPersonaMemoryView = {
          serverMemoryCount: 4,
          personalMemoryCount: 2,
          channelId: "channel-1",
          stmCategories: [{ server_id: 9, position: 0, label: "Summary", description: "Scene summary" }],
          stmEntry: {
            messages: [],
            serverId: "guild-1",
            channelId: "channel-1",
            personaId: 55,
            personaLineageId: 55,
            categories: { summary: "M".repeat(4000) },
            lastUpdated: Date.now(),
          },
          conditioningGroups: [],
        };
        return buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "persona",
          page: "memories",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          readStatus: "fresh",
          personaMemoryView,
          receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
        });
      },
    },
    {
      name: "Channels Destinations",
      buildPayload: (locale: string, receipt: boolean) => {
        const channelsView: ConfigChannelsView = {
          availableTextChannels: [],
          availableBlocklistChannels: [],
          availableOverrideChannels: [],
          destinations: {
            thoughtLogChannelId: makeSnowflake(1),
            welcomeChannelId: makeSnowflake(2),
            welcomePersonaId: 55,
            welcomePrompt: "W".repeat(4000),
          },
        };
        return buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "channels",
          page: "destinations",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          readStatus: "fresh",
          channelsView,
          receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
        });
      },
    },
    {
      name: "Channels Auto-Trigger",
      buildPayload: (locale: string, receipt: boolean) => {
        const channels = makeChannelList(220);
        const channelsView: ConfigChannelsView = {
          availableTextChannels: channels,
          availableBlocklistChannels: [],
          availableOverrideChannels: [],
          autoTrigger: {
            enabledChannels: channels,
            personaOverrides: channels.map((channel) => ({ channel_disc_id: channel.id, persona_id: 55 })),
            threshold: 5,
            maxThreshold: 10,
          },
        };
        return buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "channels",
          page: "auto-trigger",
          personas: [
            makePersona({
              persona_id: 55,
              persona_nickname: "Tomori_***_Alter_###_[Test]*_".repeat(2),
            }),
          ],
          selectedPersonaId: 55,
          readStatus: "fresh",
          channelsView,
          receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
        });
      },
    },
    {
      name: "Channels Rules",
      buildPayload: (locale: string, receipt: boolean) => {
        const privateChannels = makeChannelList(220);
        const roleplayChannels = makeChannelList(220);
        const blocklistChannels = makeChannelList(220);
        const channelsView: ConfigChannelsView = {
          availableTextChannels: privateChannels,
          availableBlocklistChannels: blocklistChannels,
          availableOverrideChannels: [],
          rules: {
            privateChannels,
            roleplayChannels,
            crossChannelBlocklist: blocklistChannels,
          },
        };
        return buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "channels",
          page: "rules",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          readStatus: "fresh",
          channelsView,
          receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
        });
      },
    },
    {
      name: "Channels Overrides",
      buildPayload: (locale: string, receipt: boolean) => {
        const selectedId = makeSnowflake(100);
        const channelsView: ConfigChannelsView = {
          availableTextChannels: [],
          availableBlocklistChannels: [],
          availableOverrideChannels: [{ id: selectedId }],
          overrides: {
            selectedChannelId: selectedId,
            prompt: { prompt: "P".repeat(4000), mode: "append" },
            contextNote: { note: "C".repeat(2000), depth: 3 },
            textModelOverride: null,
          },
        };
        return buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "channels",
          page: "overrides",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          channelsSelectedChannelId: selectedId,
          readStatus: "fresh",
          channelsView,
          receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
        });
      },
    },
  ];

  for (const locale of RUNTIME_LOCALES) {
    describe(`locale ${locale}`, () => {
      for (const tc of testCases) {
        for (const receipt of [false, true]) {
          it(`keeps ${tc.name} valid at stored maxima (receipt=${receipt})`, () => {
            const payload = tc.buildPayload(locale, receipt);
            const result = validateComponentsV2MessageLimits(payload);
            expect(
              result.valid,
              `${tc.name} [${locale}] (receipt=${receipt}) violations: ${JSON.stringify(result.violations)}`,
            ).toBe(true);

            const displays = getTextDisplays(payload);
            let totalText = 0;
            for (const text of displays) {
              totalText += getDiscordTextLength(text);
            }
            expect(totalText).toBeLessThanOrEqual(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX);
          });
        }
      }
    });
  }

  describe("fallback behavior for unknown locale tag", () => {
    for (const tc of testCases) {
      it(`renders a valid non-empty payload for ${tc.name} with unknown locale zz-ZZ`, () => {
        const payload = tc.buildPayload("zz-ZZ", false);
        const result = validateComponentsV2MessageLimits(payload);
        expect(result.valid, `${tc.name} [zz-ZZ] violations: ${JSON.stringify(result.violations)}`).toBe(true);

        const displays = getTextDisplays(payload);
        expect(displays.length).toBeGreaterThan(0);
        for (const text of displays) {
          expect(text.trim().length).toBeGreaterThan(0);
        }
        let totalText = 0;
        for (const text of displays) {
          totalText += getDiscordTextLength(text);
        }
        expect(totalText).toBeLessThanOrEqual(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX);
      });
    }
  });
});

describe("bounded preview unicode and truncation boundary assertions", () => {
  const unicodeCases = [
    {
      kind: "combining marks",
      unit: "e\u0301",
      codepointPerUnit: 2,
    },
    {
      kind: "CJK characters",
      unit: "漢字",
      codepointPerUnit: 2,
    },
    {
      kind: "astral plane emoji",
      unit: "🌸✨",
      codepointPerUnit: 2,
    },
  ];

  for (const { kind, unit } of unicodeCases) {
    it(`handles truncation boundaries without splitting surrogate pairs or graphemes for ${kind}`, () => {
      for (const repeatCount of [50, 600, 2500]) {
        const content = unit.repeat(repeatCount);
        const behaviorView: ConfigBehaviorView = {
          general: {
            systemPrompt: content,
            humanizerDegree: 0,
            messageFetchLimit: 10,
            timezoneOffset: 0,
          },
        };
        const payload = buildConfigPanelPayload({
          locale: "en-US",
          actor: GUILD_MANAGER,
          category: "behavior",
          page: "general",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          readStatus: "fresh",
          behaviorView,
        });

        const validation = validateComponentsV2MessageLimits(payload);
        expect(validation.valid, `Violations: ${JSON.stringify(validation.violations)}`).toBe(true);

        const displays = getTextDisplays(payload);
        for (const text of displays) {
          expect(/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
        }
      }
    });
  }

  it("shows truncation notice with counts when cut and omits notice when within budget", () => {
    const shortPrompt = "Short prompt within budget.";
    const shortPayload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "persona",
      page: "advanced",
      personas: [makePersona({ persona_id: 55, persona_prompt: shortPrompt })],
      selectedPersonaId: 55,
      readStatus: "fresh",
    });
    const shortDisplays = getTextDisplays(shortPayload);
    const shortPromptDisplay = shortDisplays.find((text) => text.includes("Short prompt"));
    expect(shortPromptDisplay).toBeDefined();
    expect(shortPromptDisplay).not.toContain("Content truncated");

    const longPrompt = "X".repeat(4000);
    const longPayload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "persona",
      page: "advanced",
      personas: [makePersona({ persona_id: 55, persona_prompt: longPrompt })],
      selectedPersonaId: 55,
      readStatus: "fresh",
    });
    const longDisplays = getTextDisplays(longPayload);
    const longPromptDisplay = longDisplays.find((text) => text.includes("Content truncated"));
    expect(longPromptDisplay).toBeDefined();
    expect(longPromptDisplay).toMatch(/Content truncated \(\d+\/4000 shown\)\./);
  });

  it("prevents triple backticks from breaking out of fence after truncation", () => {
    const breakoutContent = "before ``` code block ``` middle ``` extra ``` after ".repeat(200);
    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "behavior",
      page: "general",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      readStatus: "fresh",
      behaviorView: {
        general: {
          systemPrompt: breakoutContent,
          humanizerDegree: 0,
          messageFetchLimit: 10,
          timezoneOffset: 0,
        },
      },
    });

    const validation = validateComponentsV2MessageLimits(payload);
    expect(validation.valid, `Violations: ${JSON.stringify(validation.violations)}`).toBe(true);

    const displays = getTextDisplays(payload);
    const systemPromptDisplay = displays.find((text) => text.includes("System Prompt"));
    expect(systemPromptDisplay).toBeDefined();

    const fenceMatches = systemPromptDisplay?.match(/```/g) ?? [];
    expect(fenceMatches.length).toBe(2);
  });

  // Three backticks are the one run length a literal triple-backtick replacement handles. Five and
  // eight survive it, and survive applying it twice, so the run length is the discriminator here.
  it.each([2, 3, 4, 5, 6, 7, 8, 9, 12])("contains a backtick run of %i inside the fence", (runLength) => {
    const run = "`".repeat(runLength);
    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "behavior",
      page: "general",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      readStatus: "fresh",
      behaviorView: {
        general: {
          systemPrompt: `before ${run} after`,
          humanizerDegree: 0,
          messageFetchLimit: 10,
          timezoneOffset: 0,
        },
      },
    });

    const systemPromptDisplay = getTextDisplays(payload).find((text) => text.includes("System Prompt"));
    expect(systemPromptDisplay).toBeDefined();
    expect(systemPromptDisplay?.match(/```/g) ?? []).toHaveLength(2);
  });
});

describe("channels collection bounds and truncation notices", () => {
  const collectionCases = [
    {
      name: "Auto-Trigger enabled channels",
      buildPayload: (locale: string, count: number) => {
        const channels = makeChannelList(count);
        return buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "channels",
          page: "auto-trigger",
          personas: [
            makePersona({
              persona_id: 55,
              persona_nickname: "Tomori_***_Alter_###_[Test]*_".repeat(2),
            }),
          ],
          selectedPersonaId: 55,
          readStatus: "fresh",
          channelsView: {
            availableTextChannels: channels,
            availableBlocklistChannels: [],
            availableOverrideChannels: [],
            autoTrigger: {
              enabledChannels: channels,
              personaOverrides: channels.map((c) => ({ channel_disc_id: c.id, persona_id: 55 })),
              threshold: 5,
              maxThreshold: 10,
            },
          },
        });
      },
      findTargetDisplay: (displays: string[]) => displays.find((text) => text.includes("Enabled channels")),
      emptyFallback: "No channels are enabled.",
    },
    {
      name: "Rules private channels",
      buildPayload: (locale: string, count: number) => {
        const channels = makeChannelList(count);
        return buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "channels",
          page: "rules",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          readStatus: "fresh",
          channelsView: {
            availableTextChannels: channels,
            availableBlocklistChannels: [],
            availableOverrideChannels: [],
            rules: {
              privateChannels: channels,
              roleplayChannels: [],
              crossChannelBlocklist: [],
            },
          },
        });
      },
      findTargetDisplay: (displays: string[]) => displays.find((text) => text.includes("Private Channels")),
      emptyFallback: "None",
    },
    {
      name: "Rules roleplay channels",
      buildPayload: (locale: string, count: number) => {
        const channels = makeChannelList(count);
        return buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "channels",
          page: "rules",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          readStatus: "fresh",
          channelsView: {
            availableTextChannels: channels,
            availableBlocklistChannels: [],
            availableOverrideChannels: [],
            rules: {
              privateChannels: [],
              roleplayChannels: channels,
              crossChannelBlocklist: [],
            },
          },
        });
      },
      findTargetDisplay: (displays: string[]) => displays.find((text) => text.includes("Roleplay Channels")),
      emptyFallback: "None",
    },
    {
      name: "Rules cross-channel blocklist",
      buildPayload: (locale: string, count: number) => {
        const channels = makeChannelList(count);
        return buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "channels",
          page: "rules",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          readStatus: "fresh",
          channelsView: {
            availableTextChannels: [],
            availableBlocklistChannels: channels,
            availableOverrideChannels: [],
            rules: {
              privateChannels: [],
              roleplayChannels: [],
              crossChannelBlocklist: channels,
            },
          },
        });
      },
      findTargetDisplay: (displays: string[]) => displays.find((text) => text.includes("Cross-Channel Blocklist")),
      emptyFallback: "None",
    },
  ];

  for (const locale of RUNTIME_LOCALES) {
    describe(`locale ${locale}`, () => {
      for (const cc of collectionCases) {
        it(`handles collection size 0 for ${cc.name}`, () => {
          const payload = cc.buildPayload(locale, 0);
          const validation = validateComponentsV2MessageLimits(payload);
          expect(validation.valid, `Violations: ${JSON.stringify(validation.violations)}`).toBe(true);

          const displays = getTextDisplays(payload);
          // English substring assertions are restricted to en-US: localized channel summaries use
          // locale-specific copy whose text budget is already validated above.
          if (locale === "en-US") {
            const target = cc.findTargetDisplay(displays);
            expect(target).toBeDefined();
            expect(target).toContain(cc.emptyFallback);
            expect(target).not.toContain("Showing");
          }
        });

        it(`handles collection size 1 for ${cc.name}`, () => {
          const payload = cc.buildPayload(locale, 1);
          const validation = validateComponentsV2MessageLimits(payload);
          expect(validation.valid, `Violations: ${JSON.stringify(validation.violations)}`).toBe(true);

          const displays = getTextDisplays(payload);
          expect(displays.some((text) => text.includes(`<#${makeSnowflake(1)}>`))).toBe(true);
          if (locale === "en-US") {
            const target = cc.findTargetDisplay(displays);
            expect(target).toBeDefined();
            expect(target).not.toContain("Showing");
          }
        });

        it(`bounds large collection size 220 for ${cc.name}`, () => {
          const payload = cc.buildPayload(locale, 220);
          const validation = validateComponentsV2MessageLimits(payload);
          expect(validation.valid, `Violations: ${JSON.stringify(validation.violations)}`).toBe(true);

          const displays = getTextDisplays(payload);
          let totalText = 0;
          for (const text of displays) {
            totalText += getDiscordTextLength(text);
          }
          expect(totalText).toBeLessThanOrEqual(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX);

          if (locale === "en-US") {
            const target = cc.findTargetDisplay(displays);
            expect(target).toBeDefined();

            const match = target?.match(/Showing (\d+) of 220 channels \((\d+) hidden\)\./);
            expect(match).not.toBeNull();
            const shown = Number(match?.[1]);
            const hidden = Number(match?.[2]);
            expect(shown).toBeGreaterThan(0);
            expect(shown).toBeLessThan(220);
            expect(shown + hidden).toBe(220);
          }
        });
      }

      it("bounds all three Rules lists large simultaneously", () => {
        const privateChannels = makeChannelList(220);
        const roleplayChannels = makeChannelList(220);
        const blocklistChannels = makeChannelList(220);
        const payload = buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "channels",
          page: "rules",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          readStatus: "fresh",
          channelsView: {
            availableTextChannels: privateChannels,
            availableBlocklistChannels: blocklistChannels,
            availableOverrideChannels: [],
            rules: {
              privateChannels,
              roleplayChannels,
              crossChannelBlocklist: blocklistChannels,
            },
          },
        });

        const validation = validateComponentsV2MessageLimits(payload);
        expect(validation.valid, `Violations: ${JSON.stringify(validation.violations)}`).toBe(true);

        const displays = getTextDisplays(payload);
        let totalText = 0;
        for (const text of displays) {
          totalText += getDiscordTextLength(text);
        }
        expect(totalText).toBeLessThanOrEqual(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX);

        if (locale === "en-US") {
          const privateDisplay = displays.find((text) => text.includes("Private Channels"));
          const roleplayDisplay = displays.find((text) => text.includes("Roleplay Channels"));
          const blocklistDisplay = displays.find((text) => text.includes("Cross-Channel Blocklist"));

          expect(privateDisplay).toMatch(/Showing (\d+) of 220 channels \((\d+) hidden\)\./);
          expect(roleplayDisplay).toMatch(/Showing (\d+) of 220 channels \((\d+) hidden\)\./);
          expect(blocklistDisplay).toMatch(/Showing (\d+) of 220 channels \((\d+) hidden\)\./);
        }
      });
    });
  }

  describe("channels collection bounds fallback rendering for unknown locale tag", () => {
    for (const cc of collectionCases) {
      it(`renders a valid non-empty payload for ${cc.name} with unknown locale zz-ZZ`, () => {
        const payload = cc.buildPayload("zz-ZZ", 220);
        const validation = validateComponentsV2MessageLimits(payload);
        expect(validation.valid, `Violations: ${JSON.stringify(validation.violations)}`).toBe(true);

        const displays = getTextDisplays(payload);
        expect(displays.length).toBeGreaterThan(0);
        for (const text of displays) {
          expect(text.trim().length).toBeGreaterThan(0);
        }
        let totalText = 0;
        for (const text of displays) {
          totalText += getDiscordTextLength(text);
        }
        expect(totalText).toBeLessThanOrEqual(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX);
      });
    }
  });

  it("renders exactly two fence delimiters when a channel list with five backticks is fenced", () => {
    const channelListWithFiveBackticks = [
      `<#${makeSnowflake(1)}>: Persona \`\`\`\`\` with backticks`,
      `<#${makeSnowflake(2)}>: Standard`,
    ].join("\n");
    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "channels",
      page: "destinations",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      readStatus: "fresh",
      channelsView: {
        availableTextChannels: [],
        availableBlocklistChannels: [],
        availableOverrideChannels: [],
        destinations: {
          thoughtLogChannelId: null,
          welcomeChannelId: null,
          welcomePersonaId: null,
          welcomePrompt: channelListWithFiveBackticks,
        },
      },
    });

    const validation = validateComponentsV2MessageLimits(payload);
    expect(validation.valid, `Violations: ${JSON.stringify(validation.violations)}`).toBe(true);

    const displays = getTextDisplays(payload);
    const welcomeDisplay = displays.find((text) => text.includes("Welcome Messages"));
    expect(welcomeDisplay).toBeDefined();
    const fenceMatches = welcomeDisplay?.match(/```/g) ?? [];
    expect(fenceMatches).toHaveLength(2);
  });

  it("shows truncation notice with counts when Destinations prompt is cut and omits notice when within budget", () => {
    const shortPayload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "channels",
      page: "destinations",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      readStatus: "fresh",
      channelsView: {
        availableTextChannels: [],
        availableBlocklistChannels: [],
        availableOverrideChannels: [],
        destinations: {
          thoughtLogChannelId: null,
          welcomeChannelId: null,
          welcomePersonaId: null,
          welcomePrompt: "Short welcome prompt.",
        },
      },
    });
    const shortDisplays = getTextDisplays(shortPayload);
    const shortWelcome = shortDisplays.find((text) => text.includes("Short welcome"));
    expect(shortWelcome).toBeDefined();
    expect(shortWelcome).not.toContain("Content truncated");

    const longPayload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "channels",
      page: "destinations",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      readStatus: "fresh",
      channelsView: {
        availableTextChannels: [],
        availableBlocklistChannels: [],
        availableOverrideChannels: [],
        destinations: {
          thoughtLogChannelId: null,
          welcomeChannelId: null,
          welcomePersonaId: null,
          welcomePrompt: "W".repeat(4000),
        },
      },
    });
    const longDisplays = getTextDisplays(longPayload);
    const longWelcome = longDisplays.find((text) => text.includes("Content truncated"));
    expect(longWelcome).toBeDefined();
    expect(longWelcome).toMatch(/Content truncated \(\d+\/4000 shown\)\./);
  });

  it("shows truncation notices with counts when Overrides values are cut and omits notices when within budget", () => {
    const selectedId = makeSnowflake(100);
    const shortPayload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "channels",
      page: "overrides",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      channelsSelectedChannelId: selectedId,
      readStatus: "fresh",
      channelsView: {
        availableTextChannels: [],
        availableBlocklistChannels: [],
        availableOverrideChannels: [{ id: selectedId }],
        overrides: {
          selectedChannelId: selectedId,
          prompt: { prompt: "Short prompt.", mode: "append" },
          contextNote: { note: "Short note.", depth: 3 },
          textModelOverride: null,
        },
      },
    });
    const shortDisplays = getTextDisplays(shortPayload);
    expect(shortDisplays.some((text) => text.includes("Content truncated"))).toBe(false);

    const longPayload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "channels",
      page: "overrides",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      channelsSelectedChannelId: selectedId,
      readStatus: "fresh",
      channelsView: {
        availableTextChannels: [],
        availableBlocklistChannels: [],
        availableOverrideChannels: [{ id: selectedId }],
        overrides: {
          selectedChannelId: selectedId,
          prompt: { prompt: "P".repeat(4000), mode: "append" },
          contextNote: { note: "C".repeat(2000), depth: 3 },
          textModelOverride: null,
        },
      },
    });
    const longDisplays = getTextDisplays(longPayload);
    const promptDisplay = longDisplays.find((text) => text.includes("Mode:") && text.includes("Content truncated"));
    const noteDisplay = longDisplays.find((text) => text.includes("Depth:") && text.includes("Content truncated"));
    expect(promptDisplay).toBeDefined();
    expect(promptDisplay).toMatch(/Content truncated \(\d+\/4000 shown\)\./);
    expect(noteDisplay).toBeDefined();
    expect(noteDisplay).toMatch(/Content truncated \(\d+\/2000 shown\)\./);
  });
});
