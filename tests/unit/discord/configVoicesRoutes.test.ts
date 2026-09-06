import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { PermissionsBitField, type APIAttachment, type Client } from "discord.js";
import type { ServerSpeechConfigRow, TomoriState, VoiceSampleRow } from "@/types/db/schema";
import * as speechRepository from "@/utils/db/repositories/SpeechRepository";
import * as voiceSampleStorage from "@/utils/storage/voiceSampleStorage";
import { configRepository } from "@/utils/db/repositories";
import { buildConfigRouteId } from "@/utils/discord/configPanelCatalog";
import {
  computeVoiceSampleFingerprint,
  encodeVoiceSampleOptionValue,
  voiceSampleAttachmentName,
} from "@/utils/discord/ui/configVoicesPanel";
import { createConfigInteractionRoute } from "@/utils/discord/interactions/configRoutes";
import { loadConfigVoicesView } from "@/utils/discord/interactions/configVoicesLoader";
import type { ConfigRouteDependencies, ConfigScope } from "@/utils/discord/interactions/configRouteContext";
import * as configPermissionPolicy from "@/utils/discord/interactions/configPermissionPolicy";
import { InteractionRouteRegistry } from "@/utils/discord/interactions/routeRegistry";
import {
  buildConfigModalFieldId,
  CONFIG_TTS_CFG_WEIGHT_FIELD,
  CONFIG_TTS_EXAGGERATION_FIELD,
  CONFIG_TTS_TURBO_FIELD,
} from "@/utils/discord/ui/configModals";
import { addVoiceSample, type VoiceSampleAddDependencies } from "@/utils/speech/voiceSampleAddOperation";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

const CLIENT = {} as Client;

function makeState(): TomoriState {
  return {
    server_id: 9,
    persona_id: 55,
    persona_nickname: "Sparrow",
    is_alter: false,
    trigger_words: [],
    naming_config: { prefixes: {}, suffixes: {}, addressTerms: {} },
    attribute_list: [],
    sample_dialogues_in: [],
    sample_dialogues_out: [],
    llm: { llm_id: 1, llm_codename: "gemini-2.5-flash", llm_provider: "google", sees_images: true, has_tools: true },
    vision_llm: null,
    fallback_chain: [],
    config: {
      llm_id: 1,
      vision_llm_id: null,
      embedding_model_id: null,
      diffusion_model_id: null,
      nai_diffusion_model_id: null,
      video_model_id: null,
      imagegen_enabled: true,
      videogen_enabled: false,
      chatterbox_turbo_enabled: true,
      chatterbox_cfg_weight: 0.5,
      chatterbox_exaggeration: 0.5,
    },
  } as unknown as TomoriState;
}

function makeSample(index: number): VoiceSampleRow {
  return {
    sample_id: index + 1,
    name: `sample-${String(index + 1).padStart(2, "0")}`,
    file_path: `data/voice-samples/sample-${index + 1}.wav`,
    ref_text: null,
    duration_ms: 1000,
    created_at: new Date(0),
  } as VoiceSampleRow;
}

interface HarnessOptions {
  isManager?: boolean;
  samples?: VoiceSampleRow[];
  addDependencies?: VoiceSampleAddDependencies;
  useDefaultAddOperation?: boolean;
  speechConfig?: ServerSpeechConfigRow | null;
  useDefaultSpeechUpdate?: boolean;
  useDefaultRemoveOperation?: boolean;
  refCount?: number;
  guildId?: string | null;
  turboSelectValue?: string;
}

interface Harness {
  dependencies: Partial<ConfigRouteDependencies>;
  modals: unknown[];
  edits: unknown[];
  replies: unknown[];
  operationCalls: string[];
  fileUploadCalls: { value: number };
  deferredAtPreflight: boolean[];
  deferredAtDownload: boolean[];
  deferCalls: { value: number };
  turboSelectValue: { value: string | undefined };
  voiceSampleLoadCalls: { value: number };
  voiceViews: Array<{
    start: number;
    samples: VoiceSampleRow[];
    totalSampleCount: number;
    selectedIndex: number | null;
  }>;
  samples: VoiceSampleRow[];
}

type ConfigInteraction = Parameters<ReturnType<typeof createConfigInteractionRoute>["execute"]>[1];
let currentInteraction: ConfigInteraction | undefined;

