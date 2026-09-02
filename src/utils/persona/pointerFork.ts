import type { TomoriState } from "@/types/db/schema";
import { personaRepository } from "@/utils/db/repositories";

/**
 * Materializes a preset-pointer persona before its first per-server asset write.
 *
 * A pointer persona shares its preset's stored assets, so writing an avatar or sprite through one
 * would mutate every server pointing at that preset. Forking first is what keeps preset storage
 * immutable.
 */
export async function forkPointerForAvatarChange(
  selectedPersona: Pick<TomoriState, "persona_id" | "is_pointer">,
): Promise<boolean> {
  if (!selectedPersona.persona_id) {
    return false;
  }

  if (selectedPersona.is_pointer !== true) {
    return true;
  }

  return await personaRepository.materializeIfPointer(selectedPersona.persona_id);
}
