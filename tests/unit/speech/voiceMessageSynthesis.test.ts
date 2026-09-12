/**
 * The synthesis dispatcher is the artifact the extraction claim rests on: the ladder's branch
 * conditions are part of the contract being moved, not incidental details of where they used to
 * sit. The bug this file exists to prevent was a predicate substitution during extraction: the old
 * design branch selected on `shouldUseVoiceDesignForPersona` (voice-design mode, or `auto` with the
 * `VoiceDesign` sentinel) and the new dispatcher re-derived the same guard from
 * `isVoiceDesignEndpoint` (voice-design mode only). One mode apart, and voice design was silently
 * dead on every `auto` deployment.
 *
 * The adapters are network clients, so they are stubbed: what is under test is which backend a
 * given (endpoint, source shape) pair selects, and what it refuses without reaching a backend.
 */
import { describe, expect, it, mock } from "bun:test";
import type { CustomEndpointRow } from "@/types/db/schema";
import type { TtsCloneResult } from "@/providers/custom/styles/ttsCloningAdapter";
import * as realElevenLabsAdapter from "@/providers/custom/styles/elevenLabsAdapter";
import * as realTtsCloningAdapter from "@/providers/custom/styles/ttsCloningAdapter";
import * as realTtsVoiceDesignAdapter from "@/providers/custom/styles/ttsVoiceDesignAdapter";
import { createScopedModuleMocker } from "../../helpers/mockSurface";
import { resolveVoiceSourceCapabilities } from "@/utils/speech/voiceSourceCapabilities";
import { synthesizeVoiceMessage, type ResolvedVoiceSource } from "@/utils/speech/voiceMessageSynthesis";

type VoiceMode = "clone" | "voice-design" | "auto";

/** Backends the dispatcher reached, in call order. */
const backendCalls: string[] = [];
/** Request bodies the clone adapters received, for asserting what shape was posted. */
const cloneRequests: Array<Record<string, unknown>> = [];
/** Request bodies the design adapter received. */
const designRequests: Array<Record<string, unknown>> = [];
/** ElevenLabs `voiceSettings` values seen, including `undefined` when the field was omitted. */
const elevenLabsSettings: Array<Record<string, unknown> | undefined> = [];

const OK_RESULT: TtsCloneResult = {
  success: true,
  audioBuffer: Buffer.from("audio"),
  contentType: "audio/wav",
  extension: "wav",
  cleanedCaptionText: "script",
};

const cloneMock = mock(async (request: Record<string, unknown>) => {
  backendCalls.push("clone");
  cloneRequests.push(request);
  return OK_RESULT;
});
const cloneBufferMock = mock(async (request: Record<string, unknown>) => {
  backendCalls.push("clone-buffer");
  cloneRequests.push(request);
  return OK_RESULT;
});
const designMock = mock(async (request: Record<string, unknown>) => {
  backendCalls.push("design");
  designRequests.push(request);
  return OK_RESULT;
});
const elevenLabsMock = mock(async (request: { voiceSettings?: Record<string, unknown> }) => {
  backendCalls.push("elevenlabs");
  elevenLabsSettings.push(request.voiceSettings);
  return { success: true, audioBuffer: Buffer.from("audio"), contentType: "audio/mpeg", extension: "mp3" };
});

const scopedMock = createScopedModuleMocker(mock, {
  "@/providers/custom/styles/ttsCloningAdapter": realTtsCloningAdapter,
  "@/providers/custom/styles/ttsVoiceDesignAdapter": realTtsVoiceDesignAdapter,
  "@/providers/custom/styles/elevenLabsAdapter": realElevenLabsAdapter,
});

// The mocked specifiers are ESM namespaces, so each override is a plain own property in the factory
// object; `createScopedModuleMocker` swaps the factory's function for the real one when the scope
// closes, so later files in the same process still see the genuine adapters.
scopedMock.module("@/providers/custom/styles/ttsCloningAdapter", () => ({
  ...realTtsCloningAdapter,
  synthesizeSpeechViaTtsClone: cloneMock,
  synthesizeSpeechViaTtsCloneBuffer: cloneBufferMock,
}));

scopedMock.module("@/providers/custom/styles/ttsVoiceDesignAdapter", () => ({
  ...realTtsVoiceDesignAdapter,
  synthesizeSpeechViaTtsVoiceDesign: designMock,
}));

scopedMock.module("@/providers/custom/styles/elevenLabsAdapter", () => ({
  ...realElevenLabsAdapter,
  synthesizeSpeechViaElevenLabsAdapter: elevenLabsMock,
}));