function makeHarness(options: HarnessOptions = {}): Harness {
  const modals: unknown[] = [];
  const edits: unknown[] = [];
  const replies: unknown[] = [];
  const operationCalls: string[] = [];
  const fileUploadCalls = { value: 0 };
  const deferredAtPreflight: boolean[] = [];
  const deferredAtDownload: boolean[] = [];
  const deferCalls = { value: 0 };
  const turboSelectValue = { value: options.turboSelectValue ?? "on" };
  const voiceSampleLoadCalls = { value: 0 };
  const voiceViews: Harness["voiceViews"] = [];
  const samples = options.samples ?? Array.from({ length: 30 }, (_, index) => makeSample(index));
  const state = makeState();

  const addDependencies: VoiceSampleAddDependencies = options.addDependencies ?? {
    safeDownload: async () => {
      deferredAtDownload.push(currentInteraction?.deferred === true);
      return { success: true, buffer: Buffer.from("raw") };
    },
    parseDuration: async () => 1.25,
    normalizeToWav: async () => Buffer.from("RIFF-test"),
    insertVoiceSample: async (_serverId, _name, _refText, _durationMs) => {
      operationCalls.push("insert");
      samples.push(makeSample(samples.length));
      return 42;
    },
    storeVoiceSample: async () => {
      operationCalls.push("store");
      return "data/voice-samples/9/42.wav";
    },
    updateVoiceSamplePath: async () => {
      operationCalls.push("update");
    },
    deleteVoiceSample: async () => {
      operationCalls.push("delete");
    },
  };

  const scope = (): ConfigScope => ({
    serverDiscId: options.guildId === null ? "user-1" : "guild-1",
    guildId: options.guildId === null ? null : "guild-1",
    internalServerId: 9,
    userId: 1,
    actor: {
      workspaceKind: options.guildId === null ? "dm" : "guild",
      isManager: options.isManager ?? true,
    },
    personas: [state],
    readStatus: "fresh",
  });

  const dependencies: Partial<ConfigRouteDependencies> = {
    resolveScope: async () => scope(),
    getPersonaAvatarData: async () => ({ url: null, files: [] }),
    createNonce: () => "nonce1234567",
    showModal: async (_interaction, payload) => {
      modals.push(payload);
    },
    takeFileUpload: () => {
      fileUploadCalls.value += 1;
      deferredAtPreflight.push(currentInteraction?.deferred === true);
      return {
        id: "attachment-1",
        filename: "reference.wav",
        content_type: "audio/wav",
        size: 128,
        url: "https://cdn.example/reference.wav",
        proxy_url: "https://cdn.example/reference.wav",
      } as APIAttachment;
    },
    loadVoiceSamples: async () => {
      voiceSampleLoadCalls.value += 1;
      return samples;
    },
    loadVoicesView: async (_state, requestedStart = 0, loaderDependencies) => {
      const currentSamples = loaderDependencies ? await loaderDependencies.loadVoiceSamples(9) : samples;
      const view = {
        turboEnabled: true,
        cfgWeight: 0.5,
        exaggeration: 0.5,
        samples: currentSamples.slice(requestedStart, requestedStart + 25),
        totalSampleCount: currentSamples.length,
        start: requestedStart,
        selectedIndex: null,
      };
      voiceViews.push(view);
      return view;
    },
    loadSpeechConfig: async () =>
      options.speechConfig === undefined
        ? {
            server_id: 9,
            chatterbox_turbo_enabled: true,
            chatterbox_cfg_weight: 0.5,
            chatterbox_exaggeration: 0.5,
          }
        : options.speechConfig,
    invalidateSpeechConfigCache: () => undefined,
    takeSelectValue: () => turboSelectValue.value,
    countVoiceSampleRefs: async () => options.refCount ?? 0,
    voiceSampleAddDependencies: addDependencies,
    addVoiceSample: options.useDefaultAddOperation === false ? undefined : addVoiceSample,
  };
  if (options.useDefaultSpeechUpdate) delete dependencies.updateSpeechConfig;
  else dependencies.updateSpeechConfig = async () => true;
  if (options.useDefaultRemoveOperation) delete dependencies.removeVoiceSample;
  else dependencies.removeVoiceSample = async () => ({ storedFileRemoved: true });

  const harness = {
    dependencies,
    modals,
    edits,
    replies,
    operationCalls,
    fileUploadCalls,
    deferredAtPreflight,
    deferredAtDownload,
    deferCalls,
    turboSelectValue,
    voiceSampleLoadCalls,
    voiceViews,
    samples,
  };
  currentInteraction = undefined;
  return harness;
}

