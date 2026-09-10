/**
 * Voice-source resolution for `/generate voice-message`.
 *
 * Pure and I/O-free on purpose: it owns the "which voice can this invocation use" table and the
 * radio description formatting, both of which are easy to get subtly wrong and cheap to pin in
 * tests. User-facing labels stay with the caller so this module never needs a locale.
 */

import type { CustomEndpointRow } from "@/types/db/schema";
import { safeSelectOptionText } from "@/utils/discord/ui/interactionCore";
import { resolveVoiceSourceCapabilities } from "@/utils/speech/voiceSourceCapabilities";

export {
  resolveVoiceSourceCapabilities,
  type VoiceSourceCapabilities,
} from "@/utils/speech/voiceSourceCapabilities";

/** Identity of a voice source as it appears in the modal radio and the success embed. */
export type VoiceSourceId = "upload" | "typed-design" | "persona-sample" | "persona-design" | "elevenlabs";

/** Request shape the source produces. */
export type VoiceSourceShape = "clone" | "design" | "elevenlabs";

/** Longest option label or description Discord accepts, per field. */
export const VOICE_SOURCE_OPTION_TEXT_LIMIT = 100;

export interface VoiceSourceCandidate {
  id: VoiceSourceId;
  shape: VoiceSourceShape;
  /** Reference sample row, present for `persona-sample`. */
  sampleId?: number;
  /** Design prompt text, present for `persona-design` and `typed-design`. */
  designPrompt?: string;
  /**
   * What the source points at, for the option description: the upload's filename or the assigned
   * sample's name. Absent for design sources, which describe themselves with the prompt.
   */
  displayText?: string;
}

/** The persona fields this module reads. Narrowed so tests can pass plain objects. */
export interface VoiceSourcePersona {
  speech_voice_sample_id?: number | null;
  speech_voice_design_prompt?: string | null;
  speech_voice_id?: string | null;
}

export interface VoiceSourceResolutionInput {
  endpoint: CustomEndpointRow | null | undefined;
  persona: VoiceSourcePersona;
  /** Display name of the persona's assigned sample, shown in the radio option. */
  personaSampleName?: string | null;
  /** Filename of the uploaded clip, when the invoker passed one. */
  uploadFilename?: string | null;
  /** Design prompt typed on the command line, when the invoker passed one. */
  typedDesignPrompt?: string | null;
}

/**
 * Formats an option description as `<modePrefix> | <text>`, truncating `text` to fit.
 *
 * Budgeting the prefix explicitly matters because `safeSelectOptionText` truncates silently, so an
 * over-long design prompt loses its tail with no error anywhere.
 */
export function formatVoiceSourceOptionDescription(modePrefix: string, text: string): string {
  const fullPrefix = `${modePrefix} | `;
  return `${fullPrefix}${safeSelectOptionText(text, VOICE_SOURCE_OPTION_TEXT_LIMIT - fullPrefix.length)}`;
}

/**
 * Enumerates the voice sources this invocation can use, in pre-selection order.
 *
 * User intent expressed on this invocation outranks stored persona configuration, and between the
 * two user-supplied sources the uploaded clip wins because clone output is the more deterministic
 * of the two.
 */
export function resolveVoiceSourceCandidates(input: VoiceSourceResolutionInput): VoiceSourceCandidate[] {
  const { endpoint, persona } = input;
  const { acceptsCloneShape, acceptsDesignShape } = resolveVoiceSourceCapabilities(endpoint);
  const candidates: VoiceSourceCandidate[] = [];

  const uploadFilename = input.uploadFilename?.trim() ?? "";
  if (uploadFilename && acceptsCloneShape) {
    candidates.push({ id: "upload", shape: "clone", displayText: uploadFilename });
  }

  const typedDesignPrompt = input.typedDesignPrompt?.trim() ?? "";
  if (typedDesignPrompt && acceptsDesignShape) {
    candidates.push({ id: "typed-design", shape: "design", designPrompt: typedDesignPrompt });
  }

  const personaSampleId = persona.speech_voice_sample_id ?? null;
  if (personaSampleId && acceptsCloneShape) {
    candidates.push({
      id: "persona-sample",
      shape: "clone",
      sampleId: personaSampleId,
      displayText: input.personaSampleName?.trim() || undefined,
    });
  }

  const personaDesignPrompt = persona.speech_voice_design_prompt?.trim() ?? "";
  if (personaDesignPrompt && acceptsDesignShape) {
    candidates.push({ id: "persona-design", shape: "design", designPrompt: personaDesignPrompt });
  }

  // ElevenLabs is the degenerate case: it accepts neither shape, so the stored voice id is the
  // whole candidate list. It is only reachable when the persona actually has one.
  const elevenLabsVoiceId = persona.speech_voice_id?.trim() ?? "";
  if (elevenLabsVoiceId && candidates.length === 0) {
    candidates.push({ id: "elevenlabs", shape: "elevenlabs" });
  }

  return candidates;
}

/** The source the modal pre-selects: the first candidate in pre-selection order. */
export function selectDefaultVoiceSource(candidates: readonly VoiceSourceCandidate[]): VoiceSourceCandidate | null {
  return candidates[0] ?? null;
}
