import type { CustomEndpointApiStyle, CustomEndpointRow } from "@/types/db/schema";

export const SPEECH_VOICE_MODES = ["clone", "voice-design", "auto"] as const;
export const SPEECH_SCRIPT_MARKUPS = ["plain", "bracket-tags", "emoji"] as const;

type SpeechVoiceMode = (typeof SPEECH_VOICE_MODES)[number];
type SpeechScriptMarkup = (typeof SPEECH_SCRIPT_MARKUPS)[number];

export interface SpeechEndpointSettings {
  voiceMode: SpeechVoiceMode;
  scriptMarkup: SpeechScriptMarkup;
  supportsInstruct: boolean;
}

/**
 * ElevenLabs renders bracket tags as delivery direction, while a local clone server would speak them
 * aloud. Only `tts-clone` servers implement the clone/VoiceDesign/Auto split.
 */
function defaultsForApiStyle(apiStyle: CustomEndpointApiStyle): SpeechEndpointSettings {
  return apiStyle === "tts-clone"
    ? { voiceMode: "clone", scriptMarkup: "plain", supportsInstruct: false }
    : { voiceMode: "clone", scriptMarkup: "bracket-tags", supportsInstruct: false };
}

export function getDefaultSpeechEndpointSettings(apiStyle: CustomEndpointApiStyle): SpeechEndpointSettings {
  return { ...defaultsForApiStyle(apiStyle) };
}

function readVoiceMode(value: unknown, fallback: SpeechVoiceMode): SpeechVoiceMode {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SPEECH_VOICE_MODES.find((mode) => mode === candidate) ?? fallback;
}

function readScriptMarkup(value: unknown, fallback: SpeechScriptMarkup): SpeechScriptMarkup {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SPEECH_SCRIPT_MARKUPS.find((markup) => markup === candidate) ?? fallback;
}

export function readSpeechEndpointSettings(
  endpoint: Pick<CustomEndpointRow, "api_style" | "extra_config">,
): SpeechEndpointSettings {
  const defaults = defaultsForApiStyle(endpoint.api_style);
  const extraConfig = endpoint.extra_config as Record<string, unknown>;
  const voiceMode = readVoiceMode(extraConfig.voice_mode, defaults.voiceMode);

  return {
    voiceMode,
    scriptMarkup: readScriptMarkup(extraConfig.script_markup, defaults.scriptMarkup),
    supportsInstruct: deriveSupportsInstruct(voiceMode, extraConfig.supports_instruct === true),
  };
}

/**
 * VoiceDesign and Auto both send the persona's voice prompt as an instruct field, so they imply
 * instruct support. The explicit flag only decides the question for a plain clone server.
 */
function deriveSupportsInstruct(voiceMode: SpeechVoiceMode, explicitlySelected: boolean): boolean {
  return voiceMode === "voice-design" || voiceMode === "auto" || explicitlySelected;
}

export function speechEndpointSettingsFromSubmittedValues(
  apiStyle: CustomEndpointApiStyle,
  submittedVoiceMode: string | undefined,
  submittedScriptMarkup: string | undefined,
  submittedInstructValues: string[] | undefined,
): SpeechEndpointSettings {
  const defaults = defaultsForApiStyle(apiStyle);
  const voiceMode =
    apiStyle === "tts-clone" ? readVoiceMode(submittedVoiceMode, defaults.voiceMode) : defaults.voiceMode;

  return {
    voiceMode,
    scriptMarkup: readScriptMarkup(submittedScriptMarkup, defaults.scriptMarkup),
    supportsInstruct: deriveSupportsInstruct(
      voiceMode,
      submittedInstructValues?.includes("supports-instruct") ?? false,
    ),
  };
}
