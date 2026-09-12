/**
 * Discord rejects a modal with more than five components at the interaction-response layer, so
 * the builder's own assertion is the only thing standing between a sixth field and a runtime
 * failure. These tests pin the worst case at exactly five and, more importantly, pin the fields
 * that must be *absent*: a control that renders where it does nothing teaches the user it is
 * broken, which is why the Expressiveness radio is gated on the Chatterbox label sniff.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { CustomEndpointRow } from "@/types/db/schema";
import { initializeLocalizer } from "@/utils/text/localizer";
import {
  buildVoiceMessageModalComponents,
  VOICE_MESSAGE_DIRECTION_INPUT_ID,
  VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID,
  VOICE_MESSAGE_MODAL_COMPONENT_LIMIT,
  VOICE_MESSAGE_SCRIPT_INPUT_ID,
  VOICE_MESSAGE_SOURCE_INPUT_ID,
  VOICE_MESSAGE_TRANSCRIPT_INPUT_ID,
  type VoiceMessageModalInput,
} from "@/utils/speech/voiceMessageModal";
import {
  resolveVoiceSourceCapabilities,
  resolveVoiceSourceCandidates,
  selectDefaultVoiceSource,
} from "@/utils/speech/voiceSourceResolution";

type VoiceMode = "clone" | "voice-design" | "auto";

function makeEndpoint(options: {
  apiStyle?: CustomEndpointRow["api_style"];
  voiceMode?: VoiceMode;
  label?: string;
  modelName?: string;
  endpointUrl?: string;
  scriptMarkup?: string;
  supportsInstruct?: boolean;
}): CustomEndpointRow {
  return {
    label: options.label ?? "Speech",
    model_name: options.modelName ?? null,
    api_style: options.apiStyle ?? "tts-clone",
    endpoint_url: options.endpointUrl ?? "https://speech.example.test",
    extra_config: {
      ...(options.voiceMode ? { voice_mode: options.voiceMode } : {}),
      ...(options.scriptMarkup ? { script_markup: options.scriptMarkup } : {}),
      ...(options.supportsInstruct !== undefined ? { supports_instruct: options.supportsInstruct } : {}),
    },
  } as unknown as CustomEndpointRow;
}

const CHATTERBOX_AUTO = makeEndpoint({
  voiceMode: "auto",
  label: "Chatterbox Turbo",
  endpointUrl: "https://chatterbox.example.test",
});

const NON_CHATTERBOX_CLONE = makeEndpoint({
  voiceMode: "clone",
  label: "Qwen3-TTS",
  modelName: "qwen3-tts",
  endpointUrl: "https://qwen.example.test",
});

const COSYVOICE3_INSTRUCTION_CLONE = makeEndpoint({
  voiceMode: "clone",
  label: "CosyVoice 3",
  supportsInstruct: true,
});

const VOICE_DESIGN_ONLY = makeEndpoint({ voiceMode: "voice-design", label: "Qwen3 VoiceDesign" });

const PERSONA_WITH_BOTH = {
  speech_voice_sample_id: 12,
  speech_voice_design_prompt: "Warm, wholesome and very dark-toned",
};

/** Mirrors the command's own input assembly, so the builder is tested against real candidates. */
function buildInput(options: {
  endpoint: CustomEndpointRow;
  persona: { speech_voice_sample_id?: number | null; speech_voice_design_prompt?: string | null };
  uploadFilename?: string | null;
  typedDesignPrompt?: string | null;
  expressiveness: VoiceMessageModalInput["expressiveness"];
  locale?: string;
}): VoiceMessageModalInput {
  const candidates = resolveVoiceSourceCandidates({
    endpoint: options.endpoint,
    persona: options.persona,
    personaSampleName: "millie.wav",
    uploadFilename: options.uploadFilename ?? null,
    typedDesignPrompt: options.typedDesignPrompt ?? null,
  });
  const capabilities = resolveVoiceSourceCapabilities(options.endpoint);
  const defaultSource = selectDefaultVoiceSource(candidates);

  return {
    locale: options.locale ?? "en-US",
    candidates,
    scriptMarkup: options.endpoint.extra_config.script_markup as string | undefined,
    designShapeAvailable:
      candidates.some((candidate) => candidate.shape === "design") || capabilities.acceptsDesignShape,
    cloneInstructionsAvailable: capabilities.cloneInstructionsAvailable,
    uploadShapeSelected: defaultSource?.id === "upload",
    expressiveness: options.expressiveness,
    chatterboxDefaults: { cfgWeight: 0.5, exaggeration: 0.5 },
  };
}