function makeInteraction(options: {
  customId: string;
  kind: "button" | "modal" | "select";
  fields?: Record<string, string>;
  values?: string[];
  isManager?: boolean;
  guildId?: string | null;
  harness: Harness;
}): ConfigInteraction {
  let deferred = false;
  const interaction = {
    id: "interaction-1",
    customId: options.customId,
    user: { id: "user-1", username: "Sparrow" },
    channelId: "channel-1",
    channel: { name: "lounge" },
    guildId: options.guildId === undefined ? "guild-1" : options.guildId,
    guild: options.guildId === null ? null : { id: "guild-1" },
    client: { user: null },
    memberPermissions: {
      has: (flag: bigint) => (options.isManager ?? true) && flag === PermissionsBitField.Flags.ManageGuild,
    },
    isButton: () => options.kind === "button",
    isStringSelectMenu: () => options.kind === "select",
    isModalSubmit: () => options.kind === "modal",
    get deferred() {
      return deferred;
    },
    get replied() {
      return false;
    },
    deferUpdate: async () => {
      deferred = true;
      options.harness.deferCalls.value += 1;
    },
    editReply: async (payload: unknown) => {
      options.harness.edits.push(payload);
      return payload;
    },
    reply: async (payload: unknown) => {
      options.harness.replies.push(payload);
      return payload;
    },
    followUp: async (payload: unknown) => payload,
    values: options.values ?? [],
    fields: {
      fields: new Map(Object.entries(options.fields ?? {})),
      getTextInputValue: (fieldId: string) => options.fields?.[fieldId] ?? "",
    },
  };
  currentInteraction = interaction as unknown as ConfigInteraction;
  return currentInteraction;
}

async function dispatch(
  harness: Harness,
  interaction: Parameters<ReturnType<typeof createConfigInteractionRoute>["execute"]>[1],
) {
  const registry = new InteractionRouteRegistry([createConfigInteractionRoute(harness.dependencies)]);
  await registry.dispatch(CLIENT, interaction);
}

function modalFields(): Record<string, string> {
  return {
    voice_sample_name_nonce1234567: "Reference voice",
    voice_sample_ref_text_nonce1234567: "Hello there",
  };
}

function ttsModalFields(values: { cfgWeight?: string; exaggeration?: string } = {}): Record<string, string> {
  return {
    [buildConfigModalFieldId(CONFIG_TTS_CFG_WEIGHT_FIELD, "nonce1234567")]: values.cfgWeight ?? "1.25",
    [buildConfigModalFieldId(CONFIG_TTS_EXAGGERATION_FIELD, "nonce1234567")]: values.exaggeration ?? "0.75",
  };
}

