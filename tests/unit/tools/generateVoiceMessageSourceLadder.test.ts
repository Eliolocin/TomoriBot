/**
 * The tool's source-selection ladder.
 *
 * This is the layer that had no test across two rounds of review, and both regressions lived here
 * rather than in the dispatcher below it. The ladder answers "which voice does this persona use,
 * and is it usable against this endpoint", and its two failure modes so far were:
 *
 *   - a design prompt unconditionally outranking a perfectly good clone sample, and
 *   - a shape capability asked of the fallback *list* instead of its members, which made the list
 *     unusable on exactly the servers where ElevenLabs is the only voice (an ElevenLabs endpoint,
 *     or no endpoint at all).
 *
 * Every collaborator below is stubbed, including delivery, so that `execute()` runs all the way to
 * a success result: a stub that fails would replace the tool's own refusal message with its own and
 * silently make every refusal assertion vacuous, which is the trap this file walked into once.
 */
import { describe, expect, it, mock } from "bun:test";
import type { CustomEndpointRow } from "@/types/db/schema";
import type { ToolContext } from "@/types/tool/interfaces";
import type { ResolvedVoiceSource } from "@/utils/speech/voiceMessageSynthesis";
import * as realSpeechEndpointResolver from "@/utils/provider/speechEndpointResolver";
import * as realVoiceMessageSynthesis from "@/utils/speech/voiceMessageSynthesis";
import * as realVoiceMessageDelivery from "@/utils/discord/webhook/voiceMessageDelivery";
import * as realVoiceMessageMetadata from "@/utils/audio/voiceMessageMetadata";
import { createScopedModuleMocker } from "../../helpers/mockSurface";
import { GenerateVoiceMessageTool } from "@/tools/functionCalls/generateVoiceMessageTool";

type VoiceMode = "clone" | "voice-design" | "auto";

let activeEndpoint: CustomEndpointRow | null = null;
/** Sources the tool handed to the dispatcher, most recent last. */
const dispatchedSources: ResolvedVoiceSource[] = [];

const endpointResolverMock = mock(async () =>
  activeEndpoint ? { endpoint: activeEndpoint, apiKey: "endpoint-key" } : null,
);

const synthesizeMock = mock(async (request: { source: ResolvedVoiceSource }) => {
  dispatchedSources.push(request.source);
  return {
    success: true,
    backendKey: "tts-clone" as const,
    audioBuffer: Buffer.from("audio"),
    contentType: "audio/wav",
    extension: "wav",
    cleanedCaptionText: "",
  };
});

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/provider/speechEndpointResolver": realSpeechEndpointResolver,
  "@/utils/speech/voiceMessageSynthesis": realVoiceMessageSynthesis,
  "@/utils/discord/webhook/voiceMessageDelivery": realVoiceMessageDelivery,
  "@/utils/audio/voiceMessageMetadata": realVoiceMessageMetadata,
});

scopedMock.module("@/utils/provider/speechEndpointResolver", () => ({
  ...realSpeechEndpointResolver,
  resolveActiveSpeechEndpoint: endpointResolverMock,
}));

scopedMock.module("@/utils/speech/voiceMessageSynthesis", () => ({
  ...realVoiceMessageSynthesis,
  synthesizeVoiceMessage: synthesizeMock,
}));

// A null waveform metadata result is the tool's own supported path: it falls back to a plain
// attachment. Stubbing it at null keeps delivery out of the picture without pretending the tool
// took a branch it did not.
scopedMock.module("@/utils/audio/voiceMessageMetadata", () => ({
  ...realVoiceMessageMetadata,
  generateVoiceMessageMetadata: async () => null,
}));

scopedMock.module("@/utils/discord/webhook/voiceMessageDelivery", () => ({
  ...realVoiceMessageDelivery,
  deliverVoiceMessage: async () => "message-id",
  postVoiceTranscriptCaption: async () => undefined,
}));