function componentIds(input: VoiceMessageModalInput): string[] {
  return buildVoiceMessageModalComponents(input).map((component) => component.customId);
}

// The component list itself does not depend on locale data, but the radio descriptions and the
// `Clone | ` / `Design | ` prefixes asserted below do.
beforeAll(async () => {
  await initializeLocalizer();
});

describe("buildVoiceMessageModalComponents", () => {
  it("builds exactly five components in the worst case", () => {
    // Chatterbox `auto` with an upload, a typed design prompt, and a persona holding both a
    // sample and a design prompt. Nothing may be added to this list without cutting another.
    const components = buildVoiceMessageModalComponents(
      buildInput({
        endpoint: CHATTERBOX_AUTO,
        persona: PERSONA_WITH_BOTH,
        uploadFilename: "mesu.wav",
        typedDesignPrompt: "Very happy and kind, slight rasp, mid-twenties, speaks quickly",
        expressiveness: "chatterbox",
      }),
    );

    expect(components.length).toBe(5);
    expect(components.length).toBe(VOICE_MESSAGE_MODAL_COMPONENT_LIMIT);
    expect(components.map((component) => component.customId)).toEqual([
      VOICE_MESSAGE_SCRIPT_INPUT_ID,
      VOICE_MESSAGE_SOURCE_INPUT_ID,
      VOICE_MESSAGE_DIRECTION_INPUT_ID,
      VOICE_MESSAGE_TRANSCRIPT_INPUT_ID,
      VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID,
    ]);
  });

  it("renders a single-field modal when only one source exists", () => {
    const components = buildVoiceMessageModalComponents(
      buildInput({
        endpoint: NON_CHATTERBOX_CLONE,
        persona: { speech_voice_sample_id: 12 },
        expressiveness: null,
      }),
    );

    // A radio group needs at least two options, so the one-source case renders no control at all.
    expect(components.map((component) => component.customId)).toEqual([VOICE_MESSAGE_SCRIPT_INPUT_ID]);
  });

  it("omits the expressiveness field on a non-Chatterbox clone endpoint", () => {
    // Two clone sources, so the Voice Source radio does render: the point is that the delivery
    // knob beside it does not, because a Qwen3-TTS or F5-TTS server ignores the chatterbox block.
    const input = buildInput({
      endpoint: NON_CHATTERBOX_CLONE,
      persona: { speech_voice_sample_id: 12 },
      uploadFilename: "mesu.wav",
      expressiveness: null,
    });

    const ids = componentIds(input);
    expect(ids).not.toContain(VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID);
    expect(ids).toContain(VOICE_MESSAGE_SOURCE_INPUT_ID);
    expect(ids).toContain(VOICE_MESSAGE_TRANSCRIPT_INPUT_ID);
  });

  it("omits the expressiveness field on a voice-design endpoint", () => {
    const input = buildInput({
      endpoint: VOICE_DESIGN_ONLY,
      persona: { speech_voice_design_prompt: "Warm and unhurried" },
      expressiveness: null,
    });

    const ids = componentIds(input);
    expect(ids).not.toContain(VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID);
    expect(ids).toContain(VOICE_MESSAGE_DIRECTION_INPUT_ID);
  });

  it("omits the expressiveness field when the resolved source is design-shaped", () => {
    // An `auto` endpoint can carry a Chatterbox label while the user picks a design source, which
    // takes the design adapter and never reads the chatterbox block.
    const input = buildInput({
      endpoint: CHATTERBOX_AUTO,
      persona: PERSONA_WITH_BOTH,
      typedDesignPrompt: "Very happy and kind",
      expressiveness: null,
    });

    expect(
      selectDefaultVoiceSource(
        resolveVoiceSourceCandidates({
          endpoint: CHATTERBOX_AUTO,
          persona: PERSONA_WITH_BOTH,
          typedDesignPrompt: "Very happy and kind",
        }),
      )?.shape,
    ).toBe("design");

    const ids = componentIds(input);
    expect(ids).not.toContain(VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID);
    expect(ids).not.toContain(VOICE_MESSAGE_TRANSCRIPT_INPUT_ID);
  });

  it("omits the reference transcript when the default source is not an upload", () => {
    const input = buildInput({
      endpoint: CHATTERBOX_AUTO,
      persona: { speech_voice_sample_id: 12 },
      expressiveness: "chatterbox",
    });

    expect(componentIds(input)).not.toContain(VOICE_MESSAGE_TRANSCRIPT_INPUT_ID);
  });

  it("renders no delivery direction when no design-shaped source is available", () => {
    const input = buildInput({
      endpoint: NON_CHATTERBOX_CLONE,
      persona: { speech_voice_sample_id: 12 },
      expressiveness: null,
    });

    expect(componentIds(input)).not.toContain(VOICE_MESSAGE_DIRECTION_INPUT_ID);
  });

  it("renders delivery direction for an instruction-capable clone endpoint", () => {
    const input = buildInput({
      endpoint: COSYVOICE3_INSTRUCTION_CLONE,
      persona: { speech_voice_sample_id: 12 },
      expressiveness: null,
    });

    expect(componentIds(input)).toContain(VOICE_MESSAGE_DIRECTION_INPUT_ID);
  });
});