describe("config voice sample routes", () => {
  it("loads speech settings and a clamped 25-record page from the full library", async () => {
    const state = makeState();
    const samples = Array.from({ length: 51 }, (_, index) => makeSample(index));
    const view = await loadConfigVoicesView(state, 999, {
      loadSpeechConfig: async () => ({
        voice_transcript_chat_mode: true,
        chatterbox_turbo_enabled: false,
        chatterbox_cfg_weight: 0.7,
        chatterbox_exaggeration: 0.9,
      }),
      loadVoiceSamples: async () => samples,
    });

    expect(view.turboEnabled).toBe(false);
    expect(view.cfgWeight).toBe(0.7);
    expect(view.exaggeration).toBe(0.9);
    expect(view.start).toBe(50);
    expect(view.samples).toHaveLength(1);
    expect(view.totalSampleCount).toBe(51);
  });

  it("pages every current sample through the dispatcher and selects absolute index zero", async () => {
    const harness = makeHarness({ samples: Array.from({ length: 51 }, (_, index) => makeSample(index)) });
    for (const start of [0, 25, 50]) {
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({ action: "voice-sample-page", locale: "en-US", start }),
          kind: "button",
          harness,
        }),
      );
    }

    const visibleIds = new Set(harness.voiceViews.flatMap((view) => view.samples.map((sample) => sample.sample_id)));
    expect(visibleIds.size).toBe(51);
    expect(harness.voiceViews.map((view) => view.samples.length)).toEqual([25, 25, 1]);
    expect(harness.voiceSampleLoadCalls.value).toBe(3);

    const firstSample = harness.samples[0] as VoiceSampleRow;
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "voice-sample-select", locale: "en-US", start: 0 }),
        kind: "select",
        values: [encodeVoiceSampleOptionValue(0, computeVoiceSampleFingerprint(firstSample))],
        harness,
      }),
    );

    const selectedView = harness.voiceViews.at(-1);
    expect(selectedView?.start).toBe(0);
    expect(selectedView?.selectedIndex).toBe(0);
    expect(harness.voiceSampleLoadCalls.value).toBe(4);
  });

  it("reads a validated index-zero sample after acknowledgement and delivers a matching File attachment", async () => {
    let readAfterDefer = false;
    const reader = spyOn(voiceSampleStorage, "loadStoredVoiceSampleBuffer").mockImplementation(async () => {
      readAfterDefer = currentInteraction?.deferred === true;
      return Buffer.from("RIFF-preview");
    });
    const harness = makeHarness({ samples: [makeSample(0)] });
    const sample = harness.samples[0] as VoiceSampleRow;

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "voice-sample-select", locale: "en-US", start: 0 }),
        kind: "select",
        values: [encodeVoiceSampleOptionValue(0, computeVoiceSampleFingerprint(sample))],
        harness,
      }),
    );

    const payload = harness.edits.at(-1) as { components: unknown[]; files: Array<{ name?: string }> };
    expect(readAfterDefer).toBe(true);
    expect(JSON.stringify(payload.components)).toContain(`"type":13`);
    expect(JSON.stringify(payload.components)).toContain(`attachment://${voiceSampleAttachmentName(1)}`);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]?.name).toBe(voiceSampleAttachmentName(1));
    reader.mockRestore();
  });

  it("keeps selected metadata and clears files when the preview read fails", async () => {
    const reader = spyOn(voiceSampleStorage, "loadStoredVoiceSampleBuffer").mockRejectedValue(new Error("unreadable"));
    const harness = makeHarness({ samples: [makeSample(0)] });
    const sample = harness.samples[0] as VoiceSampleRow;

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "voice-sample-select", locale: "en-US", start: 0 }),
        kind: "select",
        values: [encodeVoiceSampleOptionValue(0, computeVoiceSampleFingerprint(sample))],
        harness,
      }),
    );

    const payload = harness.edits.at(-1) as { components: unknown[]; files: unknown[] };
    expect(JSON.stringify(payload.components)).toContain("sample-01");
    expect(JSON.stringify(payload.components)).toContain("Audio preview is unavailable.");
    expect(JSON.stringify(payload.components)).not.toContain(`"type":13`);
    expect(payload.files).toEqual([]);
    reader.mockRestore();
  });

  it("replaces a previous preview attachment with the newly selected sample state", async () => {
    const reader = spyOn(voiceSampleStorage, "loadStoredVoiceSampleBuffer")
      .mockResolvedValueOnce(Buffer.from("first"))
      .mockResolvedValueOnce(null);
    const harness = makeHarness({ samples: [makeSample(0), makeSample(1)] });

    for (const index of [0, 1]) {
      const sample = harness.samples[index] as VoiceSampleRow;
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({ action: "voice-sample-select", locale: "en-US", start: 0 }),
          kind: "select",
          values: [encodeVoiceSampleOptionValue(index, computeVoiceSampleFingerprint(sample))],
          harness,
        }),
      );
    }

    const firstPayload = harness.edits.at(-2) as { components: unknown[]; files: unknown[] };
    const secondPayload = harness.edits.at(-1) as { components: unknown[]; files: unknown[] };
    expect(firstPayload.files).toHaveLength(1);
    expect(secondPayload.files).toEqual([]);
    expect(JSON.stringify(secondPayload.components)).not.toContain(`"type":13`);
    expect(JSON.stringify(secondPayload.components)).toContain("Audio preview is unavailable.");
    reader.mockRestore();
  });

  it("does not read storage for stale selections or page navigation", async () => {
    const reader = spyOn(voiceSampleStorage, "loadStoredVoiceSampleBuffer").mockResolvedValue(Buffer.from("audio"));
    const harness = makeHarness({ samples: Array.from({ length: 30 }, (_, index) => makeSample(index)) });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "voice-sample-page", locale: "en-US", start: 25 }),
        kind: "button",
        harness,
      }),
    );
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "voice-sample-select", locale: "en-US", start: 0 }),
        kind: "select",
        values: [encodeVoiceSampleOptionValue(0, "stale000")],
        harness,
      }),
    );

    expect(reader).not.toHaveBeenCalled();
    reader.mockRestore();
  });

  it("does not read or attach previews for removal confirmation or cancellation", async () => {
    const reader = spyOn(voiceSampleStorage, "loadStoredVoiceSampleBuffer").mockResolvedValue(Buffer.from("audio"));
    const harness = makeHarness({ samples: [makeSample(0)] });
    harness.dependencies.removeVoiceSample = async () => ({ storedFileRemoved: false });
    const sample = harness.samples[0] as VoiceSampleRow;
    const fingerprint = computeVoiceSampleFingerprint(sample);

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "voice-sample-remove-view",
          locale: "en-US",
          index: 0,
          fp: fingerprint,
        }),
        kind: "button",
        harness,
      }),
    );
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "voice-sample-remove-confirm",
          locale: "en-US",
          index: 0,
          fp: fingerprint,
          nonce: "nonce1234567",
        }),
        kind: "button",
        harness,
      }),
    );
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "voice-sample-remove-cancel", locale: "en-US" }),
        kind: "button",
        harness,
      }),
    );

    expect(reader).not.toHaveBeenCalled();
    for (const edit of harness.edits) {
      const payload = edit as { components: unknown[]; files: unknown[] };
      expect(JSON.stringify(payload.components)).not.toContain(`"type":13`);
      expect(payload.files).toEqual([]);
    }
    reader.mockRestore();
  });

  it("opens a raw modal with a literal type 19 file upload nested in a type 18 label", async () => {
    const harness = makeHarness();
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "voice-sample-add-open", locale: "en-US" }),
      kind: "button",
      harness,
    });

    await dispatch(harness, interaction);

    const modal = harness.modals[0] as { components: Array<{ type: number; component?: { type: number } }> };
    expect(modal.components[0]?.type).toBe(18);
    expect(modal.components[0]?.component?.type).toBe(19);
  });

  it("opens the Chatterbox parameter modal with current values without deferring", async () => {
    const harness = makeHarness({
      speechConfig: {
        server_id: 9,
        voice_transcript_chat_mode: true,
        chatterbox_turbo_enabled: false,
        chatterbox_cfg_weight: 0.75,
        chatterbox_exaggeration: 1.25,
      },
    });
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "tts-parameters-open", locale: "en-US" }),
      kind: "button",
      harness,
    });

    await dispatch(harness, interaction);

    const modal = harness.modals[0] as {
      custom_id: string;
      components: Array<{
        type: number;
        description?: string;
        component?: {
          type: number;
          custom_id?: string;
          value?: string;
          options?: Array<{ label: string; value: string; default?: boolean }>;
        };
      }>;
    };
    expect(harness.deferCalls.value).toBe(0);
    expect(modal.custom_id).toContain("tts-params-sub");
    expect(modal.components).toHaveLength(3);
    expect(modal.components.slice(0, 2).every((field) => field.type === 18 && field.component?.type === 4)).toBe(true);
    expect(modal.components[0]?.component?.value).toBe("0.75");
    expect(modal.components[1]?.component?.value).toBe("1.25");
    expect(modal.components[0]?.description).toContain("0 to 2");
    expect(modal.components[1]?.description).toContain("0 to 2");
    expect(modal.components[2]?.type).toBe(18);
    expect(modal.components[2]?.component?.type).toBe(21);
    expect(modal.components[2]?.component?.custom_id).toBe(
      buildConfigModalFieldId(CONFIG_TTS_TURBO_FIELD, "nonce1234567"),
    );
    expect(modal.components[2]?.component?.options).toEqual([
      { label: "Off", value: "off", default: true },
      { label: "On", value: "on", default: false },
    ]);
  });

  it("rejects malformed, non-finite, and out-of-range parameters without updating", async () => {
    for (const value of ["", "not-a-number", "NaN", "-1", "2.01"]) {
      let updateCalls = 0;
      const harness = makeHarness();
      harness.dependencies.updateSpeechConfig = async () => {
        updateCalls += 1;
        return true;
      };
      const interaction = makeInteraction({
        customId: buildConfigRouteId({ action: "tts-parameters-submit", locale: "en-US", nonce: "nonce1234567" }),
        kind: "modal",
        fields: ttsModalFields({ cfgWeight: value }),
        harness,
      });

      await dispatch(harness, interaction);

      expect(harness.deferCalls.value).toBe(1);
      expect(updateCalls).toBe(0);
      expect(harness.edits).toHaveLength(1);
      if (value === "2.01") {
        const receipt = JSON.stringify(harness.edits[0]);
        expect(receipt).toContain("CFG weight");
        expect(receipt).toContain("0 to 2");
      }
    }
  });

  it("describes both invalid numeric settings without updating", async () => {
    let updateCalls = 0;
    const harness = makeHarness();
    harness.dependencies.updateSpeechConfig = async () => {
      updateCalls += 1;
      return true;
    };

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "tts-parameters-submit", locale: "en-US", nonce: "nonce1234567" }),
        kind: "modal",
        fields: ttsModalFields({ cfgWeight: "", exaggeration: "3" }),
        harness,
      }),
    );

    const receipt = JSON.stringify(harness.edits[0]);
    expect(receipt).toContain("CFG weight");
    expect(receipt).toContain("Exaggeration");
    expect(receipt).toContain("0 to 2");
    expect(updateCalls).toBe(0);
  });

  it("rejects a missing or invalid turbo selection without updating", async () => {
    let updateCalls = 0;
    const harness = makeHarness();
    harness.turboSelectValue.value = "invalid";
    harness.dependencies.updateSpeechConfig = async () => {
      updateCalls += 1;
      return true;
    };

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "tts-parameters-submit", locale: "en-US", nonce: "nonce1234567" }),
        kind: "modal",
        fields: ttsModalFields(),
        harness,
      }),
    );

    expect(updateCalls).toBe(0);
  });

  it("writes all Chatterbox parameters after acknowledgement", async () => {
    let sawAcknowledgement = false;
    const writes: Record<string, unknown>[] = [];
    const updateSpy = spyOn(configRepository, "updateSpeechConfig").mockImplementation(async (_serverId, patch) => {
      sawAcknowledgement = currentInteraction?.deferred === true || currentInteraction?.replied === true;
      writes.push(patch);
      return true;
    });
    const harness = makeHarness({
      useDefaultSpeechUpdate: true,
      speechConfig: {
        server_id: 9,
        voice_transcript_chat_mode: true,
        chatterbox_turbo_enabled: true,
        chatterbox_cfg_weight: 0.4,
        chatterbox_exaggeration: 0.6,
      },
    });
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "tts-parameters-submit", locale: "en-US", nonce: "nonce1234567" }),
      kind: "modal",
      fields: ttsModalFields(),
      harness,
    });
    harness.turboSelectValue.value = "off";

    await dispatch(harness, interaction);

    expect(sawAcknowledgement).toBe(true);
    expect(writes).toEqual([
      {
        chatterbox_cfg_weight: 1.25,
        chatterbox_exaggeration: 0.75,
        chatterbox_turbo_enabled: false,
      },
    ]);
    updateSpy.mockRestore();
  });

  it("invalidates only after a successful Chatterbox write", async () => {
    const outcomes: Array<boolean | Error> = [true, false, new Error("write failed")];
    let invalidations = 0;
    const harness = makeHarness();
    harness.dependencies.invalidateSpeechConfigCache = () => {
      invalidations += 1;
    };
    harness.dependencies.updateSpeechConfig = async () => {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome ?? false;
    };

    for (const enabled of [false, true, false]) {
      await dispatch(
        harness,
        makeInteraction({
          customId: buildConfigRouteId({ action: "tts-turbo-set", locale: "en-US", enabled }),
          kind: "button",
          harness,
        }),
      );
    }

    expect(invalidations).toBe(1);
    expect(harness.edits).toHaveLength(3);
  });

  it("writes turbo with the current cfg weight and exaggeration", async () => {
    const writes: Record<string, unknown>[] = [];
    const harness = makeHarness({
      speechConfig: {
        server_id: 9,
        voice_transcript_chat_mode: true,
        chatterbox_turbo_enabled: false,
        chatterbox_cfg_weight: 0.8,
        chatterbox_exaggeration: 1.1,
      },
    });
    harness.dependencies.updateSpeechConfig = async (_serverId, patch) => {
      writes.push(patch);
      return true;
    };

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "tts-turbo-set", locale: "en-US", enabled: true }),
        kind: "button",
        harness,
      }),
    );

    expect(writes).toEqual([
      {
        chatterbox_cfg_weight: 0.8,
        chatterbox_exaggeration: 1.1,
        chatterbox_turbo_enabled: true,
      },
    ]);
  });

  it("shows a fresh remove confirmation with current reference count", async () => {
    const samples = Array.from({ length: 51 }, (_, index) => makeSample(index));
    const harness = makeHarness({ samples, refCount: 3 });
    const sample = samples[26] as VoiceSampleRow;

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "voice-sample-remove-view",
          locale: "en-US",
          index: 26,
          fp: computeVoiceSampleFingerprint(sample),
        }),
        kind: "button",
        harness,
      }),
    );

    const view = harness.voiceViews.at(-1);
    expect(view?.start).toBe(25);
    expect(view?.selectedIndex).toBe(26);
    expect(JSON.stringify(harness.edits[0])).toContain("3 persona(s)");
    expect(harness.voiceSampleLoadCalls.value).toBe(1);
  });

  it("rejects stale removal fingerprints before the shared removal operation", async () => {
    const removeSpy = spyOn(speechRepository, "removeVoiceSample").mockResolvedValue({ storedFileRemoved: true });
    const samples = Array.from({ length: 3 }, (_, index) => makeSample(index));
    const harness = makeHarness({ samples, useDefaultRemoveOperation: true });
    const oldFingerprint = computeVoiceSampleFingerprint(samples[0] as VoiceSampleRow);

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "voice-sample-remove-view",
          locale: "en-US",
          index: 0,
          fp: "stale000",
        }),
        kind: "button",
        harness,
      }),
    );
    expect(removeSpy).not.toHaveBeenCalled();

    samples.unshift(makeSample(99));
    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "voice-sample-remove-confirm",
          locale: "en-US",
          index: 0,
          fp: oldFingerprint,
          nonce: "nonce1234567",
        }),
        kind: "button",
        harness,
      }),
    );
    expect(removeSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Panel Out Of Date");
    removeSpy.mockRestore();
  });

  it("removes the current row through the shared operation after acknowledgement", async () => {
    let sawAcknowledgement = false;
    const inputs: Array<Record<string, unknown>> = [];
    const removeSpy = spyOn(speechRepository, "removeVoiceSample").mockImplementation(async (input) => {
      sawAcknowledgement = currentInteraction?.deferred === true || currentInteraction?.replied === true;
      inputs.push(input);
      return { storedFileRemoved: false };
    });
    const samples = Array.from({ length: 3 }, (_, index) => makeSample(index));
    const harness = makeHarness({ samples, useDefaultRemoveOperation: true });
    const sample = samples[1] as VoiceSampleRow;

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({
          action: "voice-sample-remove-confirm",
          locale: "en-US",
          index: 1,
          fp: computeVoiceSampleFingerprint(sample),
          nonce: "nonce1234567",
        }),
        kind: "button",
        harness,
      }),
    );

    expect(sawAcknowledgement).toBe(true);
    expect(inputs).toEqual([
      {
        serverId: 9,
        serverDiscId: "guild-1",
        sampleId: 2,
        filePath: "data/voice-samples/sample-2.wav",
      },
    ]);
    expect(JSON.stringify(harness.edits.at(-1))).toContain("Voice Sample Removed");
    removeSpy.mockRestore();
  });

  it("cancels removal on the first page", async () => {
    const harness = makeHarness({ samples: Array.from({ length: 51 }, (_, index) => makeSample(index)) });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "voice-sample-remove-cancel", locale: "en-US" }),
        kind: "button",
        harness,
      }),
    );

    expect(harness.voiceViews.at(-1)?.start).toBe(0);
    expect(harness.voiceSampleLoadCalls.value).toBe(1);
  });

  it("allows a DM owner to navigate the voice library", async () => {
    const harness = makeHarness({ guildId: null });

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "voice-sample-page", locale: "en-US", start: 0 }),
        kind: "button",
        guildId: null,
        harness,
      }),
    );

    expect(harness.voiceSampleLoadCalls.value).toBe(1);
    expect(harness.replies).toHaveLength(0);
  });

  it("runs the shared add pipeline after acknowledgement and repaints a fresh capped library", async () => {
    const harness = makeHarness();
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "voice-sample-add-submit", locale: "en-US", nonce: "nonce1234567" }),
      kind: "modal",
      fields: modalFields(),
      harness,
    });

    await dispatch(harness, interaction);

    expect(harness.deferredAtPreflight).toEqual([false]);
    expect(harness.fileUploadCalls.value).toBe(1);
    expect(harness.deferredAtDownload).toEqual([true]);
    expect(harness.operationCalls).toEqual(["insert", "store", "update"]);
    expect(harness.edits).toHaveLength(1);
    expect(JSON.stringify(harness.edits[0])).toContain("Select a sample to inspect.");
  });

  it("rejects format and size before the first download", async () => {
    for (const upload of [
      { filename: "reference.txt", content_type: "text/plain", size: 128 },
      { filename: "reference.wav", content_type: "audio/wav", size: 11 * 1024 * 1024 },
    ]) {
      let downloadCalls = 0;
      const harness = makeHarness({
        addDependencies: {
          safeDownload: async () => {
            downloadCalls += 1;
            return { success: true, buffer: Buffer.from("raw") };
          },
          parseDuration: async () => 1,
          normalizeToWav: async () => Buffer.from("RIFF-test"),
          insertVoiceSample: async () => 42,
          storeVoiceSample: async () => "path",
          updateVoiceSamplePath: async () => undefined,
          deleteVoiceSample: async () => undefined,
        },
      });
      harness.dependencies.takeFileUpload = () => {
        harness.fileUploadCalls.value += 1;
        harness.deferredAtPreflight.push(currentInteraction?.deferred === true);
        return {
          id: "attachment-1",
          filename: upload.filename,
          content_type: upload.content_type,
          size: upload.size,
          url: "https://cdn.example/reference.wav",
          proxy_url: "https://cdn.example/reference.wav",
        } as APIAttachment;
      };
      const interaction = makeInteraction({
        customId: buildConfigRouteId({ action: "voice-sample-add-submit", locale: "en-US", nonce: "nonce1234567" }),
        kind: "modal",
        fields: modalFields(),
        harness,
      });

      await dispatch(harness, interaction);
      expect(harness.deferredAtPreflight).toEqual([false]);
      expect(harness.fileUploadCalls.value).toBe(1);
      expect(downloadCalls).toBe(0);
      expect(harness.replies).toHaveLength(1);
    }
  });

  it("repaints a generic update failure when the acknowledged add operation throws", async () => {
    const harness = makeHarness();
    harness.dependencies.addVoiceSample = async () => {
      throw new Error("storage adapter failed");
    };
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "voice-sample-add-submit", locale: "en-US", nonce: "nonce1234567" }),
      kind: "modal",
      fields: modalFields(),
      harness,
    });

    await dispatch(harness, interaction);

    expect(harness.edits).toHaveLength(1);
    expect(JSON.stringify(harness.edits[0])).toContain("Update Failed");
  });

  it("compensates the inserted row when storage fails", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      addDependencies: {
        safeDownload: async () => ({ success: true, buffer: Buffer.from("raw") }),
        parseDuration: async () => 1,
        normalizeToWav: async () => Buffer.from("RIFF-test"),
        insertVoiceSample: async () => {
          order.push("insert");
          return 42;
        },
        storeVoiceSample: async () => {
          order.push("store");
          return null;
        },
        updateVoiceSamplePath: async () => order.push("update"),
        deleteVoiceSample: async () => order.push("delete"),
      },
    });
    const interaction = makeInteraction({
      customId: buildConfigRouteId({ action: "voice-sample-add-submit", locale: "en-US", nonce: "nonce1234567" }),
      kind: "modal",
      fields: modalFields(),
      harness,
    });

    await dispatch(harness, interaction);

    expect(order).toEqual(["insert", "store", "delete"]);
  });

  it("denies a guild member before repository insert or delete", async () => {
    const insertSpy = spyOn(speechRepository, "insertVoiceSample").mockResolvedValue(42);
    const deleteSpy = spyOn(speechRepository, "deleteVoiceSample").mockResolvedValue(undefined);
    const guardSpy = spyOn(configPermissionPolicy, "isConfigRouteAuthorized").mockReturnValue(true);
    const harness = makeHarness({ isManager: false, useDefaultAddOperation: true });
    harness.dependencies.voiceSampleAddDependencies = {
      safeDownload: async () => ({ success: true, buffer: Buffer.from("raw") }),
      parseDuration: async () => 1,
      normalizeToWav: async () => Buffer.from("RIFF-test"),
      insertVoiceSample: speechRepository.insertVoiceSample,
      storeVoiceSample: async () => "path",
      updateVoiceSamplePath: async () => undefined,
      deleteVoiceSample: speechRepository.deleteVoiceSample,
    };
    const weakenedInteraction = makeInteraction({
      customId: buildConfigRouteId({ action: "voice-sample-add-submit", locale: "en-US", nonce: "nonce1234567" }),
      kind: "modal",
      fields: modalFields(),
      isManager: false,
      harness,
    });

    await dispatch(harness, weakenedInteraction);
    expect(insertSpy).toHaveBeenCalled();
    guardSpy.mockRestore();
    insertSpy.mockClear();
    deleteSpy.mockClear();

    await dispatch(
      harness,
      makeInteraction({
        customId: buildConfigRouteId({ action: "voice-sample-add-submit", locale: "en-US", nonce: "nonce1234567" }),
        kind: "modal",
        fields: modalFields(),
        isManager: false,
        harness,
      }),
    );

    expect(insertSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    insertSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  it("denies a guild member before the real speech config repository write", async () => {
    const updateSpy = spyOn(configRepository, "updateSpeechConfig").mockResolvedValue(true);
    const harness = makeHarness({ isManager: false, useDefaultSpeechUpdate: true });
    const routeId = buildConfigRouteId({ action: "tts-turbo-set", locale: "en-US", enabled: false });

    await dispatch(harness, makeInteraction({ customId: routeId, kind: "button", isManager: false, harness }));
    expect(updateSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
  });

  it("denies a guild member before the real shared voice removal operation", async () => {
    const removeSpy = spyOn(speechRepository, "removeVoiceSample").mockResolvedValue({ storedFileRemoved: true });
    const guardSpy = spyOn(configPermissionPolicy, "isConfigRouteAuthorized").mockReturnValue(true);
    const harness = makeHarness({ isManager: false, useDefaultRemoveOperation: true });
    const sample = harness.samples[0] as VoiceSampleRow;
    const routeId = buildConfigRouteId({
      action: "voice-sample-remove-confirm",
      locale: "en-US",
      index: 0,
      fp: computeVoiceSampleFingerprint(sample),
      nonce: "nonce1234567",
    });

    await dispatch(harness, makeInteraction({ customId: routeId, kind: "button", isManager: false, harness }));
    expect(removeSpy).toHaveBeenCalled();

    guardSpy.mockRestore();
    removeSpy.mockClear();

    await dispatch(harness, makeInteraction({ customId: routeId, kind: "button", isManager: false, harness }));
    expect(removeSpy).not.toHaveBeenCalled();
    removeSpy.mockRestore();
  });
});