function makeEndpoint(options: {
  apiStyle?: CustomEndpointRow["api_style"];
  voiceMode?: VoiceMode;
  scriptMarkup?: string;
  supportsInstruct?: boolean;
}): CustomEndpointRow {
  return {
    label: "Speech",
    api_style: options.apiStyle ?? "tts-clone",
    endpoint_url: "https://speech.example.test",
    extra_config: {
      ...(options.voiceMode ? { voice_mode: options.voiceMode } : {}),
      ...(options.scriptMarkup ? { script_markup: options.scriptMarkup } : {}),
      ...(options.supportsInstruct ? { supports_instruct: true } : {}),
    },
  } as unknown as CustomEndpointRow;
}

/** Runs one dispatch with a fresh call record. */
async function dispatch(
  endpoint: CustomEndpointRow | null,
  source: ResolvedVoiceSource,
  overrides: {
    elevenLabsApiKey?: string;
    voiceInstructions?: string;
    elevenLabsVoiceSettings?: Record<string, unknown>;
  } = {},
) {
  backendCalls.length = 0;
  cloneRequests.length = 0;
  designRequests.length = 0;
  elevenLabsSettings.length = 0;

  const result = await synthesizeVoiceMessage({
    endpoint,
    endpointApiKey: "endpoint-key",
    elevenLabsApiKey: overrides.elevenLabsApiKey ?? "elevenlabs-key",
    source,
    script: "Good morning",
    ...(overrides.voiceInstructions ? { voiceInstructions: overrides.voiceInstructions } : {}),
    ...(overrides.elevenLabsVoiceSettings ? { elevenLabsVoiceSettings: overrides.elevenLabsVoiceSettings } : {}),
  });

  return { calls: [...backendCalls], result };
}

const DESIGN_SOURCE: ResolvedVoiceSource = { kind: "design", designPrompt: "Warm and unhurried" };
const CLONE_SOURCE: ResolvedVoiceSource = { kind: "clone", voiceSampleId: 12 };
const CLONE_BUFFER_SOURCE: ResolvedVoiceSource = {
  kind: "clone-buffer",
  refAudio: Buffer.from("ref"),
  refText: "reference words",
};
const ELEVENLABS_SOURCE: ResolvedVoiceSource = { kind: "elevenlabs", voiceId: "voice-abc" };

describe("synthesizeVoiceMessage design sources", () => {
  it("reaches the design adapter on a dedicated voice-design endpoint", async () => {
    const { calls, result } = await dispatch(makeEndpoint({ voiceMode: "voice-design" }), DESIGN_SOURCE);

    expect(calls).toEqual(["design"]);
    expect(result.success).toBe(true);
    expect(result.backendKey).toBe("tts-voice-design");
  });

  it("reaches the design adapter on an auto endpoint", async () => {
    // The regression this file exists for: `isVoiceDesignEndpoint` is false for `auto`, so gating
    // the design branch on it disabled voice design on every mixed deployment.
    const { calls, result } = await dispatch(makeEndpoint({ voiceMode: "auto" }), DESIGN_SOURCE);

    expect(calls).toEqual(["design"]);
    expect(result.success).toBe(true);
    expect(result.backendKey).toBe("tts-voice-design");
  });

  it("sends the design prompt and delivery direction, not the spoken script", async () => {
    await dispatch(makeEndpoint({ voiceMode: "auto" }), DESIGN_SOURCE, {
      voiceInstructions: "sound sleepy and quiet",
    });

    expect(designRequests[0]).toMatchObject({
      designPrompt: "Warm and unhurried",
      voiceInstructions: "sound sleepy and quiet",
      script: "Good morning",
      apiKey: "endpoint-key",
    });
  });

  it("refuses a design source on a clone-only endpoint without reaching a backend", async () => {
    const { calls, result } = await dispatch(makeEndpoint({ voiceMode: "clone" }), DESIGN_SOURCE);

    expect(calls).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.backendKey).toBe("tts-voice-design");
    expect(result.details).toContain("does not support instruct-based voice design");
  });

  it("refuses a design source on ElevenLabs without reaching a backend", async () => {
    const { calls, result } = await dispatch(makeEndpoint({ apiStyle: "elevenlabs" }), DESIGN_SOURCE);

    expect(calls).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.details).toContain("does not support instruct-based voice design");
  });

  it("refuses a design source when no endpoint is active", async () => {
    const { calls, result } = await dispatch(null, DESIGN_SOURCE);

    expect(calls).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.backendKey).toBe("tts-voice-design");
  });
});