function makeEndpoint(voiceMode: VoiceMode): CustomEndpointRow {
  return {
    label: "Speech",
    api_style: "tts-clone",
    endpoint_url: "https://speech.example.test",
    extra_config: { voice_mode: voiceMode },
  } as unknown as CustomEndpointRow;
}

const ELEVENLABS_ENDPOINT = {
  label: "ElevenLabs",
  api_style: "elevenlabs",
  endpoint_url: "https://api.elevenlabs.io",
  extra_config: {},
} as unknown as CustomEndpointRow;

interface PersonaVoiceFields {
  speech_voice_sample_id?: number | null;
  speech_voice_design_prompt?: string | null;
  speech_voice_id?: string | null;
  speech_voice_name?: string | null;
}

function makeContext(fields: PersonaVoiceFields): ToolContext {
  return {
    channel: {},
    tomoriState: {
      server_id: "1",
      persona_lineage_id: 1,
      config: {},
      ...fields,
    },
  } as unknown as ToolContext;
}

/** Runs execute() and reports either the dispatched source or the refusal message. */
async function runTool(
  fields: PersonaVoiceFields,
  endpoint: CustomEndpointRow | null,
): Promise<{ source: ResolvedVoiceSource | null; error: string | null }> {
  activeEndpoint = endpoint;
  dispatchedSources.length = 0;

  const result = await new GenerateVoiceMessageTool().execute(
    { title: "test", script: "Good morning" },
    makeContext(fields),
  );

  return {
    source: dispatchedSources[0] ?? null,
    error: result.success ? null : (result.error ?? null),
  };
}

const SAMPLE = { speech_voice_sample_id: 12 };
const DESIGN_PROMPT = { speech_voice_design_prompt: "Warm and unhurried" };
const ELEVENLABS_VOICE = { speech_voice_id: "voice-abc" };

describe("GenerateVoiceMessageTool source ladder", () => {
  it("uses an ElevenLabs voice when the persona has one and no endpoint is registered", async () => {
    // The legacy opt_api_keys deployment: no speech endpoint at all.
    const { source, error } = await runTool(ELEVENLABS_VOICE, null);

    expect(error).toBeNull();
    expect(source).toEqual({ kind: "elevenlabs", voiceId: "voice-abc" });
  });

  it("uses an ElevenLabs voice when the active endpoint is ElevenLabs", async () => {
    const { source, error } = await runTool(ELEVENLABS_VOICE, ELEVENLABS_ENDPOINT);

    expect(error).toBeNull();
    expect(source).toEqual({ kind: "elevenlabs", voiceId: "voice-abc" });
  });

  it("falls past a sample to the ElevenLabs voice on an ElevenLabs endpoint", async () => {
    // The union-guard regression: the sample is preferred and then discarded, and the voice id has
    // to remain reachable afterwards. A list-wide capability check stranded this persona.
    const { source, error } = await runTool({ ...SAMPLE, ...ELEVENLABS_VOICE }, ELEVENLABS_ENDPOINT);

    expect(error).toBeNull();
    expect(source).toEqual({ kind: "elevenlabs", voiceId: "voice-abc" });
  });

  it("prefers the sample over the ElevenLabs voice on a clone endpoint", async () => {
    const { source, error } = await runTool({ ...SAMPLE, ...ELEVENLABS_VOICE }, makeEndpoint("clone"));

    expect(error).toBeNull();
    expect(source).toEqual({ kind: "clone", voiceSampleId: 12 });
  });

  it("uses the sample on an auto endpoint when the persona is not the VoiceDesign sentinel", async () => {
    // A design prompt is present too, but the sentinel is what selects the design branch. Without
    // it the sample must stay in play.
    const { source, error } = await runTool(
      { ...SAMPLE, ...DESIGN_PROMPT, speech_voice_name: "Millie" },
      makeEndpoint("auto"),
    );

    expect(error).toBeNull();
    expect(source).toEqual({ kind: "clone", voiceSampleId: 12 });
  });

  it("uses the design prompt on an auto endpoint when the persona is the VoiceDesign sentinel", async () => {
    const { source, error } = await runTool(
      { ...SAMPLE, ...DESIGN_PROMPT, speech_voice_name: "VoiceDesign" },
      makeEndpoint("auto"),
    );

    expect(error).toBeNull();
    expect(source).toEqual({ kind: "design", designPrompt: "Warm and unhurried" });
  });

  it("uses the design prompt on a dedicated voice-design endpoint", async () => {
    const { source, error } = await runTool(DESIGN_PROMPT, makeEndpoint("voice-design"));

    expect(error).toBeNull();
    expect(source).toEqual({ kind: "design", designPrompt: "Warm and unhurried" });
  });

  it("falls past a design prompt to the sample on a clone endpoint", async () => {
    const { source, error } = await runTool({ ...SAMPLE, ...DESIGN_PROMPT }, makeEndpoint("clone"));

    expect(error).toBeNull();
    expect(source).toEqual({ kind: "clone", voiceSampleId: 12 });
  });

  it("falls past a design prompt to the ElevenLabs voice on an ElevenLabs endpoint", async () => {
    const { source, error } = await runTool({ ...DESIGN_PROMPT, ...ELEVENLABS_VOICE }, ELEVENLABS_ENDPOINT);

    expect(error).toBeNull();
    expect(source).toEqual({ kind: "elevenlabs", voiceId: "voice-abc" });
  });

  it("falls past a design prompt to the sample on an auto endpoint without the sentinel", async () => {
    const { source, error } = await runTool(
      { ...SAMPLE, ...DESIGN_PROMPT, speech_voice_name: "Millie" },
      makeEndpoint("auto"),
    );

    expect(error).toBeNull();
    expect(source).toEqual({ kind: "clone", voiceSampleId: 12 });
  });
});

