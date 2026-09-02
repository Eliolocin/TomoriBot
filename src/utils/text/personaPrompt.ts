import type { TomoriState } from "@/types/db/schema";

export const LEGACY_PERSONA_DESCRIPTION_PREFIX = "{bot}'s Description: ";

export function resolvePrefillPrompt(persona: TomoriState): string | null {
  if (persona.persona_prompt?.trim()) {
    return persona.persona_prompt.trim();
  }

  const legacyDescription = persona.attribute_list.find((attribute) =>
    attribute.startsWith(LEGACY_PERSONA_DESCRIPTION_PREFIX),
  );
  if (!legacyDescription) {
    return null;
  }

  const extractedDescription = legacyDescription.slice(LEGACY_PERSONA_DESCRIPTION_PREFIX.length).trim();
  return extractedDescription.length > 0 ? extractedDescription : null;
}