describe("synthesizeVoiceMessage clone sources", () => {
  it("reaches the sample-loading clone adapter on a clone endpoint", async () => {
    const { calls, result } = await dispatch(makeEndpoint({ voiceMode: "clone" }), CLONE_SOURCE);

    expect(calls).toEqual(["clone"]);
    expect(cloneRequests[0]).toMatchObject({ voiceSampleId: 12, apiKey: "endpoint-key" });
    expect(result.backendKey).toBe("tts-clone");
  });

  it("reaches the sample-loading clone adapter on an auto endpoint", async () => {
    const { calls } = await dispatch(makeEndpoint({ voiceMode: "auto" }), CLONE_SOURCE);

    expect(calls).toEqual(["clone"]);
  });

  it("reaches the buffer clone adapter for an ad-hoc upload and carries the reference transcript", async () => {
    const { calls } = await dispatch(makeEndpoint({ voiceMode: "auto" }), CLONE_BUFFER_SOURCE);

    expect(calls).toEqual(["clone-buffer"]);
    expect(cloneRequests[0]).toMatchObject({ refText: "reference words" });
  });

  it("forwards delivery direction to an instruct-capable clone adapter", async () => {
    await dispatch(makeEndpoint({ voiceMode: "clone", supportsInstruct: true }), CLONE_SOURCE, {
      voiceInstructions: "speak softly and slowly",
    });

    expect(cloneRequests[0]).toMatchObject({
      voiceSampleId: 12,
      instruct: "speak softly and slowly",
    });
  });

  it("refuses a clone source on a voice-design-only endpoint without reaching a backend", async () => {
    // Still `api_style === "tts-clone"`, so an api_style-only guard would post a clone-shaped body
    // to an instruct-only server.
    const { calls, result } = await dispatch(makeEndpoint({ voiceMode: "voice-design" }), CLONE_SOURCE);

    expect(calls).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.backendKey).toBe("tts-clone");
  });

  it("refuses a clone source on ElevenLabs without reaching a backend", async () => {
    const { calls, result } = await dispatch(makeEndpoint({ apiStyle: "elevenlabs" }), CLONE_SOURCE);

    expect(calls).toEqual([]);
    expect(result.success).toBe(false);
  });

  it("refuses a clone source when no endpoint is active", async () => {
    const { calls, result } = await dispatch(null, CLONE_SOURCE);

    expect(calls).toEqual([]);
    expect(result.success).toBe(false);
  });
});

describe("synthesizeVoiceMessage ElevenLabs sources", () => {
  it("reaches the ElevenLabs adapter", async () => {
    const { calls, result } = await dispatch(makeEndpoint({ apiStyle: "elevenlabs" }), ELEVENLABS_SOURCE);

    expect(calls).toEqual(["elevenlabs"]);
    expect(result.backendKey).toBe("elevenlabs");
  });

  it("refuses without an API key, without reaching a backend", async () => {
    const { calls, result } = await dispatch(makeEndpoint({ apiStyle: "elevenlabs" }), ELEVENLABS_SOURCE, {
      elevenLabsApiKey: "",
    });

    expect(calls).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.backendKey).toBe("elevenlabs");
    expect(result.details).toContain("No speech API key");
  });

  it("forwards per-invocation voice settings, and omits them when absent", async () => {
    await dispatch(makeEndpoint({ apiStyle: "elevenlabs" }), ELEVENLABS_SOURCE, {
      elevenLabsVoiceSettings: { stability: 0.3 },
    });
    expect(elevenLabsSettings).toEqual([{ stability: 0.3 }]);

    await dispatch(makeEndpoint({ apiStyle: "elevenlabs" }), ELEVENLABS_SOURCE);
    // Absent, not `{}`: the request body has to stay byte-identical to the provider defaults.
    expect(elevenLabsSettings).toEqual([undefined]);
  });
});

describe("design-shape capability", () => {
  it("is true for auto, exactly where the dedicated-endpoint predicate is false", () => {
    // The pair of predicates that got swapped during extraction. This assertion is the reminder
    // that they answer different questions and only one of them belongs in a dispatch guard.
    const auto = makeEndpoint({ voiceMode: "auto" });

    expect(resolveVoiceSourceCapabilities(auto).acceptsDesignShape).toBe(true);
    expect(realTtsVoiceDesignAdapter.isVoiceDesignEndpoint(auto)).toBe(false);
  });

  it("is false for a missing endpoint on every shape", () => {
    for (const endpoint of [null, undefined]) {
      expect(resolveVoiceSourceCapabilities(endpoint)).toEqual({
        acceptsCloneShape: false,
        acceptsDesignShape: false,
      });
    }
  });
});
