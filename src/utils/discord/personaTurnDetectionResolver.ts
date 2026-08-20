import type { Message } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import { findLastActivePersona } from "@/utils/discord/personaTurnDetection";

export interface FallbackPersonaResolutionOptions {
  /** Personas the actor may currently trigger, already filtered by whitelist and personal spotlight. */
  availablePersonas: TomoriState[];
  /** Every persona in the workspace, needed to attribute a turn that the actor may no longer trigger. */
  allPersonas: TomoriState[];
  tomoriState: TomoriState;
  /** Thread parent when the command ran in a thread, otherwise the channel itself. */
  effectiveChannelId: string;
  personalAutoTriggerPersonaId?: number | null;
  clientUserId?: string;
  /**
   * Invoked only when more than one persona is eligible. Reading recent history costs a Discord
   * REST call, and with a single eligible persona all three tiers resolve to it anyway.
   */
  fetchRecentMessages: () => Promise<Message[]>;
}

export function getChannelAutoTriggerPersona(
  personas: TomoriState[],
  effectiveChannelId: string,
  tomoriState: TomoriState,
  personalAutoTriggerPersonaId?: number | null,
): TomoriState | null {
  const resolveById = (personaId: number | null | undefined): TomoriState | null => {
    if (personaId === null || personaId === undefined) return null;
    return personas.find((persona) => persona.persona_id === personaId) ?? null;
  };

  const personalAutoTriggerPersona = resolveById(personalAutoTriggerPersonaId);
  if (personalAutoTriggerPersona) {
    return personalAutoTriggerPersona;
  }

  if (!tomoriState.config.autoch_disc_ids.includes(effectiveChannelId)) {
    return null;
  }

  const serverAutoTriggerPersonaId =
    tomoriState.config.autoch_persona_overrides.find((entry) => entry.channel_disc_id === effectiveChannelId)
      ?.persona_id ?? null;

  return serverAutoTriggerPersonaId === null
    ? (personas.find((persona) => !persona.is_alter) ?? null)
    : resolveById(serverAutoTriggerPersonaId);
}

/**
 * Resolves which persona an unqualified command should act as, in the order most recent speaker,
 * then the channel's auto-trigger persona, then the main persona. A last speaker the actor may not
 * currently trigger falls through rather than being returned, so eligibility is never widened here.
 */
export async function resolveFallbackPersona(options: FallbackPersonaResolutionOptions): Promise<TomoriState | null> {
  const {
    availablePersonas,
    allPersonas,
    tomoriState,
    effectiveChannelId,
    personalAutoTriggerPersonaId,
    clientUserId,
    fetchRecentMessages,
  } = options;

  if (availablePersonas.length === 0) {
    return null;
  }

  if (availablePersonas.length === 1) {
    return availablePersonas[0];
  }

  const defaultPersona = availablePersonas.find((persona) => !persona.is_alter) ?? availablePersonas[0];
  const autoTriggerPersona = getChannelAutoTriggerPersona(
    availablePersonas,
    effectiveChannelId,
    tomoriState,
    personalAutoTriggerPersonaId,
  );

  const messages = await fetchRecentMessages();
  const availablePersonaIds = new Set(availablePersonas.map((persona) => persona.persona_id));
  const lastActivePersona = findLastActivePersona({ messages, allPersonas, clientUserId });
  const allowedLastActivePersona =
    lastActivePersona && availablePersonaIds.has(lastActivePersona.persona_id) ? lastActivePersona : null;

  return allowedLastActivePersona ?? autoTriggerPersona ?? defaultPersona;
}