describe("buildVoiceMessageModalComponents radio options", () => {
  it("pre-selects the uploaded clip and labels every option with its request shape", () => {
    const input = buildInput({
      endpoint: CHATTERBOX_AUTO,
      persona: PERSONA_WITH_BOTH,
      uploadFilename: "mesu.wav",
      typedDesignPrompt: "Very happy and kind",
      expressiveness: "chatterbox",
    });

    const sourceField = buildVoiceMessageModalComponents(input).find(
      (component) => component.customId === VOICE_MESSAGE_SOURCE_INPUT_ID,
    );
    if (sourceField?.kind !== "radioGroup") throw new Error("expected a radio group");

    expect(sourceField.options.map((option) => option.value)).toEqual([
      "upload",
      "typed-design",
      "persona-sample",
      "persona-design",
    ]);
    expect(sourceField.options.map((option) => option.default)).toEqual([true, false, false, false]);
    expect(sourceField.options[0]?.description).toBe("Clone | mesu.wav");
    expect(sourceField.options[2]?.description).toBe("Clone | millie.wav");
    expect(sourceField.options[1]?.description?.startsWith("Design | ")).toBe(true);
  });

  it("pre-selects the Chatterbox server default so ignoring the field reproduces today's behavior", () => {
    const input = buildInput({
      endpoint: CHATTERBOX_AUTO,
      persona: { speech_voice_sample_id: 12 },
      expressiveness: "chatterbox",
    });

    const field = buildVoiceMessageModalComponents(input).find(
      (component) => component.customId === VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID,
    );
    if (field?.kind !== "radioGroup") throw new Error("expected a radio group");

    expect(field.options.map((option) => option.value)).toEqual([
      "subtle",
      "server-default",
      "expressive",
      "very-expressive",
    ]);
    expect(field.options.find((option) => option.default)?.value).toBe("server-default");
  });

  it("renames the field to Voice Stability on ElevenLabs", () => {
    const elevenLabsInput: VoiceMessageModalInput = {
      locale: "en-US",
      candidates: [{ id: "elevenlabs", shape: "elevenlabs" }],
      scriptMarkup: undefined,
      designShapeAvailable: false,
      cloneInstructionsAvailable: false,
      uploadShapeSelected: false,
      expressiveness: "elevenlabs",
      chatterboxDefaults: { cfgWeight: 0.5, exaggeration: 0.5 },
    };

    const field = buildVoiceMessageModalComponents(elevenLabsInput).find(
      (component) => component.customId === VOICE_MESSAGE_EXPRESSIVENESS_INPUT_ID,
    );
    if (field?.kind !== "radioGroup") throw new Error("expected a radio group");

    expect(field.labelKey).toBe("commands.generate.voice-message.modal.stability_label");
    expect(field.options.map((option) => option.value)).toEqual(["stable", "natural", "creative"]);
    expect(field.options.find((option) => option.default)?.value).toBe("natural");
  });
});