describe("GenerateVoiceMessageTool refusals", () => {
  it("reports no voice configured when the persona has no voice fields at all", async () => {
    const { source, error } = await runTool({}, makeEndpoint("clone"));

    expect(source).toBeNull();
    expect(error).toContain("No voice is configured");
  });

  it("names the design-endpoint mismatch when design is the persona's only configuration", async () => {
    const { source, error } = await runTool(DESIGN_PROMPT, makeEndpoint("clone"));

    expect(source).toBeNull();
    expect(error).toContain("does not support instruct-based voice design");
  });

  it("names the VoiceDesign sentinel on an auto endpoint without it", async () => {
    // The endpoint does accept `instruct`, so the design-endpoint message would be a lie, and the
    // shape-mismatch message would send the manager to swap an endpoint that is already right.
    // The sentinel is the entry condition that is actually missing, so the message has to say so.
    const { source, error } = await runTool({ ...DESIGN_PROMPT, speech_voice_name: "Millie" }, makeEndpoint("auto"));

    expect(source).toBeNull();
    expect(error).toContain("VoiceDesign");
    expect(error).not.toContain("does not support instruct");
    expect(error).not.toContain("cannot be used with the active speech endpoint");
  });

  it("reports a shape mismatch when the endpoint takes only design bodies and the persona has only a sample", async () => {
    const { source, error } = await runTool(SAMPLE, makeEndpoint("voice-design"));

    expect(source).toBeNull();
    expect(error).toContain("cannot be used with the active speech endpoint");
  });

  it("reports a shape mismatch rather than a missing voice when the persona has a sample only", async () => {
    const { source, error } = await runTool(SAMPLE, ELEVENLABS_ENDPOINT);

    expect(source).toBeNull();
    expect(error).toContain("cannot be used with the active speech endpoint");
  });

  it("reports a shape mismatch when no endpoint is registered and the persona has only a sample", async () => {
    const { source, error } = await runTool(SAMPLE, null);

    expect(source).toBeNull();
    expect(error).toContain("cannot be used with the active speech endpoint");
  });
});
