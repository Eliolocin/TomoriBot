/**
 * Which `/synthesize` request shapes the active speech endpoint accepts.
 *
 * Kept as its own leaf module because both the modal's source table and the synthesis dispatcher
 * need this answer, and the dispatcher must not depend on the modal layer (which pulls in the
 * Discord interaction core) just to learn what an endpoint can take. One table, two consumers, no
 * chance of the two disagreeing about what `auto` accepts.
 */

import type { CustomEndpointRow } from "@/types/db/schema";

export interface VoiceSourceCapabilities {
  /** Endpoint accepts clone-shaped bodies (`ref_audio` + `ref_text`). */
  acceptsCloneShape: boolean;
  /** Endpoint accepts design-shaped bodies (`instruct`). */
  acceptsDesignShape: boolean;
  /** Clone-shaped bodies may carry a one-off delivery instruction in `instruct`. */
  cloneInstructionsAvailable: boolean;
}

function getVoiceMode(endpoint: CustomEndpointRow | null | undefined): "clone" | "voice-design" | "auto" {
  const rawMode = endpoint?.extra_config.voice_mode;
  return rawMode === "voice-design" || rawMode === "auto" ? rawMode : "clone";
}

/**
 * Resolves the endpoint's accepted request shapes.
 *
 * `auto` accepts both: one URL that reads `ref_audio`/`ref_text` for clone bodies and `instruct`
 * for design bodies. ElevenLabs accepts neither, which is why its user-supplied options are
 * ignored rather than rejected.
 */
export function resolveVoiceSourceCapabilities(
  endpoint: CustomEndpointRow | null | undefined,
): VoiceSourceCapabilities {
  if (endpoint?.api_style !== "tts-clone") {
    return { acceptsCloneShape: false, acceptsDesignShape: false, cloneInstructionsAvailable: false };
  }

  const mode = getVoiceMode(endpoint);
  const acceptsCloneShape = mode === "clone" || mode === "auto";
  const acceptsDesignShape = mode === "voice-design" || mode === "auto";
  return {
    acceptsCloneShape,
    acceptsDesignShape,
    cloneInstructionsAvailable: acceptsCloneShape && endpoint.extra_config.supports_instruct === true,
  };
}
