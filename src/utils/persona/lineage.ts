import type { TomoriState } from "@/types/db/schema";

/**
 * Chooses the persona that represents a lineage in labels and thumbnails.
 *
 * A non-alter member wins because it is the identity the lineage is named after. Keeping this
 * choice shared prevents a selector label and its thumbnail from describing different personas.
 */
export function personaRepresentativeForLineage(
  personas: readonly TomoriState[],
  lineageId: number,
): TomoriState | null {
  const sharing = personas.filter((persona) => persona.persona_lineage_id === lineageId);
  return sharing.find((persona) => !persona.is_alter) ?? sharing[0] ?? null;
}
