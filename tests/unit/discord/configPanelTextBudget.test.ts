/**
 * Text budgeting coverage for Config pages:
 * asserts message-wide Text Display budgets at stored maxima, boundary Unicode handling,
 * and fence breakout immunity.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import { ComponentType } from "discord.js";
import type { LlmRow, NaiPresetRow, SavedProviderConfigRow, TomoriState, VoiceSampleRow } from "@/types/db/schema";
import type { PanelReadStatus } from "@/types/discord/panel";
import type { ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import type {
  ConfigBehaviorView,
  ConfigChannelsView,
  ConfigPersonaMemoryView,
} from "@/utils/discord/interactions/configRouteContext";
import type { ConfigPersonaVoiceView } from "@/utils/discord/interactions/configPersonaVoiceLoader";
import {
  CONFIG_MODEL_CAPABILITY_ORDER,
  CONFIG_NAI_PRESET_PAGE_SIZE,
  isConfigCatalogModelCapability,
  type ConfigCatalogModelCapability,
} from "@/utils/discord/configPanelCatalog";
import {
  computeVoiceSampleFingerprint,
  voiceSampleAttachmentName,
  type ConfigVoicesView,
} from "@/utils/discord/ui/configVoicesPanel";
import type { ConfigPersonaVoiceRemoteView } from "@/utils/discord/ui/configVoicePanel";
import type { ConfigCapabilityEndpoint } from "@/utils/discord/interactions/configModelLoaders";
import type { ConfigParametersView, ConfigSwitchModelsView } from "@/utils/discord/ui/configModelsPanel";
import {
  DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX,
  DISCORD_TEXT_INPUT_MAX,
  getDiscordTextLength,
  validateComponentsV2MessageLimits,
} from "@/utils/discord/ui/componentsV2Limits";
import { buildConfigPanelPayload } from "@/utils/discord/ui/configPanel";
import { withLinePrefix } from "@/utils/discord/ui/panel";
import { getMemoryLimits } from "@/utils/misc/memoryLimits";
import { initializeLocalizer, localizer } from "@/utils/text/localizer";

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

function makeSavedProvider(provider: string): SavedProviderConfigRow {
  return { provider } as unknown as SavedProviderConfigRow;
}

function makeNaiPresetCatalog(count: number, runLength: number, oversized: boolean): NaiPresetRow[] {
  return Array.from({ length: count }, (_unused, index) => {
    const marker = `Preset ${index + 1} ${"`".repeat(runLength)} 😀`;
    const presetName = oversized && index === 0 ? `\uFEFF${marker}${"N".repeat(10000)}` : `${marker}${"N".repeat(256)}`;
    const description = oversized && index < 2 ? `${marker}${"D".repeat(10000)}` : `${marker}${"D".repeat(1024)}`;
    return {
      nai_preset_id: index + 1,
      preset_name: presetName,
      model_target: "kayra",
      is_default: index === 0,
      preset_desc: description,
      ja_preset_desc: description,
      parameters: {},
    } as NaiPresetRow;
  });
}

function makeNaiParametersView(providers: string[], presets: NaiPresetRow[], pageStart: number): ConfigParametersView {
  return {
    textProviders: providers,
    selectedProvider: providers[0] ?? null,
    selectedConfig: providers[0] ? makeSavedProvider(providers[0]) : null,
    stopStrings: [],
    speakerPatternEnabled: false,
    logitBiasEntries: [],
    logitBiasPageStart: 0,
    naiPresetView: {
      target: "kayra",
      compatibility: "eligible",
      presets,
      activePresetName: presets[0]?.preset_name ?? null,
      fingerprint: "12345678",
      pageStart,
    },
  };
}

function buildNaiParametersPayload(
  locale: string,
  readStatus: PanelReadStatus,
  receipt: boolean,
  providers: string[],
  presets: NaiPresetRow[],
  pageStart: number,
) {
  return buildConfigPanelPayload({
    locale,
    actor: GUILD_MANAGER,
    category: "models",
    page: "parameters",
    personas: [makePersona({ persona_id: 55 })],
    selectedPersonaId: 55,
    readStatus,
    modelParametersView: makeNaiParametersView(providers, presets, pageStart),
    receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
  });
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

function countRenderedComponents(payload: unknown): number {
  if (Array.isArray(payload)) {
    return payload.reduce((total, item) => total + countRenderedComponents(item), 0);
  }
  if (typeof payload !== "object" || payload === null) return 0;

  const record = payload as Record<string, unknown>;
  const ownCount = typeof record.type === "number" ? 1 : 0;
  const childCount = Array.isArray(record.components) ? countRenderedComponents(record.components) : 0;
  const accessoryCount = record.accessory ? countRenderedComponents(record.accessory) : 0;
  return ownCount + childCount + accessoryCount;
}

function getStringSelectMenus(payload: unknown): Array<Record<string, unknown>> {
  const menus: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (record.type === ComponentType.StringSelect) menus.push(record);
    if (Array.isArray(record.components)) visit(record.components);
    if (record.accessory) visit(record.accessory);
  };
  visit(payload);
  return menus;
}

function getVoiceSelectMenu(payload: unknown): Record<string, unknown> {
  const menu = getStringSelectMenus(payload).find((candidate) => {
    if (!Array.isArray(candidate.options)) return false;
    return candidate.options.some((option) => {
      if (typeof option !== "object" || option === null) return false;
      const value = (option as Record<string, unknown>).value;
      return value === "none" || (typeof value === "string" && value.includes(":"));
    });
  });
  expect(menu).toBeDefined();
  return menu as Record<string, unknown>;
}

function getPayloadTextTotal(payload: unknown): number {
  return getTextDisplays(payload).reduce((total, text) => total + getDiscordTextLength(text), 0);
}

const SWITCH_MODEL_SLOT_STATES: ReadonlyArray<{
  name: string;
  isUsable: (capability: ConfigCatalogModelCapability) => boolean;
}> = [
  { name: "all slots usable", isUsable: () => true },
  { name: "all slots unusable", isUsable: () => false },
  { name: "standard image slot usable", isUsable: (capability) => capability === "image" },
  { name: "NovelAI image slot usable", isUsable: (capability) => capability === "nai-image" },
  { name: "video slot usable", isUsable: (capability) => capability === "video" },
];

function makeSwitchModelsView(
  imageGenerationEnabled: boolean,
  videoGenerationEnabled: boolean,
  slotState: (capability: ConfigCatalogModelCapability) => boolean,
): ConfigSwitchModelsView {
  return {
    slots: CONFIG_MODEL_CAPABILITY_ORDER.filter(isConfigCatalogModelCapability).map((capability) => {
      const provider = `provider-${capability}`;
      const usable = slotState(capability);
      return {
        capability,
        currentModelName: usable ? `model-${capability}` : null,
        currentProvider: usable ? provider : null,
        eligibleProviders: usable ? [provider] : [],
        providerPageStart: 0,
        expandedProvider: null,
        expandedOptionCount: 0,
      };
    }),
    channelOverrideCount: 0,
    personaOverrideCount: 0,
    imageGenerationEnabled,
    videoGenerationEnabled,
  };
}

function makeExplicitCatalogSlot(
  capability: ConfigCatalogModelCapability,
  slotState: (candidate: ConfigCatalogModelCapability) => boolean,
) {
  const provider = `provider-${capability}`;
  const usable = slotState(capability);
  return {
    capability,
    currentModelName: usable ? `model-${capability}` : null,
    currentProvider: usable ? provider : null,
    eligibleProviders: usable ? [provider] : [],
    providerPageStart: 0,
    expandedProvider: null,
    expandedOptionCount: 0,
  };
}

function makeExplicitEightSlotView(
  imageGenerationEnabled: boolean,
  videoGenerationEnabled: boolean,
  slotState: (capability: ConfigCatalogModelCapability) => boolean,
  endpointCount: number,
  speechCapabilityEnabled: boolean,
  speechActiveIndex: number,
): ConfigSwitchModelsView {
  const makeEndpoints = (capability: "tts" | "stt"): ConfigCapabilityEndpoint[] =>
    Array.from({ length: endpointCount }, (_unused, index) => ({
      id: index + 1,
      capability: capability === "tts" ? "speech" : "transcription",
      label: `${capability}-endpoint-${index + 1}`,
      modelLabel: `${capability}-model-${index + 1}`,
      apiStyle: capability === "tts" ? "tts-clone" : "openai-compatible-transcription",
      isActive: index === speechActiveIndex,
    }));

  return {
    slots: [
      makeExplicitCatalogSlot("text", slotState),
      makeExplicitCatalogSlot("vision", slotState),
      makeExplicitCatalogSlot("embedding", slotState),
      makeExplicitCatalogSlot("image", slotState),
      makeExplicitCatalogSlot("nai-image", slotState),
      makeExplicitCatalogSlot("video", slotState),
    ],
    channelOverrideCount: 0,
    personaOverrideCount: 0,
    imageGenerationEnabled,
    videoGenerationEnabled,
    speechCapabilityEnabled,
    endpointSlots: [
      { capability: "tts", endpoints: makeEndpoints("tts"), pageStart: 0 },
      { capability: "stt", endpoints: makeEndpoints("stt"), pageStart: 0 },
    ],
  };
}

function getCapabilityWarningKey(capability: "image" | "video", enabled: boolean): string {
  if (capability === "image") {
    return enabled
      ? "commands.config.panel.image_generation_missing_model"
      : "commands.config.panel.image_generation_disabled_direction";
  }
  return enabled
    ? "commands.config.panel.video_generation_missing_model"
    : "commands.config.panel.video_generation_disabled_direction";
}

function makeVoiceSample(index: number, name: string, refText: string): VoiceSampleRow {
  return {
    sample_id: index + 1,
    server_id: 9,
    name,
    file_path: `data/voice-samples/sample-${index + 1}.wav`,
    ref_text: refText,
    duration_ms: 1250 + index * 25,
  };
}

const VOICE_SAMPLE_RUNS = [3, 4, 5, 6, 8];
const VOICE_SAMPLES: VoiceSampleRow[] = Array.from({ length: 53 }, (_, index) => {
  const runLength = VOICE_SAMPLE_RUNS[index % VOICE_SAMPLE_RUNS.length];
  const name =
    index === 0
      ? "A".repeat(80)
      : index === 1
        ? "B".repeat(81)
        : `Voice sample ${index + 1} ${"`".repeat(runLength)} 🌸✨`;
  const refText =
    index === 0
      ? "R".repeat(500)
      : `Reference ${index + 1} ${"`".repeat(runLength)} 🌸✨ ${"reference text ".repeat(40)}`;
  return makeVoiceSample(index, name, refText);
});

function makeVoicesView(samples: readonly VoiceSampleRow[], totalSampleCount: number, start: number): ConfigVoicesView {
  const selectedSample = samples[0];
  return {
    turboEnabled: true,
    cfgWeight: 0.75,
    exaggeration: 0.4,
    samples,
    totalSampleCount,
    start,
    selectedIndex: start < totalSampleCount ? start : null,
    ...(selectedSample?.sample_id !== undefined
      ? {
          preview: {
            sampleId: selectedSample.sample_id,
            fingerprint: computeVoiceSampleFingerprint(selectedSample),
            attachmentName: voiceSampleAttachmentName(selectedSample.sample_id),
            buffer: Buffer.from("RIFF-preview"),
            unavailable: false,
          },
        }
      : {}),
  };
}

// Tightness tolerances at stored maxima:
// When dynamic content is truncated, rendered message Text Display total should be tight to the limit.
// For character-cut bounded text previews (markdown fenced blocks, text prompts), cutting stops within 3 characters
// of available budget.
const PREVIEW_TIGHTNESS_TOLERANCE = 3;
// For collection-row lists (e.g. channel lists), trimming is whole-row discrete units (channel mentions + newlines +
// hidden notices), where a single channel row is ~25 characters. Multi-section pages (e.g. Channels Rules with 3
// sections) compound this waste across independent truncations plus a floor division remainder of up to 2 characters.
const COLLECTION_ROW_TIGHTNESS_TOLERANCE = 80;

describe("config page text budgeting at stored maxima", () => {
  const memoryLimits = getMemoryLimits();
  const maxAttribute = Math.min(4000, memoryLimits.maxAttributeLength);
  const maxDialogue = Math.min(4000, memoryLimits.maxSampleDialogueLength);

  const testCases = [
    {
      name: "Persona Identity & Personality",
      maxTolerance: PREVIEW_TIGHTNESS_TOLERANCE,
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
      maxTolerance: PREVIEW_TIGHTNESS_TOLERANCE,
      buildPayload: (locale: string, receipt: boolean) =>
        buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "persona",
          page: "appearance",
          personas: [
            makePersona({
              persona_id: 55,
              physical_appearance_tags: ["tag1".repeat(500), "tag2".repeat(500), "tag3".repeat(500)],
            }),
          ],
          selectedPersonaId: 55,
          selectedPersonaCharacterReferenceUrl: "attachment://persona_char_ref_55.png",
          readStatus: "fresh",
          receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
        }),
    },
    {
      name: "Persona Advanced",
      maxTolerance: PREVIEW_TIGHTNESS_TOLERANCE,
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
      maxTolerance: PREVIEW_TIGHTNESS_TOLERANCE,
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
      maxTolerance: PREVIEW_TIGHTNESS_TOLERANCE,
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
      maxTolerance: PREVIEW_TIGHTNESS_TOLERANCE,
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
            summary: "M".repeat(4000),
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
      maxTolerance: PREVIEW_TIGHTNESS_TOLERANCE,
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
      maxTolerance: COLLECTION_ROW_TIGHTNESS_TOLERANCE,
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
      maxTolerance: COLLECTION_ROW_TIGHTNESS_TOLERANCE,
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
      maxTolerance: PREVIEW_TIGHTNESS_TOLERANCE,
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

            const slack = DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX - totalText;
            const isTruncated = displays.some(
              (text) =>
                text.includes("Content truncated") ||
                text.includes("channels hidden") ||
                /Showing \d+ of \d+ channels/.test(text),
            );
            if (isTruncated) {
              expect(
                slack,
                `${tc.name} [${locale}] (receipt=${receipt}) slack ${slack} exceeds tolerance ${tc.maxTolerance}`,
              ).toBeLessThanOrEqual(tc.maxTolerance);
            }
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

describe("NovelAI preset Parameters budgeting", () => {
  const readStatuses: PanelReadStatus[] = ["fresh", "stale", "unavailable"];
  const providerSets = [["novelai"], ["novelai", "google"]];
  const presetCounts = [0, 1, 24, 25, 26, 60];
  const backtickRuns = [3, 4, 5, 6, 8];
  const stringProfiles = [
    { name: "stored-practical", oversized: false },
    { name: "oversized", oversized: true },
  ];

  for (const locale of RUNTIME_LOCALES) {
    for (const receipt of [false, true]) {
      for (const readStatus of readStatuses) {
        for (const providers of providerSets) {
          for (const runLength of backtickRuns) {
            for (const profile of stringProfiles) {
              for (const presetCount of presetCounts) {
                it(`keeps ${presetCount} ${profile.name} presets valid for ${providers.length} providers, ${readStatus}, and receipt=${receipt} (${locale}, backticks=${runLength})`, () => {
                  const presets = makeNaiPresetCatalog(presetCount, runLength, profile.oversized);
                  const pageStarts = Array.from(
                    { length: Math.max(1, Math.ceil(presetCount / CONFIG_NAI_PRESET_PAGE_SIZE)) },
                    (_unused, page) => page * CONFIG_NAI_PRESET_PAGE_SIZE,
                  );
                  const reachable = new Set<number>();
                  let componentCeiling = 0;

                  for (const pageStart of pageStarts) {
                    const payload = buildNaiParametersPayload(
                      locale,
                      readStatus,
                      receipt,
                      providers,
                      presets,
                      pageStart,
                    );
                    const validation = validateComponentsV2MessageLimits(payload);
                    expect(
                      validation.valid,
                      `${locale} ${readStatus} providers=${providers.length} presets=${presetCount} ` +
                        `page=${pageStart} receipt=${receipt}: ${JSON.stringify(validation.violations)}`,
                    ).toBe(true);
                    expect(getPayloadTextTotal(payload)).toBeLessThanOrEqual(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX);
                    componentCeiling = Math.max(componentCeiling, countRenderedComponents(payload));

                    for (const menu of getStringSelectMenus(payload)) {
                      const options = Array.isArray(menu.options) ? menu.options : [];
                      expect(options.length).toBeLessThanOrEqual(25);
                      if (typeof menu.customId === "string" && menu.customId.includes("nai-preset-select")) {
                        for (const option of options) {
                          if (typeof option !== "object" || option === null) continue;
                          const value = (option as Record<string, unknown>).value;
                          if (typeof value === "string" && /^\d+$/.test(value)) reachable.add(Number(value));
                          const description = (option as Record<string, unknown>).description;
                          if (typeof description === "string") {
                            expect(getDiscordTextLength(description)).toBeLessThanOrEqual(100);
                          }
                        }
                      }
                    }
                  }

                  if (readStatus !== "unavailable") {
                    expect([...reachable]).toEqual(Array.from({ length: presetCount }, (_unused, index) => index));
                  }
                  expect(componentCeiling).toBeGreaterThan(0);
                });
              }
            }
          }
        }
      }
    }
  }

  it("enforces the literal Parameters component ceiling and rejects an extra row", () => {
    const payload = buildNaiParametersPayload(
      "en-US",
      "fresh",
      true,
      ["novelai", "google"],
      makeNaiPresetCatalog(60, 8, true),
      46,
    );
    expect(countRenderedComponents(payload)).toBe(31);
    const payloadWithExtraRow = {
      ...payload,
      components: [
        ...payload.components,
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: "extra-nai-preset-row",
              placeholder: "Extra",
              options: [{ value: "one", label: "One" }],
            },
          ],
        },
      ],
    };
    expect(countRenderedComponents(payloadWithExtraRow)).toBeGreaterThan(31);
  });

  it("keeps normal active names exact while preserving a leading BOM in a bounded name", () => {
    const normalPresets = makeNaiPresetCatalog(1, 3, false);
    const normalPayload = buildNaiParametersPayload("en-US", "fresh", false, ["novelai"], normalPresets, 0);
    expect(getTextDisplays(normalPayload).join("\n")).toContain(normalPresets[0]?.preset_name ?? "");

    const oversizedPresets = makeNaiPresetCatalog(1, 3, true);
    const oversizedPayload = buildNaiParametersPayload("en-US", "fresh", true, ["novelai"], oversizedPresets, 0);
    const activeDisplay = getTextDisplays(oversizedPayload).find((text) => text.includes("Sampling Preset"));
    expect(activeDisplay).toBeDefined();
    expect(activeDisplay).toContain("\uFEFF");
    expect(getPayloadTextTotal(oversizedPayload)).toBeLessThanOrEqual(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX);
  });
});

describe("Persona Advanced and Overrides component budgeting", () => {
  const personas = Array.from({ length: 41 }, (_, index) =>
    makePersona({
      persona_id: index + 1,
      persona_prompt: index === 0 || index === 40 ? "P".repeat(4000) : undefined,
      context_note: index === 0 || index === 40 ? "C".repeat(2000) : undefined,
      nai_attg_author: index === 0 || index === 40 ? "A".repeat(256) : undefined,
      nai_attg_title: index === 0 || index === 40 ? "T".repeat(256) : undefined,
      nai_attg_tags: index === 0 || index === 40 ? "G".repeat(256) : undefined,
      nai_attg_genre: index === 0 || index === 40 ? "N".repeat(256) : undefined,
      humanizer_degree_override: index === 0 || index === 40 ? 2 : undefined,
      llm:
        index === 0 || index === 40
          ? { llm_id: 10, llm_provider: "openrouter", llm_codename: "server-model" }
          : undefined,
      persona_llm:
        index === 0 || index === 40 ? { llm_id: 11, llm_provider: "google", llm_codename: "persona-model" } : undefined,
    }),
  );
  const models = Array.from(
    { length: 26 },
    (_, index) =>
      ({
        llm_id: index + 1,
        llm_provider: "openrouter",
        llm_codename: `model-${index + 1}`,
        llm_description: `Model ${index + 1}`,
      }) as unknown as LlmRow,
  );

  const buildSplitPayload = (page: "advanced" | "overrides", receipt: boolean, selectedPersonaId = 41) =>
    buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "persona",
      page,
      personas,
      selectedPersonaId,
      serverHumanizerDegree: 0,
      readStatus: "fresh",
      view:
        page === "overrides"
          ? { kind: "text-override-model", personaId: 41, provider: "openrouter", models, start: 25 }
          : undefined,
      receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
    });

  it("keeps ATTG-bearing Advanced at literal 31 components and rejects an extra row", () => {
    for (const selectedPersonaId of [1, 41]) {
      for (const receipt of [false, true]) {
        const payload = buildSplitPayload("advanced", receipt, selectedPersonaId);
        const validation = validateComponentsV2MessageLimits(payload);
        expect(validation.valid, JSON.stringify(validation.violations)).toBe(true);
        const renderedComponentCount = countRenderedComponents(payload);
        expect(renderedComponentCount).toBe(receipt ? 31 : 29);
        const payloadWithExtraRow = {
          ...payload,
          components: [
            ...payload.components,
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.Button,
                  style: 2,
                  customId: `extra-advanced-row-${selectedPersonaId}-${receipt}`,
                  label: "Extra",
                },
                {
                  type: ComponentType.Button,
                  style: 2,
                  customId: `extra-advanced-row-${selectedPersonaId}-${receipt}-second`,
                  label: "Extra",
                },
              ],
            },
          ],
        };
        expect(countRenderedComponents(payloadWithExtraRow)).toBeGreaterThan(31);

        const selectedPersona = personas.find((persona) => persona.persona_id === selectedPersonaId);
        const attgValues = [
          selectedPersona?.nai_attg_author,
          selectedPersona?.nai_attg_title,
          selectedPersona?.nai_attg_tags,
          selectedPersona?.nai_attg_genre,
        ];
        expect(attgValues.map((value) => getDiscordTextLength(value ?? ""))).toEqual([256, 256, 256, 256]);
      }
    }
  });

  it("keeps Overrides at 29 components with a receipt and rejects an extra row", () => {
    const payload = buildSplitPayload("overrides", true);
    const validation = validateComponentsV2MessageLimits(payload);
    expect(validation.valid, JSON.stringify(validation.violations)).toBe(true);
    expect(countRenderedComponents(payload)).toBe(29);
    const payloadWithExtraRow = {
      ...payload,
      components: [
        ...payload.components,
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: "extra-overrides-row",
              placeholder: "Extra",
              options: [{ value: "one", label: "One" }],
            },
          ],
        },
      ],
    };
    expect(countRenderedComponents(payloadWithExtraRow)).toBeGreaterThan(29);
  });

  for (const page of ["advanced", "overrides"] as const) {
    for (const receipt of [false, true]) {
      it(`validates ${page} with receipt=${receipt}`, () => {
        const payload = buildSplitPayload(page, receipt);
        const validation = validateComponentsV2MessageLimits(payload);
        expect(validation.valid, JSON.stringify(validation.violations)).toBe(true);
      });
    }
  }
});

describe("Switch Models capability notice budgeting", () => {
  const flagCombinations = [
    { imageGenerationEnabled: false, videoGenerationEnabled: false },
    { imageGenerationEnabled: false, videoGenerationEnabled: true },
    { imageGenerationEnabled: true, videoGenerationEnabled: false },
    { imageGenerationEnabled: true, videoGenerationEnabled: true },
  ];

  const buildSwitchModelsPayload = (
    locale: string,
    receipt: boolean,
    imageGenerationEnabled: boolean,
    videoGenerationEnabled: boolean,
    slotState: (capability: ConfigCatalogModelCapability) => boolean,
  ) =>
    buildConfigPanelPayload({
      locale,
      actor: GUILD_MANAGER,
      category: "models",
      page: "switch",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      readStatus: "fresh",
      switchModelsView: makeSwitchModelsView(imageGenerationEnabled, videoGenerationEnabled, slotState),
      receipt: receipt ? { tone: "success", heading: "Saved", detail: "Configuration was saved." } : undefined,
    });

  for (const locale of RUNTIME_LOCALES) {
    describe(`locale ${locale}`, () => {
      for (const receipt of [false, true]) {
        for (const slotState of SWITCH_MODEL_SLOT_STATES) {
          for (const flags of flagCombinations) {
            it(`keeps ${slotState.name} valid for ${
              flags.imageGenerationEnabled ? "enabled" : "disabled"
            } image and ${flags.videoGenerationEnabled ? "enabled" : "disabled"} video (receipt=${receipt})`, () => {
              const payload = buildSwitchModelsPayload(
                locale,
                receipt,
                flags.imageGenerationEnabled,
                flags.videoGenerationEnabled,
                slotState.isUsable,
              );
              const validation = validateComponentsV2MessageLimits(payload);
              expect(validation.valid, `Violations: ${JSON.stringify(validation.violations)}`).toBe(true);

              const imageHasUsableModel = slotState.isUsable("image") || slotState.isUsable("nai-image");
              const videoHasUsableModel = slotState.isUsable("video");
              const imageHealthy = flags.imageGenerationEnabled && imageHasUsableModel;
              const videoHealthy = flags.videoGenerationEnabled && videoHasUsableModel;
              const expectedComponentCount = (receipt ? 27 : 25) + (imageHealthy && videoHealthy ? 0 : 1);
              expect(countRenderedComponents(payload)).toBe(expectedComponentCount);

              const renderedText = getTextDisplays(payload).join("\n");
              const expectedWarnings: string[] = [];
              if (!imageHealthy) {
                expectedWarnings.push(
                  withLinePrefix(
                    "-# ",
                    localizer(locale, getCapabilityWarningKey("image", flags.imageGenerationEnabled)),
                  ),
                );
              }
              if (!videoHealthy) {
                expectedWarnings.push(
                  withLinePrefix(
                    "-# ",
                    localizer(locale, getCapabilityWarningKey("video", flags.videoGenerationEnabled)),
                  ),
                );
              }

              for (const warning of expectedWarnings) {
                expect(renderedText).toContain(warning);
              }
              if (imageHealthy && videoHealthy) {
                const capabilityNotice = getTextDisplays(payload).find((text) =>
                  [
                    "commands.config.panel.image_generation_disabled_direction",
                    "commands.config.panel.image_generation_missing_model",
                    "commands.config.panel.video_generation_disabled_direction",
                    "commands.config.panel.video_generation_missing_model",
                  ].some((key) => text.includes(withLinePrefix("-# ", localizer(locale, key)))),
                );
                expect(capabilityNotice).toBeUndefined();
              }
            });
          }
        }
      }
    });
  }

  it("keeps the worst unhealthy receipt payload at the 28-component ceiling", () => {
    const payload = buildSwitchModelsPayload("en-US", true, true, true, () => false);
    expect(countRenderedComponents(payload)).toBe(28);

    const payloadWithExtraTextDisplay = {
      ...payload,
      components: [...payload.components, { type: ComponentType.TextDisplay, content: "Reserve" }],
    };
    expect(countRenderedComponents(payloadWithExtraTextDisplay)).toBeGreaterThan(28);
  });

  it("budgets an explicit eight-slot matrix across locales, flags, reads, and endpoint boundaries", () => {
    const componentBudget = 32;
    const componentReserve = 8;
    const discordComponentLimit = 40;
    const readStatuses: PanelReadStatus[] = ["fresh", "stale", "unavailable"];
    const endpointCounts = [0, 1, 24, 25, 26, 60];
    let maximumReceiptComponentCount = 0;

    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of [false, true]) {
        for (const readStatus of readStatuses) {
          for (const slotState of SWITCH_MODEL_SLOT_STATES) {
            for (const flags of flagCombinations) {
              for (const endpointCount of endpointCounts) {
                const payload = buildConfigPanelPayload({
                  locale,
                  actor: GUILD_MANAGER,
                  category: "models",
                  page: "switch",
                  personas: [makePersona({ persona_id: 55 })],
                  selectedPersonaId: 55,
                  readStatus,
                  switchModelsView: makeExplicitEightSlotView(
                    flags.imageGenerationEnabled,
                    flags.videoGenerationEnabled,
                    slotState.isUsable,
                    endpointCount,
                    true,
                    -1,
                  ),
                  receipt: receipt
                    ? { tone: "success", heading: "Saved", detail: "Configuration was saved." }
                    : undefined,
                });
                const validation = validateComponentsV2MessageLimits(payload);
                expect(
                  validation.valid,
                  `${locale} ${readStatus} ${slotState.name} endpoint=${endpointCount} ` +
                    `${flags.imageGenerationEnabled}/${flags.videoGenerationEnabled}: ${JSON.stringify(validation.violations)}`,
                ).toBe(true);
                for (const menu of getStringSelectMenus(payload)) {
                  const options = Array.isArray(menu.options) ? menu.options : [];
                  expect(options.length).toBeLessThanOrEqual(25);
                }
                const componentCount = countRenderedComponents(payload);
                expect(componentCount).toBeLessThanOrEqual(componentBudget);
                if (receipt) maximumReceiptComponentCount = Math.max(maximumReceiptComponentCount, componentCount);
              }
            }
          }
        }
      }
    }

    expect(maximumReceiptComponentCount).toBe(componentBudget);
    expect(maximumReceiptComponentCount).toBeLessThanOrEqual(discordComponentLimit - componentReserve);
    expect(maximumReceiptComponentCount + componentReserve).toBe(discordComponentLimit);

    const endpointPayload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "models",
      page: "switch",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      readStatus: "fresh",
      switchModelsView: makeExplicitEightSlotView(true, true, () => false, 1, true, 0),
    });
    expect(getTextDisplays(endpointPayload)).toContain("-# Use `/providers` to add more model choices.");
    const endpointMenus = getStringSelectMenus(endpointPayload).filter((menu) => {
      const customId = menu.customId;
      return typeof customId === "string" && customId.includes("ep-select");
    });
    expect(endpointMenus).toHaveLength(2);
    for (const capability of ["tts", "stt"] as const) {
      const menu = endpointMenus.find((candidate) => {
        const customId = candidate.customId;
        return typeof customId === "string" && customId.includes(capability);
      });
      expect(menu).toBeDefined();
      const placeholder = menu?.placeholder;
      expect(typeof placeholder).toBe("string");
      expect(placeholder).toContain(localizer("en-US", `commands.config.panel.capability_${capability}`));
      expect(placeholder).toContain(`${capability}-endpoint-1: ${capability}-model-1`);
      const options = menu?.options;
      expect(Array.isArray(options)).toBe(true);
      for (const option of options ?? []) {
        expect((option as Record<string, unknown>).default).not.toBe(true);
      }
    }

    for (const locale of RUNTIME_LOCALES) {
      const speechStates = [
        {
          enabled: false,
          activeIndex: 0,
          present: ["speech_capability_disabled_direction"],
          absent: ["speech_capability_enabled_direction", "speech_capability_missing_endpoint"],
        },
        {
          enabled: true,
          activeIndex: -1,
          present: ["speech_capability_enabled_direction", "speech_capability_missing_endpoint"],
          absent: ["speech_capability_disabled_direction"],
        },
        {
          enabled: true,
          activeIndex: 0,
          present: ["speech_capability_enabled_direction"],
          absent: ["speech_capability_disabled_direction", "speech_capability_missing_endpoint"],
        },
      ] as const;
      for (const speechState of speechStates) {
        const payload = buildConfigPanelPayload({
          locale,
          actor: GUILD_MANAGER,
          category: "models",
          page: "switch",
          personas: [makePersona({ persona_id: 55 })],
          selectedPersonaId: 55,
          readStatus: "fresh",
          switchModelsView: makeExplicitEightSlotView(
            true,
            true,
            () => false,
            1,
            speechState.enabled,
            speechState.activeIndex,
          ),
        });
        const renderedText = getTextDisplays(payload).join("\n");
        for (const key of speechState.present) {
          expect(renderedText).toContain(withLinePrefix("-# ", localizer(locale, `commands.config.panel.${key}`)));
        }
        for (const key of speechState.absent) {
          expect(renderedText).not.toContain(withLinePrefix("-# ", localizer(locale, `commands.config.panel.${key}`)));
        }
      }
    }

    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "models",
      page: "switch",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      readStatus: "fresh",
      switchModelsView: makeExplicitEightSlotView(true, true, () => false, 60, true, -1),
      receipt: { tone: "success", heading: "Saved", detail: "Configuration was saved." },
    });
    const ninthSlot = {
      ...payload,
      components: [
        ...payload.components,
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              customId: "ninth-slot",
              placeholder: "Ninth slot",
              options: [{ value: "one", label: "One" }],
            },
          ],
        },
      ],
    };
    expect(countRenderedComponents(ninthSlot)).toBeGreaterThan(componentBudget);
  });
});

describe("voices page text and component budgeting", () => {
  const buildVoicePayload = (
    locale: string,
    receipt: boolean,
    samples: readonly VoiceSampleRow[],
    totalSampleCount: number,
    start: number,
  ) =>
    buildConfigPanelPayload({
      locale,
      actor: GUILD_MANAGER,
      category: "models",
      page: "voices",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      readStatus: "fresh",
      voicesView: makeVoicesView(samples, totalSampleCount, start),
      receipt: receipt ? { tone: "success", heading: "Saved", detail: "Voice configuration was saved." } : undefined,
    });

  const expectValidVoicePayload = (payload: ReturnType<typeof buildVoicePayload>): void => {
    const validation = validateComponentsV2MessageLimits(payload);
    expect(validation.valid, `Violations: ${JSON.stringify(validation.violations)}`).toBe(true);
    expect(getPayloadTextTotal(payload)).toBeLessThanOrEqual(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX);
    expect(countRenderedComponents(payload)).toBeLessThanOrEqual(29);
  };

  for (const locale of RUNTIME_LOCALES) {
    describe(`locale ${locale}`, () => {
      for (const receipt of [false, true]) {
        it(`renders an empty library with one placeholder option (receipt=${receipt})`, () => {
          const payload = buildVoicePayload(locale, receipt, [], 0, 0);
          expectValidVoicePayload(payload);

          const menu = getVoiceSelectMenu(payload);
          const options = menu.options;
          expect(Array.isArray(options)).toBe(true);
          expect(options).toHaveLength(1);
          const option = options?.[0] as Record<string, unknown>;
          expect(option.value).toBe("none");
        });

        it(`renders a one-page library with 25 sample options (receipt=${receipt})`, () => {
          const pageSamples = VOICE_SAMPLES.slice(0, 25);
          const payload = buildVoicePayload(locale, receipt, pageSamples, pageSamples.length, 0);
          expectValidVoicePayload(payload);

          const menu = getVoiceSelectMenu(payload);
          const options = menu.options;
          expect(Array.isArray(options)).toBe(true);
          expect(options).toHaveLength(25);
          if (!Array.isArray(options)) return;

          const firstOption = options[0] as Record<string, unknown>;
          const secondOption = options[1] as Record<string, unknown>;
          expect(firstOption.label).toBe("A".repeat(80));
          expect(secondOption.label).toBe("B".repeat(81));
          expect(typeof firstOption.description).toBe("string");
          if (typeof firstOption.description === "string") {
            expect(getDiscordTextLength(firstOption.description)).toBe(100);
          }
          const labels = options.flatMap((option) => {
            const label = (option as Record<string, unknown>).label;
            return typeof label === "string" ? [label] : [];
          });
          for (const runLength of VOICE_SAMPLE_RUNS) {
            expect(labels.some((label) => label.includes("`".repeat(runLength)))).toBe(true);
          }
          expect(labels.some((label) => label.includes("🌸✨"))).toBe(true);
        });

        it(`covers every sample across deep library page slices (receipt=${receipt})`, () => {
          const starts = [0, 25, 50];
          const coveredIndices = new Set<number>();

          for (const start of starts) {
            const pageSamples = VOICE_SAMPLES.slice(start, start + 25);
            const payload = buildVoicePayload(locale, receipt, pageSamples, VOICE_SAMPLES.length, start);
            expectValidVoicePayload(payload);

            const menu = getVoiceSelectMenu(payload);
            const options = menu.options;
            expect(Array.isArray(options)).toBe(true);
            expect(options).toHaveLength(pageSamples.length);
            if (!Array.isArray(options)) continue;

            const pageIndices: number[] = [];
            for (const option of options) {
              const value = (option as Record<string, unknown>).value;
              expect(typeof value).toBe("string");
              if (typeof value !== "string") continue;
              const separator = value.indexOf(":");
              const index = Number.parseInt(value.slice(0, separator), 10);
              pageIndices.push(index);
              coveredIndices.add(index);
            }
            expect(pageIndices).toEqual(pageSamples.map((_sample, offset) => start + offset));
          }

          expect(coveredIndices).toEqual(new Set(VOICE_SAMPLES.map((_sample, index) => index)));
        });

        it(`reports 26 unsliced samples as an oversized select (receipt=${receipt})`, () => {
          const payload = buildVoicePayload(locale, receipt, VOICE_SAMPLES.slice(0, 26), VOICE_SAMPLES.length, 0);
          const validation = validateComponentsV2MessageLimits(payload);
          expect(validation.valid).toBe(false);
          expect(validation.violations).toContainEqual(
            expect.objectContaining({
              code: "SELECT_OPTIONS_OVERSIZED",
              observed: 26,
            }),
          );
        });
      }
    });
  }

  it("observes the 28-component receipt and deep-page ceiling from the rendered payload", () => {
    const payload = buildVoicePayload("en-US", true, VOICE_SAMPLES.slice(25, 50), VOICE_SAMPLES.length, 25);
    expectValidVoicePayload(payload);

    const observedCount = countRenderedComponents(payload);
    expect(observedCount).toBe(28);

    const payloadWithOverGenerousReserve = {
      ...payload,
      components: [...payload.components, { type: ComponentType.TextDisplay, content: "Reserve" }],
    };
    expect(countRenderedComponents(payloadWithOverGenerousReserve)).toBeGreaterThan(28);
  });
});

describe("Persona Voice page text and component budgeting", () => {
  const makePersonaVoiceView = (
    apiStyle: ConfigPersonaVoiceView["capability"]["apiStyle"],
    samples: readonly VoiceSampleRow[] = [],
    supportsVoiceDesign = false,
  ): ConfigPersonaVoiceView => ({
    capability: { apiStyle, assignable: apiStyle !== null, supportsVoiceDesign },
    samples: samples.map(({ sample_id, name, ref_text, duration_ms }) => ({
      sample_id,
      name,
      ref_text,
      duration_ms,
    })),
  });

  const buildVoicePayload = (
    locale: string,
    receipt: boolean,
    overrides: Partial<Parameters<typeof buildConfigPanelPayload>[0]> = {},
  ) =>
    buildConfigPanelPayload({
      locale,
      actor: GUILD_MANAGER,
      category: "persona",
      page: "voice",
      personas: [makePersona({ persona_id: 55 })],
      selectedPersonaId: 55,
      readStatus: "fresh",
      personaVoiceView: makePersonaVoiceView("tts-clone", VOICE_SAMPLES, true),
      receipt: receipt ? { tone: "success", heading: "Saved", detail: "Voice configuration was saved." } : undefined,
      ...overrides,
    });

  const assertValid = (payload: ReturnType<typeof buildVoicePayload>, expectedComponents?: number): void => {
    const validation = validateComponentsV2MessageLimits(payload);
    expect(validation.valid, `Violations: ${JSON.stringify(validation.violations)}`).toBe(true);
    const componentCount = countRenderedComponents(payload);
    expect(componentCount).toBeLessThanOrEqual(30);
    if (expectedComponents !== undefined) expect(componentCount).toBe(expectedComponents);
    expect(getPayloadTextTotal(payload)).toBeLessThanOrEqual(DISCORD_MESSAGE_TEXT_DISPLAY_TOTAL_MAX);
  };

  const maximumPersonaSet = (prompt: string): TomoriState[] => [
    makePersona({
      persona_id: 55,
      speech_voice_sample_id: VOICE_SAMPLES[0]?.sample_id,
      speech_voice_name: "Stored clone voice",
      speech_voice_design_prompt: prompt,
    }),
    ...Array.from({ length: 30 }, (_, index) => makePersona({ persona_id: index + 100 })),
  ];

  const expectedLocalMaximum = (receipt: boolean, avatarPresent: boolean): number =>
    26 + (receipt ? 2 : 0) + (avatarPresent ? 2 : 0);

  const makePrompt = (length: number, runLength: number): string => {
    const seed = `${"`".repeat(runLength)} 🌸✨ warm, unhurried voice. `;
    let prompt = seed;
    while (getDiscordTextLength(prompt) < length) prompt += "Detailed delivery guidance. ";
    return Array.from(prompt).slice(0, length).join("");
  };

  for (const locale of RUNTIME_LOCALES) {
    for (const receipt of [false, true]) {
      for (const avatarPresent of [false, true]) {
        it(`pins clone Voice maximum (locale=${locale}, receipt=${receipt}, avatar=${avatarPresent})`, () => {
          const payload = buildVoicePayload(locale, receipt, {
            personas: maximumPersonaSet(makePrompt(DISCORD_TEXT_INPUT_MAX, 3)),
            selectedPersonaId: 55,
            selectedPersonaAvatarUrl: avatarPresent ? "https://cdn.example/avatar.png" : null,
            receipt: receipt ? { tone: "success", heading: "Saved", detail: "Voice saved." } : undefined,
          });
          assertValid(payload, expectedLocalMaximum(receipt, avatarPresent));

          const voiceSelector = getStringSelectMenus(payload).find((menu) =>
            String(menu.customId).includes("voice-select"),
          );
          expect(voiceSelector).toBeDefined();
          const options = voiceSelector?.options as unknown[];
          expect(options).toHaveLength(25);
          expect((options.at(-1) as Record<string, unknown>).value).toBe("page:24");
        });
      }
    }
  }

  it("keeps the stored maximum and oversized prompts bounded for every fence run and astral emoji", () => {
    for (const promptSize of ["maximum", "oversized"] as const) {
      for (const runLength of [3, 4, 5, 6, 8]) {
        const prompt = makePrompt(
          promptSize === "maximum" ? DISCORD_TEXT_INPUT_MAX : DISCORD_TEXT_INPUT_MAX + 500,
          runLength,
        );
        const payload = buildVoicePayload("en-US", true, {
          personas: maximumPersonaSet(prompt),
          selectedPersonaAvatarUrl: "https://cdn.example/avatar.png",
        });
        assertValid(payload, 30);
        const promptDisplay = getTextDisplays(payload).find((text) => text.includes("Stored VoiceDesign prompt"));
        expect(promptDisplay).toBeDefined();
        const inner = promptDisplay?.replace(/^[\s\S]*```markdown\n/, "").replace(/\n```[\s\S]*$/, "") ?? "";
        expect(inner).not.toContain("``");
      }
    }

    const unsupportedPrompt = "🌸✨ hidden design prompt `".repeat(800);
    const unsupported = buildVoicePayload("en-US", false, {
      personas: maximumPersonaSet(unsupportedPrompt),
      personaVoiceView: makePersonaVoiceView("tts-clone", VOICE_SAMPLES, false),
    });
    const unsupportedText = getTextDisplays(unsupported).join("\n");
    expect(unsupportedText).not.toContain(unsupportedPrompt);
    expect(JSON.stringify(unsupported)).not.toContain("voice-design-open");
  });

  it("keeps the local library's advance entry within one select and fails its boundary if reserve is weakened", () => {
    const payload = buildVoicePayload("en-US", false, {
      personaVoiceView: makePersonaVoiceView("tts-clone", VOICE_SAMPLES.slice(0, 26), true),
    });
    assertValid(payload);
    const selector = getStringSelectMenus(payload).find((menu) => String(menu.customId).includes("voice-select"));
    expect(selector?.options).toHaveLength(25);
    expect(validateComponentsV2MessageLimits(payload).violations).not.toContainEqual(
      expect.objectContaining({ code: "SELECT_OPTIONS_OVERSIZED" }),
    );

    const coveredPositions = new Set<number>();
    for (const pageStart of [0, 24, 48]) {
      const pagePayload = buildVoicePayload("en-US", false, {
        personaVoicePageStart: pageStart,
        personaVoiceView: makePersonaVoiceView("tts-clone", VOICE_SAMPLES, true),
      });
      assertValid(pagePayload);
      const pageSelector = getStringSelectMenus(pagePayload).find((menu) =>
        String(menu.customId).includes("voice-select"),
      );
      for (const option of (pageSelector?.options ?? []) as Array<Record<string, unknown>>) {
        if (/^\d+$/.test(String(option.value))) coveredPositions.add(Number(option.value));
      }
    }
    expect(coveredPositions).toEqual(new Set(VOICE_SAMPLES.map((_sample, index) => index)));
  });

  it("renders a disabled endpoint control without leaking a stored unsupported prompt", () => {
    const missing = buildVoicePayload("en-US", false, {
      personaVoiceView: makePersonaVoiceView(null),
    });
    assertValid(missing);
    expect(JSON.stringify(missing)).toContain("No speech endpoint");
    expect(JSON.stringify(missing)).toContain('"disabled":true');
  });

  it("ends unsupported capability views with their notice so the persona hint remains absorbed", () => {
    for (const personaVoiceView of [
      makePersonaVoiceView(null),
      makePersonaVoiceView("tts-clone", VOICE_SAMPLES, false),
      makePersonaVoiceView("elevenlabs"),
    ]) {
      const payload = buildVoicePayload("en-US", false, { personaVoiceView });
      const finalTextDisplay = getTextDisplays(payload).at(-1);
      expect(finalTextDisplay).toContain("-#");
      assertValid(payload);
    }
  });

  it("measures a deep remote chooser separately and keeps position plus fingerprint values bounded", () => {
    const remoteView: ConfigPersonaVoiceRemoteView = {
      voices: Array.from({ length: 73 }, (_, index) => ({
        label: `Remote voice ${index} 🌸✨ ${"`".repeat([3, 4, 5, 6, 8][index % 5] ?? 3)}`,
        fingerprint: `catalog-fingerprint-${index}`,
      })),
      catalogFingerprint: "catalog-fingerprint",
      pageStart: 48,
    };
    for (const locale of RUNTIME_LOCALES) {
      for (const receipt of [false, true]) {
        for (const avatarPresent of [false, true]) {
          const payload = buildVoicePayload(locale, receipt, {
            personas: maximumPersonaSet("stored but hidden by provider mode").map((persona, index) =>
              index === 0
                ? {
                    ...persona,
                    speech_voice_sample_id: null,
                    speech_voice_id: "external-voice-id-48",
                    speech_voice_name: "Remote stored voice",
                  }
                : persona,
            ),
            selectedPersonaAvatarUrl: avatarPresent ? "https://cdn.example/avatar.png" : null,
            personaVoiceView: makePersonaVoiceView("elevenlabs"),
            personaVoiceRemoteView: remoteView,
            receipt: receipt ? { tone: "success", heading: "Saved", detail: "Voice saved." } : undefined,
          });
          assertValid(payload, 24 + (receipt ? 2 : 0) + (avatarPresent ? 2 : 0));
          const selector = getStringSelectMenus(payload).find((menu) => String(menu.customId).includes("voice-select"));
          const options = (selector?.options ?? []) as Array<Record<string, unknown>>;
          expect(options).toHaveLength(25);
          expect(options.slice(0, 24).every((option) => /^voice:\d+:[A-Za-z0-9_-]+$/.test(String(option.value)))).toBe(
            true,
          );
          expect(String(options.at(-1)?.value)).toMatch(/^page:\d+:[A-Za-z0-9_-]+$/);
          expect(JSON.stringify(payload)).not.toContain("external-voice-id-48");
          expect(JSON.stringify(payload)).not.toContain("stored but hidden by provider mode");
        }
      }
    }

    const onePage = buildVoicePayload("en-US", false, {
      personaVoiceView: makePersonaVoiceView("elevenlabs"),
      personaVoiceRemoteView: { voices: remoteView.voices?.slice(0, 25), catalogFingerprint: "short-catalog" },
    });
    expect(
      getStringSelectMenus(onePage).find((menu) => String(menu.customId).includes("voice-select"))?.options,
    ).toHaveLength(25);

    const coveredPositions = new Set<number>();
    for (const pageStart of [0, 24, 48, 72]) {
      const pagePayload = buildVoicePayload("en-US", false, {
        personaVoiceView: makePersonaVoiceView("elevenlabs"),
        personaVoiceRemoteView: { ...remoteView, pageStart: undefined },
        personaVoicePageStart: pageStart,
      });
      assertValid(pagePayload);
      const pageSelector = getStringSelectMenus(pagePayload).find((menu) =>
        String(menu.customId).includes("voice-select"),
      );
      for (const option of (pageSelector?.options ?? []) as Array<Record<string, unknown>>) {
        const match = String(option.value).match(/^voice:(\d+):/);
        if (match) coveredPositions.add(Number(match[1]));
      }
    }
    expect(coveredPositions).toEqual(new Set(remoteView.voices?.map((_voice, index) => index)));
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

  it.each([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12,
  ])("keeps all four 256-character ATTG previews fence-safe for run length %i", (runLength) => {
    const fieldValue = "🌸".repeat(256 - runLength) + "`".repeat(runLength);
    expect(getDiscordTextLength(fieldValue)).toBe(256);
    const payload = buildConfigPanelPayload({
      locale: "en-US",
      actor: GUILD_MANAGER,
      category: "persona",
      page: "advanced",
      personas: [
        makePersona({
          persona_id: 55,
          nai_attg_author: fieldValue,
          nai_attg_title: fieldValue,
          nai_attg_tags: fieldValue,
          nai_attg_genre: fieldValue,
        }),
      ],
      selectedPersonaId: 55,
      readStatus: "fresh",
      receipt: { tone: "success", heading: "Saved", detail: "Configuration was saved." },
    });

    const validation = validateComponentsV2MessageLimits(payload);
    expect(validation.valid, JSON.stringify(validation.violations)).toBe(true);
    const attgDisplay = getTextDisplays(payload).find((text) => text.includes("ATTG Configuration"));
    expect(attgDisplay).toBeDefined();
    expect(attgDisplay?.match(/```/g)).toHaveLength(8);
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
